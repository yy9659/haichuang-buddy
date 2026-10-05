/**
 * Brand Agent 业务闭环服务（S3-1）
 *
 * 这是「品牌智能」从**能被调用**变成**能被使用**的那一层：
 * 品牌中心点「AI 生成品牌」→ 本文件跑完整条链路 → 页面展示 Brand Profile。
 *
 * 完整流程（每一步都可失败、都可观测，全程返回 Result）：
 *
 *   1. 校验 productId         → 非法直接 VALIDATION_FAILED，不触达任何 IO
 *   2. 读取主依据商品          → 不存在返回 NOT_FOUND
 *   3. 汇总品牌依据            → 商家资料 + Owner Profile + 一组 Product DNA
 *   4. 依据前置检查            → 没有任何依据时直接拒绝，**不创建任务记录**
 *   5. 并发保护                → 已有运行中的品牌任务则拒绝（过期任务放行重跑）
 *   6. 创建 agent_task         → agentType=brand_agent，status=running，记录 input 快照
 *   7. 调用 Brand Agent        → 结构化生成 + Zod 校验 + 纠错重试 + 合规扫描
 *   8. 保存 brand_profiles     → 已有则 update（覆盖），没有则 create
 *   9. 状态收口                → 任务写 output / duration / errorMessage
 *
 * 四条设计纪律：
 * - **Service 不直连数据库**，一律经 Repository；也不直连模型，一律经 Agent / Provider。
 * - **不编造依据**：拿不到任何 Product DNA 与 Owner Profile 时明确拒绝（见第 4 步），
 *   而不是让模型凭「海产品商家」这个标签编一份听上去很美的品牌故事。
 * - **不静默降级**：模型失败就是 failed，任务如实记录失败原因，绝不写一份「看起来像成功」的空档案。
 * - **不伪造结果**：档案一律 `approved: false`，必须由商家确认后才能对外使用
 *   （技术文档 5.4「人拥有最终决策权」）。
 *
 * 与 Product Agent 服务的差异（刻意不同，不是遗漏）：
 * - Product DNA 挂在**商品**上，因此商品表有 `analysis_status` 列承载状态机；
 *   品牌档案挂在**商家**上，且「生成中」时档案行还不存在，
 *   因此生成状态**只能由 agent_tasks 派生**（见 `getBrandGenerationState`），
 *   不再给 brand_profiles 加一个"当前是否在生成"的列 —— 那是任务的状态，不是档案的状态。
 */

import { runBrandAgent, hasBrandGrounding } from "@/ai";
import type { BrandAgentInput, BrandAgentProductInput } from "@/ai";
import { getAIProviderStatus, type AIProviderStatus } from "@/ai/provider";
import type { AIProvider } from "@/ai/provider/types";
import { toNewBrandProfileInput } from "@/ai/schemas/brand-profile";
import { formatDurationMs } from "@/lib/datetime";
import { attempt, fail, ok, toAppError, type Result } from "@/lib/result";
import {
  getRepositories,
  type AgentTaskRecord,
  type NewBrandProfileInput,
  type Repositories,
  type UpdateAgentTaskInput,
} from "@/repositories";
import { parseProductId } from "@/schemas/product";
import type {
  AgentId,
  AgentStatus,
  BrandProfile,
  Product,
  ProductDNA,
} from "@/types";

/**
 * 写入 `agent_tasks.agent_type` 的取值。
 * 与 `BRAND_AGENT_ID`（"brand-agent"）不是同一个字符串：前者是数据库枚举值，
 * 后者是 Agent 的运行时标识，这里显式声明避免写错。
 */
export const BRAND_AGENT_TYPE: AgentId = "brand_agent";

/**
 * 「生成中」的过期阈值。品牌策略用 reasoning 档位，比商品分析慢，
 * 因此阈值给得更宽；超过则视为进程被中断（部署 / 重启 / 崩溃）留下的孤儿任务，
 * 允许重新发起生成 —— 否则一次中断会把品牌中心永久卡在「生成中」。
 */
export const BRAND_GENERATING_STALE_MS = 3 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* 视图类型                                                            */
/* ------------------------------------------------------------------ */

/** 最近一次品牌生成任务（品牌中心「生成记录」区块用） */
export interface BrandGenerationTaskView {
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
  /** 该次生成是否用的是 Mock 占位数据 */
  isMock: boolean;
  /** 参与推导的商品数 */
  sourceProductCount: number;
  /** 其中已完成 AI 分析（有 DNA）的商品数 */
  analyzedProductCount: number;
  attempts: number;
  repaired: boolean;
  warnings: string[];
  /** 本次生成的主依据商品名 */
  sourceProductName: string | null;
}

