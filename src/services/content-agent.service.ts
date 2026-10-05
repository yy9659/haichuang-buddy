/**
 * Content Agent 业务闭环服务（S3-2）
 *
 * 这是「内容智能」从**能被调用**变成**能被使用**的那一层：
 * 内容工厂选商品 → 选平台 → 点「AI 生成内容」→ 本文件跑完整条链路 → 页面展示内容资产。
 *
 * 完整流程（每一步都可失败、都可观测，全程返回 Result）：
 *
 *   1. 校验入参                → productId / platform / format 非法直接 VALIDATION_FAILED，不触达任何 IO
 *   2. 读取商品                → 不存在返回 NOT_FOUND
 *   3. 汇总生成依据            → Product DNA + Brand Profile + Owner Profile
 *   4. 依据前置检查            → 既无 DNA 也无品牌档案时直接拒绝，**不创建任务记录**
 *   5. 并发保护                → 同一槽位已有运行中的任务则拒绝（过期任务放行重跑）
 *   6. 创建 agent_task         → agentType=content_agent，status=running，记录槽位快照
 *   7. 调用 Content Agent      → 结构化生成 + Zod 校验 + 纠错重试 + 事实与合规扫描
 *   8. 保存 contents           → 该槽位已有内容则 update（覆盖），没有则 create
 *   9. 状态收口                → 任务写 output / duration / errorMessage
 *
 * 四条设计纪律：
 * - **Service 不直连数据库**，一律经 Repository；也不直连模型，一律经 Agent / Provider。
 * - **不编造依据**：拿不到任何 Product DNA 与品牌档案时明确拒绝（见第 4 步），
 *   而不是让模型凭「海产品」这个标签编一条听起来很顺的文案。
 * - **不静默降级**：模型失败就是 failed，任务如实记录失败原因，绝不写一条「看起来像成功」的空内容。
 * - **不伪造结果**：内容一律 `status: draft`（草稿），必须由商家确认后才排期发布
 *   （技术文档 5.4「人拥有最终决策权」）。
 *
 * 与 Brand Agent 服务的差异（刻意不同，不是遗漏）：
 * - 品牌是**单例**（一个商家一份），因此并发保护看「全库最近一次品牌任务」；
 *   内容是按**槽位**（商品 × 平台 × 形态）组织的集合，
 *   因此并发保护与状态派生都必须**按槽位**定位任务（见 `findLatestSlotTask`），
 *   否则「给鲍鱼生成抖音内容」会被「给海带生成小红书内容」的任务挡住。
 * - 状态派生把 `generating` 排在 `completed` **之前**：内容工厂允许在已有旧内容的情况下
 *   重新生成，若把 completed 排在前面，重新生成期间界面会停在「已生成」不动，
 *   用户以为按钮没反应（品牌中心一次只有一份档案，不存在这个场景）。
 */

import { hasContentGrounding, runContentAgent } from "@/ai";
import type { ContentAngle } from "@/lib/content-options";
import type { ContentAgentInput, ContentAgentProductInput } from "@/ai";
import { getAIProviderStatus, type AIProviderStatus } from "@/ai/provider";
import type { AIProvider } from "@/ai/provider/types";
import { toNewContentInput } from "@/ai/schemas/content";
import {
  DEFAULT_CONTENT_FORMAT,
  DEFAULT_CONTENT_PLATFORM,
  isContentFormat,
  isContentPlatform,
} from "@/lib/content-options";
import { formatDurationMs } from "@/lib/datetime";
import { attempt, fail, ok, toAppError, type Result } from "@/lib/result";
import {
  getRepositories,
  type AgentTaskRecord,
  type NewContentInput,
  type Repositories,
  type UpdateAgentTaskInput,
} from "@/repositories";
import { parseProductId } from "@/schemas/product";
import type {
  AgentId,
  AgentStatus,
  ContentFormat,
  ContentItem,
  ContentPlatform,
  ContentSlot,
  Product,
  ProductCategory,
  ProductDNA,
  ProductPosterSource,
} from "@/types";

