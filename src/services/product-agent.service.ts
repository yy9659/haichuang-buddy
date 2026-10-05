/**
 * Product Agent 业务闭环服务（S2-2）
 *
 * 这是「商品理解」从**能被调用**变成**能被使用**的那一层：
 * 用户在商品详情页点「AI 分析商品」→ 本文件跑完整条链路 → 页面展示 Product DNA。
 *
 * 完整流程（每一步都可失败、都可观测，全程返回 Result）：
 *
 *   1. 校验 productId         → 非法直接 VALIDATION_FAILED，不触达任何 IO
 *   2. 读取商品               → 不存在返回 NOT_FOUND
 *   3. 并发保护 + 检查图片     → 同一商品已有运行中的任务则拒绝；无图降级为纯文本并记 warning
 *   4. 创建 agent_task        → status=running，记录本次调用的 input 快照
 *   5. 商品状态 pending→analyzing
 *   6. 调用 Product Agent     → 视觉理解（可选）+ 结构化生成 + Zod 校验 + 纠错重试
 *   7. 保存 product_dna       → 已有则 update（覆盖），没有则 create
 *   8. 状态收口               → analyzed / failed；任务写 output / duration / errorMessage
 *
 * 三条设计纪律：
 * - **Service 不直连数据库**，一律经 Repository；也不直连模型，一律经 Agent / Provider。
 * - **不静默降级**：模型失败就是 failed，商品状态如实标记为 failed 并保留失败原因，
 *   绝不写一份「看起来像成功」的空 DNA。
 * - **不伪造结果**：DNA 一律 `approved: false`，必须由商家确认后才能对外使用
 *   （技术文档 5.4「人拥有最终决策权」）。
 */

import { runProductAgent, toProductAgentInput } from "@/ai";
import { getAIProviderStatus, type AIProviderStatus } from "@/ai/provider";
import type { AIProvider } from "@/ai/provider/types";
import { formatDurationMs } from "@/lib/datetime";
import { attempt, fail, ok, toAppError, type Result } from "@/lib/result";
import {
  getRepositories,
  type AgentTaskRecord,
  type NewProductDnaInput,
  type Repositories,
  type UpdateAgentTaskInput,
} from "@/repositories";
import { parseProductId } from "@/schemas/product";
import { isInlineProductImageUrl } from "@/storage";
import type { AgentId, AgentStatus, Product, ProductDNA } from "@/types";

/**
 * 写入 `agent_tasks.agent_type` 的取值。
 * 注意它与 `PRODUCT_AGENT_ID`（"product-agent"）不是同一个字符串 ——
 * 前者是数据库枚举值，后者是 Agent 的运行时标识，这里显式转换避免写错。
 */
export const PRODUCT_AGENT_TYPE: AgentId = "product_agent";

/**
 * 「运行中」的过期阈值：超过这个时长仍未收口的任务，
 * 视为进程被中断（部署、重启、崩溃）留下的孤儿任务，允许重新发起分析。
 * 没有这个兜底，一次中断就会把商品永久卡在「分析中」。
 */
export const ANALYZING_STALE_MS = 2 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* 视图类型                                                            */
/* ------------------------------------------------------------------ */

/** 最近一次分析任务（详情页「分析记录」区块用） */
export interface ProductAnalysisTaskView {
  id: string;
  status: AgentStatus;
  title: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  /** 失败原因（面向用户的中文文案） */
  errorMessage: string | null;
  /** 以下字段来自该次任务的 output 快照，历史任务缺字段时给出保守默认值 */
  providerId: string | null;
  /** 该次分析是否用的是 Mock 占位数据 */
  isMock: boolean;
  visionUsed: boolean;
  attempts: number;
  repaired: boolean;
  warnings: string[];
}

/** 详情页所需的分析上下文（与 DNA 本体分开，避免把「当前事实」和「历史记录」混在一起） */
export interface ProductAnalysisState {
  latestTask: ProductAnalysisTaskView | null;
  /** 当前模型通道状态，用于在界面上如实标注「Mock 占位 / 通义千问」 */
  provider: AIProviderStatus;
}