/**
 * 品牌生成状态（对应任务书 Task 6 要求的 empty / generating / completed / failed）。
 *
 * 注意「completed」的判定以**档案是否存在**为准，而不是以最后一次任务是否成功为准：
 * 一次重新生成失败不应该让一份已存在的品牌档案从界面上消失，
 * 此时服务层会同时给出 `lastRunFailed` 让界面如实提示「下面是上一次成功的结果」。
 */
export type BrandGenerationStatus = "empty" | "generating" | "completed" | "failed";

export interface BrandGenerationState {
  status: BrandGenerationStatus;
  /** 最近一次生成成功、但本次重新生成失败 */
  lastRunFailed: boolean;
  latestTask: BrandGenerationTaskView | null;
  /** 当前模型通道状态，用于在界面上如实标注「Mock 占位 / 通义千问」 */
  provider: AIProviderStatus;
}

/** 一次品牌生成的结果 */
export interface BrandGenerationResult {
  /** 本次生成对应的 agent_task id，可用于排查 */
  taskId: string;
  profile: BrandProfile;
  providerId: string;
  /** 是否为 Mock 占位数据（界面据此给出提示） */
  isMock: boolean;
  /** 主依据商品 id */
  sourceProductId: string;
  sourceProductCount: number;
  analyzedProductCount: number;
  attempts: number;
  repaired: boolean;
  durationMs: number;
  durationText: string;
  /** 是否为「覆盖已有档案」的重新生成 */
  regenerated: boolean;
  warnings: string[];
}

export interface GenerateBrandOptions {
  /** 注入 Provider（测试用）；默认按 AI_PROVIDER 环境变量解析 */
  provider?: AIProvider;
  /**
   * 触发本次生成的工作流 id（S4-1 编排层注入）。
   * 用户单点触发的生成留空。
   */
  workflowId?: string | null;
  /** 覆盖已确认或人工编辑档案必须由用户在界面明确同意。 */
  replaceExisting?: boolean;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/** 参与品牌推导的商品数量上限（与 Agent 的输入上限保持一致） */
const MAX_SOURCE_PRODUCTS = 8;

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

/** 领域记录 → 界面视图 */
function toTaskView(record: AgentTaskRecord): BrandGenerationTaskView {
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
    sourceProductCount: readNumber(record.output, "sourceProductCount"),
    analyzedProductCount: readNumber(record.output, "analyzedProductCount"),
    attempts: readNumber(record.output, "attempts"),
    repaired: readBoolean(record.output, "repaired"),
    warnings: readStringList(record.output, "warnings"),
    sourceProductName: readString(record.input, "sourceProductName"),
  };
}

/** 运行中的任务是否已经过期（进程中断留下的孤儿） */
function isStaleRunningTask(record: AgentTaskRecord, now: Date): boolean {
  const startedAt = record.createdAt ? new Date(record.createdAt).getTime() : NaN;
  if (!Number.isFinite(startedAt)) {
    // 时间不可解析时不阻塞用户，按过期处理
    return true;
  }
  return now.getTime() - startedAt > BRAND_GENERATING_STALE_MS;
}

/**
 * 收口任务记录。
 * **刻意不把失败上抛**：生成结果已经确定，任务记录写不进去（数据库抖动）
 * 不应该把一次成功的生成改判为失败 —— 只记录日志，让人能从日志里发现。
 */
async function closeTask(
  repositories: Repositories,
  taskId: string,
  patch: UpdateAgentTaskInput,
): Promise<void> {
  const updated = await attempt(
    () => repositories.agentTasks.update(taskId, patch),
    (cause) => toAppError(cause, "DB_ERROR", "更新品牌生成任务失败"),
  );
  if (!updated.ok) {
    console.warn(
      `[brand-agent] 任务记录更新失败 taskId=${taskId}：${updated.error.message}`,
    );
  }
}

/** 领域 ProductDNA → Agent 输入里的 DNA 片段 */
function toDnaSlice(dna: ProductDNA | null): BrandAgentProductInput["dna"] {
  if (!dna) {
    return null;
  }
  return {
    coreFeatures: dna.coreFeatures,
    sellingPoints: dna.sellingPoints,
    targetUsers: dna.targetUsers,
    consumptionScenarios: dna.consumptionScenarios,
    marketingAngles: dna.marketingAngles,
    visualFeatures: dna.visualFeatures,
  };
}