/**
 * 写入 `agent_tasks.agent_type` 的取值。
 * 与 `CONTENT_AGENT_ID`（"content-agent"）不是同一个字符串：前者是数据库枚举值，
 * 后者是 Agent 的运行时标识，这里显式声明避免写错。
 */
export const CONTENT_AGENT_TYPE: AgentId = "content_agent";

/**
 * 「生成中」的过期阈值。
 * 内容生产用 fast 档位，比品牌策略快得多，因此阈值与商品分析对齐（2 分钟）；
 * 超过则视为进程被中断（部署 / 重启 / 崩溃）留下的孤儿任务，允许重新发起 ——
 * 否则一次中断会把那个槽位永久卡在「生成中」。
 */
export const CONTENT_GENERATING_STALE_MS = 2 * 60 * 1000;

/** 同一个槽位的历史任务最多回看多少条（槽位信息存在任务 input 里，只能靠回看定位） */
const CONTENT_TASK_SCAN_LIMIT = 50;

/** 参与内容生成的可选商品上限，避免商品很多时页面查询被拖慢 */
const MAX_SOURCE_PRODUCTS = 12;

/* ------------------------------------------------------------------ */
/* 视图类型                                                            */
/* ------------------------------------------------------------------ */

/** 最近一次内容生成任务（内容工厂「生成记录」区块用） */
export interface ContentGenerationTaskView {
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
  attempts: number;
  repaired: boolean;
  warnings: string[];
  /** 本次生成的目标平台与形态（来自任务 input） */
  platform: ContentPlatform | null;
  format: ContentFormat | null;
}

/**
 * 内容生成状态（对应任务书 Task 6 要求的 empty / generating / completed / failed）。
 */
export type ContentGenerationStatus = "empty" | "generating" | "completed" | "failed";

export interface ContentGenerationState {
  status: ContentGenerationStatus;
  /** 已有内容、但本次重新生成失败 */
  lastRunFailed: boolean;
  latestTask: ContentGenerationTaskView | null;
  /** 当前模型通道状态，用于在界面上如实标注「Mock 占位 / 通义千问」 */
  provider: AIProviderStatus;
}

/** 一个槽位的完整视图：当前内容 + 生成状态 */
export interface ContentSlotState {
  slot: ContentSlot;
  /** 该槽位当前的内容；null 表示尚未生成过 */
  content: ContentItem | null;
  generation: ContentGenerationState;
}

/** 内容生成的可选商品（供界面下拉与依据提示） */
export interface ContentSourceProduct {
  id: string;
  name: string;
  category: ProductCategory;
  /** 是否已有 Product DNA —— 决定依据是否充分 */
  hasDna: boolean;
  /** 用于海报的商品实拍与价格；可选字段兼容既有调用者。 */
  posterProduct?: ProductPosterSource;
}

/** 一次内容生成的结果 */
export interface ContentGenerationResult {
  /** 本次生成对应的 agent_task id，可用于排查 */
  taskId: string;
  content: ContentItem;
  providerId: string;
  /** 是否为 Mock 占位数据（界面据此给出提示） */
  isMock: boolean;
  slot: ContentSlot;
  attempts: number;
  repaired: boolean;
  durationMs: number;
  durationText: string;
  /** 是否为「覆盖已有内容」的重新生成 */
  regenerated: boolean;
  warnings: string[];
}

export interface GenerateContentOptions {
  angle?: ContentAngle;
  /** 注入 Provider（测试用）；默认按 AI_PROVIDER 环境变量解析 */
  provider?: AIProvider;
  /**
   * 触发本次生成的工作流 id（S4-1 编排层注入）。
   * 用户单点触发的生成留空。
   */
  workflowId?: string | null;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

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
function toTaskView(record: AgentTaskRecord): ContentGenerationTaskView {
  const platform = readString(record.input, "platform");
  const format = readString(record.input, "format");
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
    attempts: readNumber(record.output, "attempts"),
    repaired: readBoolean(record.output, "repaired"),
    warnings: readStringList(record.output, "warnings"),
    platform: isContentPlatform(platform) ? platform : null,
    format: isContentFormat(format) ? format : null,
  };
}