/** 一次分析的结果 */
export interface ProductAnalysisResult {
  productId: string;
  /** 本次分析对应的 agent_task id，可用于排查 */
  taskId: string;
  dna: ProductDNA;
  providerId: string;
  /** 是否为 Mock 占位数据（界面据此给出提示） */
  isMock: boolean;
  visionUsed: boolean;
  attempts: number;
  repaired: boolean;
  durationMs: number;
  durationText: string;
  /** 是否为「覆盖已有 DNA」的重新分析 */
  reanalyzed: boolean;
  warnings: string[];
}

export interface AnalyzeProductOptions {
  /** 注入 Provider（测试用）；默认按 AI_PROVIDER 环境变量解析 */
  provider?: AIProvider;
  /** 强制跳过图像理解 */
  skipVision?: boolean;
  /**
   * 触发本次分析的工作流 id（S4-1 编排层注入）。
   * 用户单点触发的分析留空 —— 任务记录上的 `workflowId` 正是用来区分这两种来源的。
   */
  workflowId?: string | null;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/** 从任意值里安全取出字符串 */
function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readBoolean(source: Record<string, unknown> | null, key: string): boolean {
  return source?.[key] === true;
}

function readNumber(source: Record<string, unknown> | null, key: string): number {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readStringList(source: Record<string, unknown> | null, key: string): string[] {
  const value = source?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

/** 领域 ProductDNA → 仓储写入入参（字段名在此处对齐数据库列） */
function toDnaInput(dna: ProductDNA): NewProductDnaInput {
  return {
    productId: dna.productId,
    category: dna.category,
    subCategory: dna.subCategory,
    visualFeatures: [...dna.visualFeatures],
    coreFeatures: [...dna.coreFeatures],
    sellingPoints: [...dna.sellingPoints],
    targetUsers: [...dna.targetUsers],
    consumptionScenarios: [...dna.consumptionScenarios],
    userPainPoints: [...dna.userPainPoints],
    marketingAngles: [...dna.marketingAngles],
    riskNotes: [...dna.riskNotes],
    aiVersion: dna.aiVersion,
    confidence: dna.confidence,
    approved: dna.approved,
  };
}

/** 领域记录 → 界面视图 */
function toTaskView(record: AgentTaskRecord): ProductAnalysisTaskView {
  return {
    id: record.id,
    status: record.status,
    title: record.title,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    errorMessage: record.errorMessage,
    providerId: readString(record.output, "providerId"),
    isMock: readBoolean(record.output, "isMock"),
    visionUsed: readBoolean(record.output, "visionUsed"),
    attempts: readNumber(record.output, "attempts"),
    repaired: readBoolean(record.output, "repaired"),
    warnings: readStringList(record.output, "warnings"),
  };
}

/** 运行中的任务是否已经过期（进程中断留下的孤儿） */
function isStaleRunningTask(record: AgentTaskRecord, now: Date): boolean {
  const startedAt = record.createdAt ? new Date(record.createdAt).getTime() : NaN;
  if (!Number.isFinite(startedAt)) {
    // 时间不可解析时不阻塞用户，按过期处理
    return true;
  }
  return now.getTime() - startedAt > ANALYZING_STALE_MS;
}

/**
 * 收口任务记录。
 * **刻意不把失败上抛**：分析结果已经确定，任务记录写不进去（数据库抖动）
 * 不应该把一次成功的分析改判为失败 —— 只记录日志，让人能从日志里发现。
 */
async function closeTask(
  repositories: Repositories,
  taskId: string,
  patch: UpdateAgentTaskInput,
): Promise<void> {
  const updated = await attempt(
    () => repositories.agentTasks.update(taskId, patch),
    (cause) => toAppError(cause, "DB_ERROR", "更新分析任务失败"),
  );
  if (!updated.ok) {
    console.warn(
      `[product-agent] 任务记录更新失败 taskId=${taskId}：${updated.error.message}`,
    );
  }
}

/**
 * 把商品状态改回 fail 态。失败不阻断 —— 任务记录里已经留有真实原因，
 * 商品状态卡在 analyzing 也只是展示层面的问题，下一次分析会被过期阈值放行。
 */
async function markProductStatus(
  repositories: Repositories,
  productId: string,
  status: "analyzing" | "analyzed" | "failed",
): Promise<Result<Product>> {
  return attempt(
    () => repositories.products.update(productId, { analysisStatus: status }),
    (cause) => toAppError(cause, "DB_ERROR", "更新商品分析状态失败"),
  );
}

/* ------------------------------------------------------------------ */
/* 读取：详情页所需的分析上下文                                        */
/* ------------------------------------------------------------------ */

/**
 * 读取某商品最近一次分析任务 + 当前模型通道状态。
 * 这两个查询互相独立，因此并发执行。
 */
export async function getProductAnalysisState(
  productId: string,
): Promise<Result<ProductAnalysisState>> {
  return attempt(
    async () => {
      const repositories = getRepositories();
      const latest = await repositories.agentTasks.findLatestByProduct(
        productId,
        PRODUCT_AGENT_TYPE,
      );
      return {
        latestTask: latest ? toTaskView(latest) : null,
        provider: getAIProviderStatus(),
      } satisfies ProductAnalysisState;
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载商品分析记录失败"),
  );
}

/* ------------------------------------------------------------------ */
/* 写入：完整分析流程                                                  */
/* ------------------------------------------------------------------ */

/**
 * 执行一次商品 AI 分析。
 *
 * @param productId 商品 id（来自表单 / URL，因此是 unknown 类型，必须先校验）
 */
export async function analyzeProduct(
  productId: unknown,
  options: AnalyzeProductOptions = {},
): Promise<Result<ProductAnalysisResult>> {
  // 1. 校验 ID
  const parsedId = parseProductId(productId);
  if (!parsedId.ok) {
    return parsedId;
  }
  const id = parsedId.data;

  const repositories = getRepositories();

  // 2. 读取商品
  const loaded = await attempt(
    () => repositories.products.getById(id),
    (cause) => toAppError(cause, "DB_ERROR", "加载商品失败"),
  );
  if (!loaded.ok) {
    return loaded;
  }
  const product = loaded.data;
  if (!product) {
    return fail("NOT_FOUND", "商品不存在或已被删除", `productId=${id}`);
  }

  // 3. 并发保护：同一商品不允许同时跑两次分析
  const latest = await attempt(
    () => repositories.agentTasks.findLatestByProduct(id, PRODUCT_AGENT_TYPE),
    (cause) => toAppError(cause, "DB_ERROR", "读取分析任务失败"),
  );
  if (!latest.ok) {
    return latest;
  }
  const runningTask = latest.data;
  if (
    runningTask &&
    runningTask.status === "running" &&
    !isStaleRunningTask(runningTask, new Date())
  ) {
    return fail(
      "RATE_LIMITED",
      "该商品正在分析中，请稍候再试",
      `任务 ${runningTask.id} 开始于 ${runningTask.createdAt}，仍在运行`,
    );
  }

  // 3'. 检查图片：没有图片不阻塞，但必须如实告知结论可信度会降低
  const imageUrl = product.imageUrl?.trim() ?? "";
  const hasImage = imageUrl.length > 0 && options.skipVision !== true;
  const warnings: string[] = [];
  if (!hasImage) {
    warnings.push(
      options.skipVision === true
        ? "本次分析按要求跳过了图像理解，仅基于文字资料，视觉特征的可信度较低。"
        : "该商品尚未上传图片，本次仅基于文字资料分析，视觉特征的可信度较低。建议上传商品图片后重新分析。",
    );
  }

  const providerStatus = getAIProviderStatus();
  const startedAt = Date.now();

  // 4. 创建任务（status=running，直接记录为进行中，避免多一次 queued→running 写操作）
  const createdTask = await attempt(
    () =>
      repositories.agentTasks.create({
        agentType: PRODUCT_AGENT_TYPE,
        title: `分析商品：${product.name}`,
        productId: id,
        workflowId: options.workflowId ?? null,
        status: "running",
        progress: 10,
        input: {
          productId: id,
          productName: product.name,
          hasImage,
          // 记录地址便于排查「模型到底看到了哪张图」；这里只是 URL，不含任何凭证
          // 内联图片可能有数 MB；任务日志只记引用类型，不重复保存整段 base64。
          imageUrl: hasImage
            ? isInlineProductImageUrl(imageUrl)
              ? "inline:products.image_url"
              : imageUrl
            : null,
          requestedProvider: providerStatus.providerId,
        },
      }),
    (cause) => toAppError(cause, "DB_ERROR", "创建分析任务失败"),
  );
  if (!createdTask.ok) {
    return createdTask;
  }
  const taskId = createdTask.data.id;

  // 5. 商品状态 → analyzing
  const analyzing = await markProductStatus(repositories, id, "analyzing");
  if (!analyzing.ok) {
    await closeTask(repositories, taskId, {
      status: "failed",
      errorMessage: analyzing.error.message,
      durationMs: Date.now() - startedAt,
    });
    return analyzing;
  }

  // 6. 调用 Product Agent（模型调用与结构化校验都在 Agent 内部完成）
  const run = await runProductAgent(toProductAgentInput(product), {
    ...(options.provider ? { provider: options.provider } : {}),
    skipVision: !hasImage,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const durationMs = Date.now() - startedAt;

  // 6'. 失败分支：如实标记 failed，并把失败原因写进任务记录
  if (!run.ok) {
    await closeTask(repositories, taskId, {
      status: "failed",
      durationMs,
      errorMessage: run.error.message,
    });
    await markProductStatus(repositories, id, "failed");
    return run;
  }

  const combinedWarnings = [...warnings, ...run.data.warnings];
  const dna = run.data.dna;

  // 7. 保存 Product DNA：已有则覆盖（重新分析），没有则新建
  const existingDna = await attempt(
    () => repositories.productDna.getByProductId(id),
    (cause) => toAppError(cause, "DB_ERROR", "读取已有 Product DNA 失败"),
  );
  if (!existingDna.ok) {
    await closeTask(repositories, taskId, {
      status: "failed",
      durationMs,
      errorMessage: existingDna.error.message,
      output: {
        providerId: run.data.providerId,
        isMock: providerStatus.isMock,
        visionUsed: run.data.visionUsed,
        attempts: run.data.attempts,
        repaired: run.data.repaired,
        warnings: combinedWarnings,
      },
    });
    await markProductStatus(repositories, id, "failed");
    return existingDna;
  }

  const reanalyzed = existingDna.data !== null;
  const dnaInput = toDnaInput(dna);

  const saved = await attempt(
    () =>
      reanalyzed
        ? repositories.productDna.update(id, dnaInput)
        : repositories.productDna.create(dnaInput),
    (cause) => toAppError(cause, "DB_ERROR", "保存 Product DNA 失败"),
  );
  if (!saved.ok) {
    // DNA 没落库就不算成功：绝不让商品停在「已生成 DNA」但实际没有 DNA 的状态
    await closeTask(repositories, taskId, {
      status: "failed",
      durationMs,
      errorMessage: saved.error.message,
      output: {
        providerId: run.data.providerId,
        isMock: providerStatus.isMock,
        visionUsed: run.data.visionUsed,
        attempts: run.data.attempts,
        repaired: run.data.repaired,
        warnings: combinedWarnings,
      },
    });
    await markProductStatus(repositories, id, "failed");
    return saved;
  }

  // 8. 商品状态 → analyzed
  const analyzed = await markProductStatus(repositories, id, "analyzed");
  if (!analyzed.ok) {
    // DNA 已经存好了，只是状态没更新 —— 提示而非改判失败
    combinedWarnings.push(
      `Product DNA 已保存，但商品状态更新失败：${analyzed.error.message}`,
    );
  }

  await closeTask(repositories, taskId, {
    status: "completed",
    progress: 100,
    durationMs,
    /**
     * output 是**该次运行的历史快照**，用于回溯与排查（比如改了提示词后对比新旧结论）。
     * 当前生效的事实仍以 product_dna 表为准，这里不做同步、也不被页面读取。
     */
    output: {
      dna,
      providerId: run.data.providerId,
      isMock: providerStatus.isMock,
      visionUsed: run.data.visionUsed,
      attempts: run.data.attempts,
      repaired: run.data.repaired,
      warnings: combinedWarnings,
    },
  });

  return ok({
    productId: id,
    taskId,
    dna: saved.data,
    providerId: run.data.providerId,
    isMock: providerStatus.isMock,
    visionUsed: run.data.visionUsed,
    attempts: run.data.attempts,
    repaired: run.data.repaired,
    durationMs,
    durationText: formatDurationMs(durationMs),
    reanalyzed,
    warnings: combinedWarnings,
  });
}