/**
 * 汇总参与品牌推导的商品。
 *
 * 排序规则：**主依据商品 → 已完成 AI 分析的商品 → 其余商品**。
 * 这样做的意义是：当商品数超过上限时，被截掉的必定是「既不是主依据、又没做过分析」
 * 的商品 —— 也就是信息量最少的那批，而不是随机截断。
 */
async function collectSourceProducts(
  repositories: Repositories,
  primary: Product,
): Promise<Array<{ product: Product; dna: ProductDNA | null }>> {
  const all = await repositories.products.list();

  const analyzed = all.filter((product) => product.analysisStatus === "analyzed");
  const rest = all.filter((product) => product.analysisStatus !== "analyzed");

  const seen = new Set<string>();
  const ordered: Product[] = [];
  for (const product of [primary, ...analyzed, ...rest]) {
    if (seen.has(product.id)) {
      continue;
    }
    seen.add(product.id);
    ordered.push(product);
    if (ordered.length >= MAX_SOURCE_PRODUCTS) {
      break;
    }
  }

  return Promise.all(
    ordered.map(async (product) => ({
      product,
      dna: await repositories.productDna.getByProductId(product.id),
    })),
  );
}

/* ------------------------------------------------------------------ */
/* 读取：品牌生成上下文                                                */
/* ------------------------------------------------------------------ */

/** 品牌生成的主依据商品（供页面在按钮旁标注「依据：X」） */
export interface BrandSourceProduct {
  id: string;
  name: string;
  /** 该商品是否已有 Product DNA —— 决定依据是否充分 */
  hasDna: boolean;
}

/**
 * 挑选一个最适合作为品牌依据的商品。
 *
 * 规则：**优先已完成 AI 分析（且确实存在 DNA）的商品**，否则退回首件商品。
 * 为什么不让页面自己挑：页面拿不到 Product DNA，只看 `analysisStatus` 会挑到
 * 「状态是 analyzed 但 DNA 已被删掉」的商品，于是生成时才发现没有依据。
 * 这条规则与 `collectSourceProducts` 的排序保持同一取向（有 DNA 的优先）。
 */
export async function getBrandSourceProduct(): Promise<
  Result<BrandSourceProduct | null>