/** 运行中的任务是否已经过期（进程中断留下的孤儿） */
function isStaleRunningTask(record: AgentTaskRecord, now: Date): boolean {
  const startedAt = record.createdAt ? new Date(record.createdAt).getTime() : NaN;
  if (!Number.isFinite(startedAt)) {
    // 时间不可解析时不阻塞用户，按过期处理
    return true;
  }
  return now.getTime() - startedAt > CONTENT_GENERATING_STALE_MS;
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
    (cause) => toAppError(cause, "DB_ERROR", "更新内容生成任务失败"),
  );
  if (!updated.ok) {
    console.warn(
      `[content-agent] 任务记录更新失败 taskId=${taskId}：${updated.error.message}`,
    );
  }
}

/** 两个槽位是否相同 */
function isSameSlot(a: ContentSlot, b: ContentSlot): boolean {
  return (
    a.productId === b.productId && a.platform === b.platform && a.format === b.format
  );
}

/** 从任务记录里还原它属于哪个槽位；历史任务缺字段时返回 null */
function readTaskSlot(record: AgentTaskRecord): ContentSlot | null {
  const productId = record.productId;
  const platform = readString(record.input, "platform");
  const format = readString(record.input, "format");
  if (!productId || !isContentPlatform(platform) || !isContentFormat(format)) {
    return null;
  }
  return { productId, platform, format };
}

/**
 * 定位某个槽位最近一次任务。
 *
 * 为什么是「回看若干条再筛」而不是给仓储加一个按槽位查询的方法：
 * 槽位信息存在任务的 `input` jsonb 里，两套仓储（mock / db）都实现一遍
 * jsonb 内部字段查询，成本远大于收益；单商品的内容任务量很小（平台 × 形态 ≤ 24），
 * 回看 50 条足够，且两套实现天然一致。
 */
async function findLatestSlotTask(
  repositories: Repositories,
  slot: ContentSlot,
): Promise<AgentTaskRecord | null> {
  const tasks = await repositories.agentTasks.listByProduct(
    slot.productId,
    CONTENT_AGENT_TYPE,
    CONTENT_TASK_SCAN_LIMIT,
  );
  return (
    tasks.find((task) => {
      const taskSlot = readTaskSlot(task);
      return taskSlot !== null && isSameSlot(taskSlot, slot);
    }) ?? null
  );
}

/** 领域 ProductDNA → Agent 输入里的 DNA 片段 */
function toDnaSlice(dna: ProductDNA | null): ContentAgentProductInput["dna"] {
  if (!dna) {
    return null;
  }
  return {
    coreFeatures: dna.coreFeatures,
    sellingPoints: dna.sellingPoints,
    targetUsers: dna.targetUsers,
    consumptionScenarios: dna.consumptionScenarios,
    userPainPoints: dna.userPainPoints,
    marketingAngles: dna.marketingAngles,
    visualFeatures: dna.visualFeatures,
  };
}

/**
 * 价格 + 计价单位拼成提示词里可读的一段文本。
 * 刻意不用 `formatCurrency`（它取整，会把 128.50 写成 129）——
 * 价格是商品事实，写进营销文案前不能被四舍五入改掉。
 */
function toPriceText(product: Product): string {
  const price = Number.isFinite(product.price) ? product.price : 0;
  const amount = Number.isInteger(price) ? `${price}` : price.toFixed(2);
  return product.unit ? `${amount} 元 / ${product.unit}` : `${amount} 元`;
}