> {
  return attempt(
    async () => {
      const repositories = getRepositories();
      const all = await repositories.products.list();
      const first = all[0];
      if (!first) {
        return null;
      }

      const candidates = [
        ...all.filter((product) => product.analysisStatus === "analyzed"),
        ...all.filter((product) => product.analysisStatus !== "analyzed"),
      ].slice(0, MAX_SOURCE_PRODUCTS);

      for (const product of candidates) {
        const dna = await repositories.productDna.getByProductId(product.id);
        if (dna) {
          return { id: product.id, name: product.name, hasDna: true };
        }
      }

      return { id: first.id, name: first.name, hasDna: false };
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载品牌依据商品失败"),
  );
}

/**
 * 读取品牌生成状态（empty / generating / completed / failed）。
 *
 * 状态派生规则（顺序即优先级）：
 *   1. 已有品牌档案 → completed（若最近一次任务失败，另用 lastRunFailed 提示）
 *   2. 最近一次任务在运行中且未过期 → generating
 *   3. 最近一次任务失败，或运行中但已过期（进程中断）→ failed
 *   4. 其余（没有任务、也没有档案）→ empty
 */
export async function getBrandGenerationState(
  profile: BrandProfile | null,
): Promise<Result<BrandGenerationState>> {
  return attempt(
    async () => {
      const repositories = getRepositories();
      const latest = await repositories.agentTasks.findLatestByType(BRAND_AGENT_TYPE);
      const task = latest ? toTaskView(latest) : null;
      const provider = getAIProviderStatus();

      if (profile) {
        return {
          status: "completed",
          lastRunFailed: task?.status === "failed",
          latestTask: task,
          provider,
        } satisfies BrandGenerationState;
      }

      if (task && task.status === "running" && latest) {
        // 过期判定需要原始记录（视图里的时间是展示字符串，无法可靠比较）
        const stale = isStaleRunningTask(latest, new Date());
        return {
          status: stale ? "failed" : "generating",
          lastRunFailed: false,
          latestTask: task,
          provider,
        } satisfies BrandGenerationState;
      }

      if (task && task.status === "failed") {
        return {
          status: "failed",
          lastRunFailed: false,
          latestTask: task,
          provider,
        } satisfies BrandGenerationState;
      }

      return {
        status: "empty",
        lastRunFailed: false,
        latestTask: task,
        provider,
      } satisfies BrandGenerationState;
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载品牌生成状态失败"),
  );
}

/* ------------------------------------------------------------------ */
/* 写入：完整生成流程                                                  */
/* ------------------------------------------------------------------ */

/**
 * 执行一次品牌 AI 生成（首次生成或重新生成）。
 *
 * @param productId 主依据商品 id（来自页面，因此是 unknown，必须先校验）
 */
export async function generateBrandProfile(
  productId: unknown,
  options: GenerateBrandOptions = {},
): Promise<Result<BrandGenerationResult>> {
  // 1. 校验 ID
  const parsedId = parseProductId(productId);
  if (!parsedId.ok) {
    return parsedId;
  }
  const id = parsedId.data;

  const repositories = getRepositories();

  // 2. 读取主依据商品（同时校验它确实存在）
  const loaded = await attempt(
    () => repositories.products.getById(id),
    (cause) => toAppError(cause, "DB_ERROR", "加载商品失败"),
  );
  if (!loaded.ok) {
    return loaded;
  }
  const primaryProduct = loaded.data;
  if (!primaryProduct) {
    return fail("NOT_FOUND", "商品不存在或已被删除", `productId=${id}`);
  }

  // 3. 汇总品牌依据：商家资料 + Owner Profile + 一组 Product DNA
  const gathered = await attempt(
    async () => {
      const [business, ownerTwin, sources] = await Promise.all([
        repositories.business.getProfile(),
        repositories.business.getOwnerTwin(),
        collectSourceProducts(repositories, primaryProduct),
      ]);
      return { business, ownerTwin, sources };
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载品牌依据失败"),
  );
  if (!gathered.ok) {
    return gathered;
  }
  const { business, ownerTwin, sources } = gathered.data;

  if (!business) {
    return fail(
      "VALIDATION_FAILED",
      "尚未建立商家档案，无法生成品牌",
      "品牌档案归属于商家。请先创建商家资料（可执行 pnpm db:seed 初始化演示数据）后再生成。",
    );
  }

  // getById 是通用读取，不能仅凭传入的商品 ID 就把它当作本商家的品牌依据。
  const ownedProduct = await attempt(
    () => repositories.products.belongsToBusiness(business.id, id),
    (cause) => toAppError(cause, "DB_ERROR", "核对商品归属失败"),
  );
  if (!ownedProduct.ok) return ownedProduct;
  if (!ownedProduct.data) return fail("NOT_FOUND", "商品不存在或已被删除");

  const currentBrand = await attempt(
    () => repositories.brand.getProfile(),
    (cause) => toAppError(cause, "DB_ERROR", "读取已有品牌档案失败"),
  );
  if (!currentBrand.ok) return currentBrand;
  if (currentBrand.data && (currentBrand.data.approved || currentBrand.data.aiVersion === "manual-v1") && !options.replaceExisting) {
    return fail("VALIDATION_FAILED", "当前品牌档案含已确认或人工编辑的内容，请先明确确认覆盖后再重新生成");
  }

  const agentInput: BrandAgentInput = {
    business: {
      id: business.id,
      name: business.name,
      shortName: business.shortName,
      description: business.description,
      owner: business.owner,
      location: business.location,
      mainCategory: business.mainCategory,
      channels: business.channels,
    },
    ownerTwin,
    primaryProductId: id,
    products: sources.map(({ product, dna }) => ({
      name: product.name,
      category: product.category,
      subCategory: product.subCategory,
      origin: product.origin,
      dna: toDnaSlice(dna),
    })),
  };

  // 4. 依据前置检查：没有任何依据就直接拒绝，**不留下一条注定失败的任务记录**
  if (!hasBrandGrounding(agentInput)) {
    return fail(
      "VALIDATION_FAILED",
      "缺少可用于生成品牌的依据",
      "请先对至少一个商品执行「AI 分析商品」生成 Product DNA，或先完善老板数字分身（Owner Profile），再生成品牌策略。",
    );
  }

  // 5. 并发保护：同一时刻只允许一次品牌生成
  const latest = await attempt(
    () => repositories.agentTasks.findLatestByType(BRAND_AGENT_TYPE),
    (cause) => toAppError(cause, "DB_ERROR", "读取品牌生成任务失败"),
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
      "品牌策略正在生成中，请稍候再试",
      `任务 ${runningTask.id} 开始于 ${runningTask.createdAt}，仍在运行`,
    );
  }

  const providerStatus = getAIProviderStatus();
  const startedAt = Date.now();
  const sourceProductCount = sources.length;
  const analyzedProductCount = sources.filter(({ dna }) => dna !== null).length;

  // 6. 创建任务（status=running，直接记录为进行中，避免多一次 queued→running 写操作）
  const createdTask = await attempt(
    () =>
      repositories.agentTasks.create({
        agentType: BRAND_AGENT_TYPE,
        title: `生成品牌策略：${business.name}`,
        /**
         * 品牌档案属于商家而非商品，但任务仍记录主依据商品：
         * 一是留下「这次是基于哪个商品发起的」这条线索，
         * 二是保证商品被删除时相关任务能被级联清理。
         */
        productId: id,
        workflowId: options.workflowId ?? null,
        status: "running",
        progress: 10,
        input: {
          businessId: business.id,
          businessName: business.name,
          sourceProductId: id,
          sourceProductName: primaryProduct.name,
          sourceProductCount,
          analyzedProductCount,
          hasOwnerTwin: ownerTwin !== null,
          requestedProvider: providerStatus.providerId,
        },
      }),
    (cause) => toAppError(cause, "DB_ERROR", "创建品牌生成任务失败"),
  );
  if (!createdTask.ok) {
    return createdTask;
  }
  const taskId = createdTask.data.id;

  // 7. 调用 Brand Agent（模型调用与结构化校验都在 Agent 内部完成）
  const run = await runBrandAgent(agentInput, {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const durationMs = Date.now() - startedAt;

  // 7'. 失败分支：如实记录失败原因与耗时，**绝不写档案**
  if (!run.ok) {
    const detail = run.error.detail ? `（${run.error.detail}）` : "";
    await closeTask(repositories, taskId, {
      status: "failed",
      durationMs,
      errorMessage: `${run.error.message}${detail}`,
    });
    return run;
  }

  const combinedWarnings = [...run.data.warnings];
  const profileInput: NewBrandProfileInput = toNewBrandProfileInput(run.data.draft, {
    sourceProductId: id,
  });

  /** 任务 output 是**该次运行的历史快照**，用于回溯与排查；当前生效的事实以 brand_profiles 表为准 */
  const snapshot = {
    providerId: run.data.providerId,
    isMock: providerStatus.isMock,
    sourceProductCount: run.data.sourceProductCount,
    analyzedProductCount: run.data.analyzedProductCount,
    attempts: run.data.attempts,
    repaired: run.data.repaired,
    warnings: combinedWarnings,
  };

  // 8. 保存品牌档案：已有则覆盖（重新生成），没有则新建
  const existing = await attempt(
    () => repositories.brand.getProfile(),
    (cause) => toAppError(cause, "DB_ERROR", "读取已有品牌档案失败"),
  );
  if (!existing.ok) {
    await closeTask(repositories, taskId, {
      status: "failed",
      durationMs,
      errorMessage: existing.error.message,
      output: snapshot,
    });
    return existing;
  }

  const regenerated = existing.data !== null;
  if (existing.data && (existing.data.approved || existing.data.aiVersion === "manual-v1") && !options.replaceExisting) {
    await closeTask(repositories, taskId, { status: "failed", durationMs, errorMessage: "品牌档案已在生成期间被人工修改，未覆盖现有版本", output: snapshot });
    return fail("VALIDATION_FAILED", "品牌档案已被人工修改，未覆盖现有版本");
  }

  const saved = await attempt(
    () =>
      regenerated
        ? repositories.brand.update(profileInput)
        : repositories.brand.create(profileInput),
    (cause) => toAppError(cause, "DB_ERROR", "保存品牌档案失败"),
  );
  if (!saved.ok) {
    // 档案没落库就不算成功：绝不让界面上出现「已生成品牌」但实际没有档案的状态
    await closeTask(repositories, taskId, {
      status: "failed",
      durationMs,
      errorMessage: saved.error.message,
      output: snapshot,
    });
    return saved;
  }

  // 9. 任务收口
  await closeTask(repositories, taskId, {
    status: "completed",
    progress: 100,
    durationMs,
    output: { profile: run.data.draft, ...snapshot },
  });

  return ok({
    taskId,
    profile: saved.data,
    providerId: run.data.providerId,
    isMock: providerStatus.isMock,
    sourceProductId: id,
    sourceProductCount: run.data.sourceProductCount,
    analyzedProductCount: run.data.analyzedProductCount,
    attempts: run.data.attempts,
    repaired: run.data.repaired,
    durationMs,
    durationText: formatDurationMs(durationMs),
    regenerated,
    warnings: combinedWarnings,
  });
}