/** 领域商品 + DNA → Agent 输入里的商品片段 */
function toProductSlice(product: Product, dna: ProductDNA | null): ContentAgentProductInput {
  return {
    name: product.name,
    category: product.category,
    subCategory: product.subCategory,
    origin: product.origin,
    specification: product.specification,
    priceText: toPriceText(product),
    storageMethod: product.storageMethod,
    shelfLife: product.shelfLife,
    dna: toDnaSlice(dna),
  };
}

/* ------------------------------------------------------------------ */
/* 读取：可选商品与生成状态                                            */
/* ------------------------------------------------------------------ */

/**
 * 内容生成的可选商品。
 *
 * 排序规则：**已有 Product DNA 的商品优先**，其余保持数据源顺序。
 * 这样默认选中的商品大概率「依据充分」，用户点生成不容易撞上「没分析过」的提示，
 * 但界面仍会逐项标出依据是否充分，不隐瞒。
 */
export async function getContentSourceProducts(): Promise<
  Result<ContentSourceProduct[]>
> {
  return attempt(
    async () => {
      const repositories = getRepositories();
      const all = await repositories.products.list();
      const candidates = all.slice(0, MAX_SOURCE_PRODUCTS);

      const withDna = await Promise.all(
        candidates.map(async (product) => ({
          product,
          dna: await repositories.productDna.getByProductId(product.id),
        })),
      );

      const ordered = [
        ...withDna.filter((item) => item.dna !== null),
        ...withDna.filter((item) => item.dna === null),
      ];

      return ordered.map(({ product, dna }) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        hasDna: dna !== null,
        posterProduct: {
          id: product.id,
          name: product.name,
          price: product.price,
          unit: product.unit,
          imageUrl: product.imageUrl,
          tags: product.tags,
          specification: product.specification,
        },
      })) satisfies ContentSourceProduct[];
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载内容生成商品失败"),
  );
}

/**
 * 把页面传来的槽位参数解析成一个**真实存在**的槽位。
 *
 * 规则：
 * - `productId` 有效且商品存在 → 用它；否则退回首件商品（优先有 DNA 的）；
 * - `platform` / `format` 非法或缺省 → 退回默认值（抖音 + 短视频脚本）。
 *
 * 为什么放在服务层而不是页面：页面拿不到商品是否存在、有没有 DNA，
 * 只有服务层能保证「返回的槽位一定对应一个真实商品」。
 *
 * @param candidates 已经取到的候选商品。内容工厂页面既要渲染下拉、又要解析槽位，
 *                   传进来可以少跑一遍同样的查询；不传则本函数自己取。
 */
export async function resolveContentSlot(
  query: {
    productId?: string | null;
    platform?: string | null;
    format?: string | null;
  },
  candidates?: ContentSourceProduct[],
): Promise<Result<ContentSlot | null>> {
  const requestedPlatform: ContentPlatform = isContentPlatform(query.platform)
    ? query.platform
    : DEFAULT_CONTENT_PLATFORM;
  const requestedFormat: ContentFormat = isContentFormat(query.format)
    ? query.format
    : DEFAULT_CONTENT_FORMAT;

  let products = candidates;
  if (!products) {
    const loaded = await getContentSourceProducts();
    if (!loaded.ok) {
      return loaded;
    }
    products = loaded.data;
  }
  if (products.length === 0) {
    return ok(null);
  }

  const parsedId = parseProductId(query.productId ?? "");
  const matched = parsedId.ok
    ? products.find((product) => product.id === parsedId.data)
    : undefined;
  const target = matched ?? products[0];
  if (!target) {
    return ok(null);
  }

  return ok({
    productId: target.id,
    platform: requestedPlatform,
    format: requestedFormat,
  });
}

/**
 * 读取某个槽位的生成状态（empty / generating / completed / failed）。
 *
 * 状态派生规则（顺序即优先级）：
 *   1. 最近一次任务在运行中且未过期 → generating
 *   2. 该槽位已有内容 → completed（若最近一次任务失败，另用 lastRunFailed 提示）
 *   3. 最近一次任务失败，或运行中但已过期（进程中断）→ failed
 *   4. 其余（没有任务、也没有内容）→ empty
 */
export async function getContentSlotState(
  slot: ContentSlot,
  content: ContentItem | null,
): Promise<Result<ContentSlotState>> {
  return attempt(
    async () => {
      const repositories = getRepositories();
      const latest = await findLatestSlotTask(repositories, slot);
      const task = latest ? toTaskView(latest) : null;
      const provider = getAIProviderStatus();

      // 1. 正在生成 —— 即便已有旧内容也如实显示「生成中」
      if (latest && task && task.status === "running") {
        const stale = isStaleRunningTask(latest, new Date());
        if (!stale) {
          return {
            slot,
            content,
            generation: {
              status: "generating",
              lastRunFailed: false,
              latestTask: task,
              provider,
            },
          } satisfies ContentSlotState;
        }
      }

      // 2. 已有内容 → completed
      if (content) {
        return {
          slot,
          content,
          generation: {
            status: "completed",
            lastRunFailed: task?.status === "failed",
            latestTask: task,
            provider,
          },
        } satisfies ContentSlotState;
      }

      // 3. 失败，或运行中但已过期（上面 generating 分支已经排除未过期的情况）
      if (task && (task.status === "failed" || task.status === "running")) {
        return {
          slot,
          content: null,
          generation: {
            status: "failed",
            lastRunFailed: false,
            latestTask: task,
            provider,
          },
        } satisfies ContentSlotState;
      }

      return {
        slot,
        content,
        generation: {
          status: "empty",
          lastRunFailed: false,
          latestTask: task,
          provider,
        },
      } satisfies ContentSlotState;
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载内容生成状态失败"),
  );
}

/* ------------------------------------------------------------------ */
/* 写入：完整生成流程                                                  */
/* ------------------------------------------------------------------ */

/**
 * 执行一次内容 AI 生成（首次生成或重新生成）。
 *
 * @param productId 目标商品 id（来自页面，因此是 unknown，必须先校验）
 * @param platform  发布平台
 * @param format    内容形态
 */
export async function generateContent(
  productId: unknown,
  platform: unknown,
  format: unknown,
  options: GenerateContentOptions = {},
): Promise<Result<ContentGenerationResult>> {
  // 1. 校验入参
  const parsedId = parseProductId(productId);
  if (!parsedId.ok) {
    return parsedId;
  }
  if (!isContentPlatform(platform)) {
    return fail(
      "VALIDATION_FAILED",
      "发布平台不合法",
      `收到的 platform=${String(platform)}，允许值见 src/lib/content-options.ts`,
    );
  }
  if (!isContentFormat(format)) {
    return fail(
      "VALIDATION_FAILED",
      "内容形态不合法",
      `收到的 format=${String(format)}，允许值见 src/lib/content-options.ts`,
    );
  }
  const id = parsedId.data;
  const slot: ContentSlot = { productId: id, platform, format };

  const repositories = getRepositories();

  // 2. 读取商品（同时校验它确实存在）
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

  // 3. 汇总生成依据：Product DNA + Brand Profile + Owner Profile
  const gathered = await attempt(
    async () => {
      const [dna, brand, ownerTwin] = await Promise.all([
        repositories.productDna.getByProductId(id),
        repositories.brand.getProfile(),
        repositories.business.getOwnerTwin(),
      ]);
      return { dna, brand, ownerTwin };
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载内容生成依据失败"),
  );
  if (!gathered.ok) {
    return gathered;
  }
  const { dna, brand, ownerTwin } = gathered.data;

  const agentInput: ContentAgentInput = {
    product: toProductSlice(product, dna),
    brand: brand
      ? {
          positioning: brand.positioning,
          slogan: brand.slogan,
          brandStory: brand.brandStory,
          brandValues: brand.brandValues,
          targetAudience: brand.targetAudience,
          brandKeywords: brand.brandPersonality,
          toneOfVoice: brand.toneOfVoice,
          visualKeywords: brand.visualKeywords,
        }
      : null,
    ownerTwin,
    request: { platform, format },
    angle: options.angle ?? "selling-point",
  };

  // 4. 依据前置检查：没有任何依据就直接拒绝，**不留下一条注定失败的任务记录**
  if (!hasContentGrounding(agentInput)) {
    return fail(
      "VALIDATION_FAILED",
      "缺少可用于生成内容的依据",
      "请先对该商品执行「AI 分析商品」生成 Product DNA，或先生成品牌档案，再生成内容。",
    );
  }

  // 5. 并发保护：同一槽位同一时刻只允许一次生成
  const latest = await attempt(
    () => findLatestSlotTask(repositories, slot),
    (cause) => toAppError(cause, "DB_ERROR", "读取内容生成任务失败"),
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
      "该平台的内容正在生成中，请稍候再试",
      `任务 ${runningTask.id} 开始于 ${runningTask.createdAt}，仍在运行`,
    );
  }

  const providerStatus = getAIProviderStatus();
  const startedAt = Date.now();

  // 6. 创建任务（status=running，直接记录为进行中，避免多一次 queued→running 写操作）
  const createdTask = await attempt(
    () =>
      repositories.agentTasks.create({
        agentType: CONTENT_AGENT_TYPE,
        title: `生成${format}内容：${product.name}`,
        productId: id,
        workflowId: options.workflowId ?? null,
        status: "running",
        progress: 10,
        /**
         * 槽位信息（platform / format）必须写进任务 input：
         * 状态派生与并发保护都要靠它把这个任务归到某个槽位上。
         */
        input: {
          productId: id,
          productName: product.name,
          platform,
          format,
          angle: options.angle ?? "selling-point",
          hasDna: dna !== null,
          hasBrandProfile: brand !== null,
          hasOwnerTwin: ownerTwin !== null,
          requestedProvider: providerStatus.providerId,
        },
      }),
    (cause) => toAppError(cause, "DB_ERROR", "创建内容生成任务失败"),
  );
  if (!createdTask.ok) {
    return createdTask;
  }
  const taskId = createdTask.data.id;

  // 7. 调用 Content Agent（模型调用与结构化校验都在 Agent 内部完成）
  const run = await runContentAgent(agentInput, {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const durationMs = Date.now() - startedAt;

  // 7'. 失败分支：如实记录失败原因与耗时，**绝不写内容**
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
  const contentInput: NewContentInput = toNewContentInput(run.data.draft, {
    productId: id,
    productName: product.name,
  });

  /** 任务 output 是**该次运行的历史快照**，用于回溯与排查；当前生效的事实以 contents 表为准 */
  const snapshot = {
    providerId: run.data.providerId,
    isMock: providerStatus.isMock,
    platform,
    format,
    attempts: run.data.attempts,
    repaired: run.data.repaired,
    warnings: combinedWarnings,
  };

  // 8. 保存内容：该槽位已有内容则覆盖（重新生成），没有则新建
  const existing = await attempt(
    () => repositories.content.findBySlot(slot),
    (cause) => toAppError(cause, "DB_ERROR", "读取已有内容失败"),
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

  const saved = await attempt(
    () =>
      regenerated
        ? repositories.content.updateBySlot(slot, contentInput)
        : repositories.content.create(contentInput),
    (cause) => toAppError(cause, "DB_ERROR", "保存内容失败"),
  );
  if (!saved.ok) {
    // 内容没落库就不算成功：绝不让界面上出现「已生成内容」但实际没有记录的状态
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
    output: { content: run.data.draft, ...snapshot },
  });

  return ok({
    taskId,
    content: saved.data,
    providerId: run.data.providerId,
    isMock: providerStatus.isMock,
    slot,
    attempts: run.data.attempts,
    repaired: run.data.repaired,
    durationMs,
    durationText: formatDurationMs(durationMs),
    regenerated,
    warnings: combinedWarnings,
  });
}
