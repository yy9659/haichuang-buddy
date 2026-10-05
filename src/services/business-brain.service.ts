/**
 * 经营大脑 · 业务闭环服务（S4-1）
 *
 * 这是「编排」从**能被调用**变成**能被使用**的那一层。它与六位一线 Agent
 * 各自服务的根本差别在于：它自己**不产出任何业务内容**，只做两件事 ——
 * 「把一句经营目标变成一份计划」与「把计划跑成一串真实的业务结果」。
 *
 * 四个入口（用户可见的流程是前三行按顺序走）：
 *
 *   createBusinessPlan(goal)   ── 规划：读现状 → 调 Business Brain → 建 idle 工作流（计划落库）
 *        ↓（商家看过计划，确认没问题）
 *   startBusinessWorkflow(id)  ── 执行：复核计划 → 按依赖调度 → 真正调用六个 Agent 服务
 *        ↓（某几步失败）
 *   retryWorkflow(id)          ── 重试：复用判定自动跳过已成功的步骤，只重跑没成的
 *   getWorkflowState(id?)      ── 查询：某轮（或最近一轮）的状态与逐步结果
 *
 * 为什么「规划」与「执行」是**两个**入口、中间隔着一次落库：
 * 技术文档 5.4 要求「人拥有最终决策权」。让 AI 读一遍目标就立刻花掉若干次模型调用、
 * 改动三张业务表，等于把决策权交给模型；先给计划、商家确认后再执行，才是「AI 建议、人拍板」。
 * 落库（而不是只在内存里传计划）另有一个实在的好处：执行时读到的是**当时那份计划**，
 * 中间重启进程也不会丢。
 *
 * 三条设计纪律（与其它服务一致，在这里格外重要）：
 * - **不重写 Agent**：执行时只调六个 Service。编排层不碰提示词、不碰模型、
 *   不碰各领域的落库规则 —— 否则「商品理解怎么存」就要在两个地方各写一遍。
 * - **不伪造进度**：工作流状态完全由执行结果驱动，本轮不做实时进度推送，
 *   界面该看到的就是「运行中」与最终结果，中间不编造百分比。
 * - **不静默降级**：规划失败就不建记录（没有计划可存）、执行失败如实写 `errorMessage`、
 *   重试是重跑整轮（靠复用判定省钱），绝不把失败偷偷标成成功。
 */

import {
  MAX_CONTEXT_PRODUCTS,
  hasPlannableInput,
  parseStoredBusinessPlan,
  runBusinessBrain,
  toStoredBusinessPlan,
  type BusinessBrainInput,
  type BusinessPlanDraft,
  type PlannerAgentId,
  type StoredBusinessPlan,
} from "@/ai";
import { getAIProviderStatus, type AIProviderStatus } from "@/ai/provider";
import type { AIProvider } from "@/ai/provider/types";
import {
  runBusinessWorkflow,
  resolveReusableTasks,
  validateBusinessPlan,
  type BusinessStateSnapshot,
  type TaskRunRequest,
  type TaskRunResponse,
  type WorkflowRunResult,
  type WorkflowTaskRecord,
  type WorkflowTaskRunner,
} from "@/ai/workflows";
import {
  MAX_BUSINESS_GOAL_LENGTH,
  buildBusinessGoalText,
  resolveBusinessGoalChannels,
  type BusinessGoalChannel,
} from "@/lib/business-goal";
import { formatDurationMs } from "@/lib/datetime";
import { attempt, fail, ok, toAppError, type Result } from "@/lib/result";
import {
  getRepositories,
  type AgentTaskRecord,
  type AgentWorkflowRecord,
  type AgentWorkflowSummary,
  type Repositories,
  type WorkflowTaskOutcome,
} from "@/repositories";
import { toWorkflowSummary } from "@/repositories/agent-workflow";
import { toContentSlotKey } from "@/repositories/content-item";
import type {
  AgentId,
  AgentStatus,
  ContentFormat,
  ContentPlatform,
} from "@/types";

import { generateBrandProfile } from "./brand-agent.service";
import { generateContent } from "./content-agent.service";
import { createConversation, sendCustomerMessage } from "./customer-service";
import {
  getLiveSessionState,
  startDemoLiveSession,
  submitLiveComment,
} from "./live-agent.service";
import { generateBusinessReport } from "./analytics.service";
import { analyzeProduct } from "./product-agent.service";

/**
 * 写入 `agent_tasks.agent_type` 的取值。
 * 与 `BUSINESS_BRAIN_AGENT_ID`（"business-brain"）不是同一个字符串：
 * 前者是数据库枚举值，后者是 Agent 的运行时标识，显式声明避免写错。
 */
export const BUSINESS_BRAIN_AGENT_TYPE: AgentId = "business_brain";

/**
 * 「运行中」的过期阈值：超过则视为进程被中断留下的孤儿工作流，允许重新启动。
 *
 * 取 10 分钟是有依据的：单任务超时是 2 分钟、并发上限 3，一份最多 12 步的
 * 六 Agent 计划按依赖分阶段执行，最坏约 8 分钟；再留两分钟避免把慢响应误判成孤儿 ——
 * 误判的代价是同一批商品被跑两遍、多发一轮模型调用。
 */
export const WORKFLOW_RUNNING_STALE_MS = 10 * 60 * 1000;

/**
 * 经营目标长度上限。S4-2 起以 `@/lib/business-goal` 为唯一出处：
 * 对话框要在 **客户端** 校验同一件事，而客户端 import 本文件会把整个 AI 层
 * （Provider、Zod、数据库连接）打进浏览器包。这里转出，是为了让既有的
 * 服务端调用方与测试继续按原路径取用。
 */
export { MAX_BUSINESS_GOAL_LENGTH };

/** 参与规划的商品上限（与 Agent 的上下文上限保持一致） */
const MAX_PLAN_PRODUCTS = MAX_CONTEXT_PRODUCTS;

/* ------------------------------------------------------------------ */
/* 视图类型                                                            */
/* ------------------------------------------------------------------ */

/**
 * 规划时看到的经营状态。
 * 之所以要回给界面：商家看到「5 步」时会问「为什么是 5 步」，
 * 这些计数就是答案（几件商品已有理解、品牌档案在不在、哪些槽位已有内容）。
 */
export interface BusinessPlanContextView {
  /** 本次交给模型规划的商品件数 */
  productCount: number;
  /** 其中已有商品理解的件数（有了就不必再安排分析） */
  analyzedProductCount: number;
  /** 全店商品总数；大于 `productCount` 说明本次只取了一部分 */
  totalProductCount: number;
  hasBrandProfile: boolean;
  hasOwnerTwin: boolean;
  /** 已有内容的槽位数量（这些槽位的内容任务会被复用） */
  contentSlotCount: number;
}

/**
 * 计划落库前的**复用预判**（S4-2）。
 *
 * 它回答商家在计划确认界面最关心的三个数字：
 * 「这次要花几次模型调用」「有多少是白拿的」「能多出几条能发的内容」。
 *
 * 为什么在**规划阶段**就算一次，而不是等执行完再看摘要：
 * 任务书的核心体验是「人拥有最终确认权」—— 商家要在**按下确认之前**
 * 就知道这次大概要花多少、能拿到什么。执行完才知道等于没有选择权。
 *
 * 预判与执行用的是**同一个** `resolveReusableTasks` 与同一份状态快照
 * （都在 `loadPlanningContext` 里取的），因此预判不会与执行结果打架；
 * 但两者之间隔着商家的确认时间，期间商品被删仍可能变化 ——
 * 所以文案上它是「预计」，而执行后以 `summary` 为准。
 */
export interface BusinessPlanReusePreview {
  /** 预计不会真正执行、直接复用已有结果的任务 id */
  reusableTaskIds: string[];
  /** 预计真正要执行的任务数（含内容与需要补做的分析） */
  executableCount: number;
  /** 预计复用数 */
  reusableCount: number;
  /** 预计新增的可发布内容条数（只数 content_agent，品牌与商品理解是幕后资产） */
  expectedContentCount: number;
  /** 预计要调用的模型次数上限（每个要执行的任务至少一次；纠错重试不在此列） */
  estimatedModelCalls: number;
}

export interface BusinessPlanResult {
  /** 落库的工作流记录 id —— 执行时用它启动 */
  workflowId: string;
  plan: BusinessPlanDraft;
  providerId: string;
  /** 是否为 Mock 占位数据（界面据此给出提示） */
  isMock: boolean;
  /** 调用模型的次数（含两层纠错重试） */
  attempts: number;
  /** 语义纠错经历了几轮（1 = 首次就通过合法性校验） */
  planRounds: number;
  repaired: boolean;
  warnings: string[];
  durationMs: number;
  durationText: string;
  context: BusinessPlanContextView;
  /**
   * 复用预判（S4-2）。全部待执行时各项计数为 0 / 全量，
   * 界面照样渲染（「预计执行 4 步、复用 0 步」本身就是有用的信息）。
   */
  reusePreview: BusinessPlanReusePreview;
  /** 本次规划的主推商品 id（商家指定过才有；界面用于把确认界面的焦点对准它） */
  primaryProductId: string | null;
  /** 本次规划实际生效的渠道（商家勾选且被识别的那部分） */
  channels: BusinessGoalChannel[];
}

/**
 * 计划里的一个步骤在本轮的实际落地情况。
 *
 * `outcome` 取 `pending` 表示「这一轮还没跑到它」：工作流仍在运行时，
 * 摘要还没写库，逐步报告自然也不存在。**刻意不臆测**每一步的结果。
 */
export interface BusinessWorkflowStepView {
  taskId: string;
  agent: PlannerAgentId;
  title: string;
  /** 安排理由（来自计划快照，不随执行变化） */
  reason: string;
  productId: string | null;
  platform: ContentPlatform | null;
  format: ContentFormat | null;
  outcome: WorkflowTaskOutcome | "pending";
  /** 对应的 `agent_tasks` 状态；跳过的步骤也可能有记录（编排层会补一条），无记录时为 null */
  status: AgentStatus | null;
  /** 一句话说明（复用原因 / 失败原因 / 跳过原因）；顺利跑完的步骤没有 */
  note: string | null;
  /** 被哪些前置任务挡住（跳过时才有） */
  blockedBy: string[];
  /** 产出对象标识（内容 id / 商品 id） */
  outputRef: string | null;
  durationMs: number | null;
}

export interface BusinessWorkflowState {
  workflow: AgentWorkflowRecord;
  /** 计划快照；jsonb 读不回来时为 null（界面必须如实说明，而不是显示一份空计划） */
  plan: StoredBusinessPlan | null;
  summary: AgentWorkflowSummary | null;
  steps: BusinessWorkflowStepView[];
  /**
   * 本轮落到 `agent_tasks` 的执行记录。
   *
   * 刻意**不与 `steps` 逐条配对**：复用与跳过的步骤没有任何 Agent 服务参与，
   * 因此不存在对应记录；按「执行者 + 商品 + 槽位」去猜配对，猜错时界面会把
   * A 步的失败原因挂到 B 步上 —— 那比不显示更糟。两者各自如实呈现即可。
   */
  agentTasks: AgentTaskRecord[];
  /** 本轮是否仍被视为「正在执行」（running 且未过期） */
  isRunning: boolean;
  /** running 但已过期 —— 进程中断留下的孤儿记录 */
  isStale: boolean;
  /** 可以启动执行（尚未跑过） */
  canStart: boolean;
  /** 可以重试（跑过但没全成） */
  canRetry: boolean;
  /** 当前模型通道状态，用于在界面上如实标注「Mock 占位 / 通义千问」 */
  provider: AIProviderStatus;
}

export interface WorkflowRunView {
  workflowId: string;
  status: WorkflowRunResult["status"];
  summary: AgentWorkflowSummary;
  /** 面向商家的一句话结果说明；一切顺利时为 null */
  errorMessage: string | null;
  /** 按计划顺序排列的逐任务记录 */
  tasks: WorkflowTaskRecord[];
  durationMs: number;
  durationText: string;
  /** 是否为「同一份计划再跑一轮」（重试） */
  retried: boolean;
}

export interface BusinessBrainServiceOptions {
  /** 注入 Provider（测试用）；默认按 AI_PROVIDER 环境变量解析 */
  provider?: AIProvider;
  /**
   * 编排层的并发上限。默认 3（见 `DEFAULT_MAX_CONCURRENCY`）。
   * 开放出来主要是为了测试能把它压到 1，从而稳定断言执行顺序。
   */
  maxConcurrency?: number;
  /** 单任务超时（毫秒）。测试可下调，避免用例真的等满 2 分钟 */
  taskTimeoutMs?: number;
  /** 整轮取消信号 */
  signal?: AbortSignal;
}

/**
 * `createBusinessPlan` 的调用参数。
 *
 * 前四项是**注入物**（Provider、并发、超时、信号），后三项是**本次规划的业务输入**
 * （来自驾驶舱对话框）。它们放在同一个对象里，是因为对调用方来说都是
 * 「这一次调用的参数」；真正的分界线在**是否落库**上 —— 只有组装后的 `goal`
 * 文本会写进 `agent_workflows`，主推商品与渠道只影响这一次的规划。
 *
 * 为什么不把业务输入做成 `createBusinessPlan({...})` 的对象入参：
 * 该函数的第一个参数一直是「可能是任何东西的商家原话」（来自表单，因此是
 * `unknown` 并在内部校验），改成对象会让 `unknown` 的守卫失效，
 * 也会让既有的二十多处调用与测试全部要改 —— 收益不抵风险。
 */
export interface BusinessPlanOptions extends BusinessBrainServiceOptions {
  /** 主推商品 id；非商品清单内的值会被忽略（不猜、不报错） */
  primaryProductId?: string | null;
  /** 商家勾选的渠道（平台值数组，如 `["douyin", "wechat"]`） */
  channels?: readonly string[];
  /** 目标人群，可选 */
  targetAudience?: string | null;
  /** 用户明确选择六岗位全链路；规划结果必须覆盖全部六种岗位。 */
  fullChain?: boolean;
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/** 校验经营目标文本 */
function parseGoal(goal: unknown): Result<string> {
  const text = typeof goal === "string" ? goal.trim() : "";
  if (!text) {
    return fail(
      "VALIDATION_FAILED",
      "请先写下这次想达成的经营目标",
      "例如「这周把连江鲜活鲍鱼的抖音内容做起来」。目标越具体，计划越能用。",
    );
  }
  if (text.length > MAX_BUSINESS_GOAL_LENGTH) {
    return fail(
      "VALIDATION_FAILED",
      `经营目标不能超过 ${MAX_BUSINESS_GOAL_LENGTH} 字`,
      `当前 ${text.length} 字。请只保留最关键的那一件事。`,
    );
  }
  return ok(text);
}

/** 校验工作流 id（来自 URL / 表单，因此是 unknown） */
function parseWorkflowId(value: unknown): Result<string> {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    return fail("VALIDATION_FAILED", "缺少工作流 id", "请从经营计划入口重新发起。");
  }
  return ok(id);
}

/**
 * 运行中的工作流是否已经过期（进程中断留下的孤儿）。
 * 时间不可解析时按过期处理 —— 卡住不放行比误放行更糟：商家会一直点不动按钮。
 */
function isStaleRunning(workflow: AgentWorkflowRecord, now: Date): boolean {
  const startedAt = workflow.createdAt ? new Date(workflow.createdAt).getTime() : NaN;
  if (!Number.isFinite(startedAt)) {
    return true;
  }
  return now.getTime() - startedAt > WORKFLOW_RUNNING_STALE_MS;
}

/** 规划时需要的全部上下文与状态快照 */
interface PlanningContext {
  /** 交给 Agent 的商品清单 */
  products: BusinessBrainInput["products"];
  businessId: string;
  hasBrandProfile: boolean;
  hasOwnerTwin: boolean;
  /** 复用判定用的状态快照（规划与执行各取一次，理由见 `resolveReusableTasks`） */
  snapshot: BusinessStateSnapshot;
  view: BusinessPlanContextView;
}

/**
 * 一次性把规划要用的现状读齐。
 *
 * 为什么在这里把「商品 + 是否已有商品理解 + 品牌档案 + 已有内容槽位」一次读完，
 * 而不是让 Agent 自己按需查：Agent 是纯逻辑层（可离线测试、可换模型），
 * 让它拿仓储会把「能不能离线跑」这件事毁掉。读取归服务层。
 *
 * `primaryProductId`（S4-2）只做**排序**，不做增删：
 * 商家指定的主推商品被提到清单最前。为什么是排序而不是过滤 ——
 * 只留主推商品会让模型看不到全店现状，「这个目标是不是别的商品更合适」
 * 这类判断就没了依据；而排在前面足以让模型（与 Mock 的取值顺序）
 * 自然地把重心放在它身上。
 */
async function loadPlanningContext(
  repositories: Repositories,
  primaryProductId?: string | null,
): Promise<PlanningContext> {
  const all = await repositories.products.list();
  // 商品很多时只取前若干件：上下文塞满商品，计划反而会失去焦点
  const candidates = all.slice(0, MAX_PLAN_PRODUCTS);

  /**
   * 主推商品排到最前。
   * 只在它确实落在本批候选里时才动顺序 —— 若它在 `MAX_PLAN_PRODUCTS` 之外，
   * 把它强行塞进来会挤掉一件本来能被规划的商品，且模型也读不到它的完整信息。
   */
  if (primaryProductId) {
    const index = candidates.findIndex((product) => product.id === primaryProductId);
    if (index > 0) {
      const [primary] = candidates.splice(index, 1);
      if (primary) {
        candidates.unshift(primary);
      }
    }
  }

  const [withDna, brand, ownerTwin, contents, business] = await Promise.all([
    Promise.all(
      candidates.map(async (product) => ({
        product,
        dna: await repositories.productDna.getByProductId(product.id),
      })),
    ),
    repositories.brand.getProfile(),
    repositories.business.getOwnerTwin(),
    repositories.content.list(),
    repositories.business.getProfile(),
  ]);

  const products: BusinessBrainInput["products"] = withDna.map(
    ({ product, dna }) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      hasDna: dna !== null,
    }),
  );

  const analyzedProductCount = withDna.filter((item) => item.dna !== null).length;
  const contentSlotKeys = new Set(
    contents.map((item) =>
      toContentSlotKey({
        productId: item.productId,
        platform: item.platform,
        format: item.format,
      }),
    ),
  );

  return {
    products,
    /**
     * 商家 id。Demo 是单商家，理论上一定取得到；取不到时交给仓储去解析
     * （数据库实现有 `resolvePrimaryBusinessId` 兜底），因此这里用空串表示「未指定」。
     */
    businessId: business?.id ?? "",
    hasBrandProfile: brand !== null,
    hasOwnerTwin: ownerTwin !== null,
    snapshot: {
      productsWithDna: new Set(
        withDna.filter((item) => item.dna !== null).map((item) => item.product.id),
      ),
      hasBrandProfile: brand !== null,
      contentSlotKeys,
    },
    view: {
      productCount: products.length,
      analyzedProductCount,
      totalProductCount: all.length,
      hasBrandProfile: brand !== null,
      hasOwnerTwin: ownerTwin !== null,
      contentSlotCount: contentSlotKeys.size,
    },
  };
}

/**
 * 构造执行器需要的 runner。
 *
 * 每个分支只做三件事：解析计划任务里的参数 → 调对应 Service → 把结果翻译成
 * 执行器能懂的成功 / 失败信封。**刻意不在这一层做业务判断**（比如「商品不存在该怎么说」），
 * 那些判断各 Service 已经想清楚了，再翻译一遍只会让两处文案不一致。
 */
function createTaskRunner(params: {
  workflowId: string;
  provider?: AIProvider;
  /**
   * brand_agent 的兜底锚点商品 id。
   *
   * 计划契约刻意允许 brand_agent 不绑商品（schema / 校验器 / 提示词三处一致：
   * 「品牌档案是全店的，可不绑商品」），但 Brand Service 需要一件商品作
   * 主依据（素材来源 + 任务记录锚点）。计划里出现 null 时退回本参数，
   * 取值见 executeStoredPlan：计划里第一个目标商品，否则全店第一件商品。
   */
  brandFallbackProductId?: string | null;
}): WorkflowTaskRunner {
  const base = {
    workflowId: params.workflowId,
    ...(params.provider ? { provider: params.provider } : {}),
  };

  /** 失败结果统一带上错误码：界面要靠它区分「模型超时」与「商品不存在」 */
  function toFailure(error: {
    message: string;
    code?: string;
    detail?: string;
  }): TaskRunResponse {
    return {
      ok: false,
      /**
       * detail 必须跟着进记录：SCHEMA_INVALID 的 detail 是「哪个字段没过」，
       * 丢掉它，商家（和我们）就只能看到一句「未通过结构校验」，没法定位。
       * 格式对齐 Brand Service closeTask 的 `${message}（${detail}）` 约定。
       */
      errorMessage: `${error.message}${error.detail ? `（${error.detail}）` : ""}`,
      ...(error.code ? { errorCode: error.code } : {}),
    };
  }

  return async (request: TaskRunRequest): Promise<TaskRunResponse> => {
    const { task, signal } = request;
    const options = { ...base, signal };

    switch (task.agent) {
      case "product_agent": {
        if (!task.productId) {
          // 计划校验器不会放过这种计划，这里只是不让类型系统放宽
          return toFailure({ message: "商品分析任务缺少目标商品", code: "VALIDATION_FAILED" });
        }
        const result = await analyzeProduct(task.productId, options);
        // 商品理解以商品为主键（一个商品一份），因此产出标识就是商品 id
        return result.ok
          ? { ok: true, outputRef: result.data.productId }
          : toFailure(result.error);
      }

      case "brand_agent": {
        /**
         * 计划允许 brand 的 productId 为 null，而 Brand Service 必须有一件
         * 主依据商品 —— 这里是两份契约的唯一汇合点，兜底也只该做一次：
         * 优先用计划指定的，缺省退回本次经营任务的锚点商品。
         */
        const brandAnchorId = task.productId ?? params.brandFallbackProductId ?? null;
        if (!brandAnchorId) {
          return toFailure({
            message: "全店还没有商品，无法生成品牌档案",
            code: "VALIDATION_FAILED",
          });
        }
        const result = await generateBrandProfile(brandAnchorId, options);
        /**
         * 品牌档案不产出 `outputRef`：它是全店唯一的一份，界面上不存在「某一份档案」
         * 这个概念，给一个标识反而会让人以为可以按 id 取到多份。
         */
        return result.ok ? { ok: true } : toFailure(result.error);
      }

      case "content_agent": {
        if (!task.productId || !task.platform || !task.format) {
          return toFailure({
            message: "内容任务缺少商品、平台或形态",
            code: "VALIDATION_FAILED",
          });
        }
        const result = await generateContent(
          task.productId,
          task.platform,
          task.format,
          options,
        );
        return result.ok
          ? { ok: true, outputRef: result.data.content.id }
          : toFailure(result.error);
      }

      case "customer_service_agent": {
        if (!task.productId) {
          return toFailure({
            message: "客服预演任务缺少目标商品",
            code: "VALIDATION_FAILED",
          });
        }
        const repositories = getRepositories();
        const product = await repositories.products.getById(task.productId);
        if (!product) {
          return toFailure({ message: "客服预演商品不存在", code: "NOT_FOUND" });
        }
        const conversation = await createConversation({
          customerName: "AI 协同预演",
          customerLabel: "经营大脑",
          productId: product.id,
          channel: "simulator",
          tags: ["六Agent协同", `workflow:${params.workflowId}`],
        });
        if (!conversation.ok) {
          return toFailure(conversation.error);
        }
        const sent = await sendCustomerMessage(
          {
            conversationId: conversation.data.id,
            content: `这款「${product.name}」收到后应该怎么保存？`,
          },
          options,
        );
        if (!sent.ok) {
          return toFailure(sent.error);
        }
        if (sent.data.failure) {
          return toFailure(sent.data.failure);
        }
        return { ok: true, outputRef: conversation.data.id };
      }

      case "live_agent": {
        if (!task.productId) {
          return toFailure({
            message: "直播预演任务缺少目标商品",
            code: "VALIDATION_FAILED",
          });
        }
        const state = await getLiveSessionState();
        if (!state.ok) {
          return toFailure(state.error);
        }
        let session = state.data.session;
        if (!session || session.status !== "live" || session.productId !== task.productId) {
          const started = await startDemoLiveSession({ productId: task.productId });
          if (!started.ok) {
            return toFailure(started.error);
          }
          session = started.data;
        }
        const submitted = await submitLiveComment(
          {
            sessionId: session.id,
            content: "这款海鲜收到后怎么保存，直播间能给个明确说法吗？",
            authorName: "AI 协同预演",
          },
          options,
        );
        if (!submitted.ok) {
          return toFailure(submitted.error);
        }
        if (submitted.data.failure) {
          return toFailure(submitted.data.failure);
        }
        return {
          ok: true,
          outputRef: submitted.data.suggestion?.id ?? session.id,
        };
      }

      case "analytics_agent": {
        const result = await generateBusinessReport(options);
        return result.ok
          ? { ok: true, outputRef: result.data.report.id }
          : toFailure(result.error);
      }
    }
  };
}

/**
 * 将上一轮真实完成的 agent_tasks 映射回计划任务。
 * 工作流摘要可能来自旧版本或人工修复而没有 steps，因此重试不能只依赖摘要；
 * 任务流水才是「这个 Agent 是否真的完成过」的持久证据。
 */
function matchesCompletedAgentTask(
  planTask: BusinessPlanDraft["tasks"][number],
  agentTask: AgentTaskRecord,
): boolean {
  if (agentTask.status !== "completed" || agentTask.agentType !== planTask.agent) {
    return false;
  }
  if (planTask.productId !== agentTask.productId) {
    return false;
  }
  if (planTask.agent !== "content_agent") {
    return true;
  }
  return (
    agentTask.input?.platform === planTask.platform &&
    agentTask.input?.format === planTask.format
  );
}

/* ------------------------------------------------------------------ */
/* 内部：读取现状                                                      */
/* ------------------------------------------------------------------ */

/** 最近一条运行中的工作流；没有则返回 null */
async function findRunningWorkflow(
  repositories: Repositories,
): Promise<AgentWorkflowRecord | null> {
  return repositories.agentWorkflows.findLatestRunning();
}

/* ------------------------------------------------------------------ */
/* 写入：规划                                                          */
/* ------------------------------------------------------------------ */

/**
 * 制定一份经营计划并落库（状态 `idle`，尚未执行）。
 *
 * 并发保护：**同一时刻只允许一轮经营计划在跑**。
 * 任务书写的是「同 business + goal 防重复」，这里刻意做得更严 —— 理由是
 * 一个商家只有一套商品，两个不同目标的计划同时跑会争抢同一批商品：
 * 两边都会试图给同一件商品做分析、往同一个内容槽位写内容，
 * 结果是重复的模型调用与互相覆盖的写入。宁可让商家等几分钟，也不要把钱花重。
 * 为了不至于让提示含糊，文案按「是否同一个目标」分开写。
 */
export async function createBusinessPlan(
  goal: unknown,
  options: BusinessPlanOptions = {},
): Promise<Result<BusinessPlanResult>> {
  // 1. 校验目标
  const parsedGoal = parseGoal(goal);
  if (!parsedGoal.ok) {
    return parsedGoal;
  }
  const target = parsedGoal.data;

  /**
   * 商家勾选的渠道。
   * 未知平台在这里被**丢掉**（`resolveBusinessGoalChannels` 保证只返回清单内的项），
   * 不做「无效就整体报错」—— 表单已被勾选组件约束，出现未知值说明请求被伪造或
   * 前后端不同步，而这种情况下商家的意图（其余渠道）仍然是有效的。
   */
  const channels = resolveBusinessGoalChannels(options.channels);
  const targetAudience = options.targetAudience?.trim() || null;
  if (options.fullChain && channels.length === 0) {
    return fail("VALIDATION_FAILED", "六岗位全链路至少需要选择一个内容渠道");
  }

  const repositories = getRepositories();

  // 2. 读现状（规划依据 + 复用判定快照）
  const loaded = await attempt(
    () => loadPlanningContext(repositories, options.primaryProductId),
    (cause) => toAppError(cause, "DB_ERROR", "加载经营现状失败"),
  );
  if (!loaded.ok) {
    return loaded;
  }
  const context = loaded.data;

  // 3. 没有商品就没有可执行的事，明确拒绝而不是让模型凭空编一件商品出来
  if (context.products.length === 0) {
    return fail(
      "VALIDATION_FAILED",
      "还没有可规划的商品",
      "请先在商品中心添加至少一件商品，再让经营大脑制定计划。",
    );
  }

  /**
   * 主推商品必须真实存在。
   *
   * 传了一个清单里没有的 id（商品被删了、或链接被人改过）时**不报错**，
   * 而是退回「未指定」：商家点的是「启动今日经营」，不是「校验这个 id」；
   * 因为一个过期的引用让整次规划失败，等于把一次无关紧要的不一致
   * 放大成一次业务不可用。真正的影响只是计划不再聚焦那件商品。
   */
  const primaryProduct =
    options.primaryProductId
      ? (context.products.find(
          (product) => product.id === options.primaryProductId,
        ) ?? null)
      : null;
  const primaryProductId = primaryProduct?.id ?? null;

  /**
   * 组装最终交给模型的经营目标。
   *
   * **刻意放在服务端**（而不是让对话框组装好再传进来）：
   * 落库的 `goal` 是「这次经营做了什么」的唯一文字记录，它必须由一处生成 ——
   * 否则将来多一个入口（比如从 App 发起）就会出现第二种拼法，
   * 历史记录里混着两种格式，排查时无法判断哪种才是当前的。
   * 对话框用的 `buildBusinessGoalText` 是同一个函数，只用于**实时预览**。
   */
  const goalDraft = buildBusinessGoalText({
    goal: target,
    productName: primaryProduct?.name ?? null,
    targetAudience,
    channels,
    fullChain: options.fullChain === true,
  });
  if (goalDraft.tooLong) {
    return fail(
      "VALIDATION_FAILED",
      `经营目标连同补充信息不能超过 ${MAX_BUSINESS_GOAL_LENGTH} 字`,
      `当前 ${goalDraft.length} 字。请精简目标描述，或减少勾选的渠道。`,
    );
  }
  /** 落库与送模型的最终文本 */
  const finalGoal = goalDraft.text;

  // 4. 并发保护
  const running = await attempt(
    () => findRunningWorkflow(repositories),
    (cause) => toAppError(cause, "DB_ERROR", "读取运行中的经营计划失败"),
  );
  if (!running.ok) {
    return running;
  }
  if (running.data && !isStaleRunning(running.data, new Date())) {
    const sameGoal = running.data.goal.trim() === finalGoal;
    return fail(
      "RATE_LIMITED",
      sameGoal
        ? "这个经营目标正在执行中，请等它结束再试"
        : "当前已有另一个经营计划在执行，请等它结束再试",
      `运行中的工作流 ${running.data.id}（目标：${running.data.goal}）开始于 ${running.data.createdAt}`,
    );
  }

  // 5. 调 Business Brain（Agent 内部含两层纠错：Schema 层 + 计划合法性层）
  const providerStatus = getAIProviderStatus();
  const startedAt = Date.now();
  const brainInput: BusinessBrainInput = {
    goal: finalGoal,
    products: context.products,
    hasBrandProfile: context.hasBrandProfile,
    hasOwnerTwin: context.hasOwnerTwin,
    /**
     * S4-2 的三个业务输入。全部是**可选**的（`undefined` / 空数组时
     * `renderBusinessContextBlock` 会渲染成 null / []），
     * 因此不传它们时的行为与 S4-1 逐字一致。
     */
    primaryProductId,
    channels: channels.map((channel) => ({
      platform: channel.platform,
      format: channel.format,
    })),
    targetAudience,
    fullChain: options.fullChain === true,
  };

  /**
   * 前置检查：把「注定失败的调用」挡在**建记录之前**。
   * 同 `hasContentGrounding` 的做法 —— 失败就不该在库里留下痕迹。
   */
  if (!hasPlannableInput(brainInput)) {
    return fail(
      "VALIDATION_FAILED",
      "缺少可用于规划的信息",
      "至少需要一件名称完整的商品。",
    );
  }

  const brain = await runBusinessBrain(brainInput, {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  /**
   * 规划失败 → **不创建工作流记录**。
   * 没有计划可存，建一条空记录只会让历史里多出一条看不懂的失败。
   * 失败原因通过返回值如实交给调用方。
   */
  if (!brain.ok) {
    return brain;
  }

  const durationMs = Date.now() - startedAt;

  // 6. 落库：状态 idle（等着被启动），plan 存整份计划快照
  const created = await attempt(
    () =>
      repositories.agentWorkflows.create({
        businessId: context.businessId,
        // 落库的是**组装后的完整目标**：它是这段历史的唯一文字记录，
        // 只存商家原话会让「当时到底推广的是哪件商品、发哪些渠道」查不出来
        goal: finalGoal,
        status: "idle",
        plan: toStoredBusinessPlan(brain.data.plan),
      }),
    (cause) => toAppError(cause, "DB_ERROR", "保存经营计划失败"),
  );
  if (!created.ok) {
    return created;
  }

  /**
   * 复用预判：与执行时同一个判定函数、同一份快照。
   *
   * 放在落库之后，是因为它读的是**最终那份计划**（可能经过两层纠错），
   * 而不是模型第一次给出的版本 —— 预判必须对得上商家将要确认的那份计划。
   */
  const reuseDecisions = resolveReusableTasks(brain.data.plan.tasks, context.snapshot);
  const reusableTaskIds = [...reuseDecisions.keys()];
  const executableCount = brain.data.plan.tasks.length - reusableTaskIds.length;
  const expectedContentCount = brain.data.plan.tasks.filter(
    (task) => task.agent === "content_agent" && !reuseDecisions.has(task.id),
  ).length;

  return ok({
    workflowId: created.data.id,
    plan: brain.data.plan,
    providerId: brain.data.providerId,
    isMock: providerStatus.isMock,
    attempts: brain.data.attempts,
    planRounds: brain.data.planRounds,
    repaired: brain.data.repaired,
    warnings: [...brain.data.warnings],
    durationMs,
    durationText: formatDurationMs(durationMs),
    context: context.view,
    reusePreview: {
      reusableTaskIds,
      executableCount,
      reusableCount: reusableTaskIds.length,
      expectedContentCount,
      /**
       * 每个要执行的任务至少一次模型调用。**刻意不把纠错重试算进去**：
       * 重试次数取决于模型表现，事前无法知道；给一个拍出来的数
       * 只会让商家在账单对不上时觉得被糊弄。文案上它是「至少」。
       */
      estimatedModelCalls: executableCount,
    },
    primaryProductId,
    channels,
  });
}

/* ------------------------------------------------------------------ */
/* 写入：执行 / 重试                                                   */
/* ------------------------------------------------------------------ */

/**
 * 跑一轮计划。
 *
 * 为什么执行前要**重新复核计划**，而不信「规划时已经校验过」：
 * 规划与执行之间可能隔着很久（商家看了半天才点确认）。期间商品可能被删掉，
 * 那样计划里的引用就断了。此时正确反应是**拒绝启动并说明原因**，
 * 而不是让它跑一半才失败 —— 前者只浪费商家一次点击，后者会白白花掉半轮模型调用。
 */
async function executeStoredPlan(
  workflow: AgentWorkflowRecord,
  plan: BusinessPlanDraft,
  options: BusinessBrainServiceOptions,
  retried: boolean,
): Promise<Result<WorkflowRunView>> {
  const repositories = getRepositories();

  // 1. 取当前状态快照（复用判定必须基于「现在」的现状）
  const loaded = await attempt(
    () => loadPlanningContext(repositories),
    (cause) => toAppError(cause, "DB_ERROR", "加载经营现状失败"),
  );
  if (!loaded.ok) {
    return loaded;
  }
  const context = loaded.data;
  const previousSummary = toWorkflowSummary(workflow.summary);
  const previousAgentTasks = retried
    ? await repositories.agentTasks.listByWorkflow(workflow.id)
    : [];
  const completedTaskIds = retried
    ? new Set(
        plan.tasks
          .filter((task) => {
            const summaryStep = previousSummary?.steps?.find(
              (step) => step.taskId === task.id,
            );
            return (
              summaryStep?.outcome === "executed" ||
              summaryStep?.outcome === "reused" ||
              previousAgentTasks.some((record) =>
                matchesCompletedAgentTask(task, record),
              )
            );
          })
          .map((task) => task.id),
      )
    : undefined;

  // 2. 复核计划：引用同一批商品，规则与规划时完全一致（同一个校验器）
  const validation = validateBusinessPlan(plan, {
    availableProductIds: context.products.map((product) => product.id),
  });
  if (!validation.ok) {
    const reasons = validation.violations
      .map((violation) => violation.message)
      .join("；");
    return fail(
      "PLAN_INVALID",
      "这份计划已经不能执行了（可能是商品被删除或改动过）",
      `${reasons}。请重新制定一份计划。`,
    );
  }

  // 3. 执行
  const startedAt = Date.now();
  /**
   * brand_agent 的兜底锚点：计划里第一个出现的目标商品（本次经营任务
   * 显然围绕它展开），否则退回全店第一件商品。全店无商品时传 null，
   * 执行器会把品牌步骤按「缺依据」明确失败，而不是撞上含糊的参数错误。
   */
  const brandFallbackProductId =
    plan.tasks.find((task) => task.productId)?.productId ??
    context.products[0]?.id ??
    null;
  const run = await runBusinessWorkflow({
    workflowId: workflow.id,
    plan,
    state: {
      ...context.snapshot,
      ...(completedTaskIds ? { completedTaskIds } : {}),
    },
    agentWorkflows: repositories.agentWorkflows,
    runner: createTaskRunner({
      workflowId: workflow.id,
      brandFallbackProductId,
      ...(options.provider ? { provider: options.provider } : {}),
    }),
    ...(options.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: options.maxConcurrency }),
    ...(options.taskTimeoutMs === undefined
      ? {}
      : { taskTimeoutMs: options.taskTimeoutMs }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!run.ok) {
    return run;
  }

  const durationMs = Date.now() - startedAt;

  return ok({
    workflowId: workflow.id,
    status: run.data.status,
    summary: run.data.summary,
    errorMessage: run.data.errorMessage,
    tasks: run.data.tasks,
    durationMs,
    durationText: formatDurationMs(durationMs),
    retried,
  });
}

/**
 * 启动一份**尚未执行**的计划。
 *
 * 只接受 `idle`。已经跑过的用 `retryWorkflow`（语义与文案都不同：
 * 一个是「开始执行」，一个是「重跑没成的部分」），正在跑的等它结束
 * （「运行中」与「运行中且未过期」要分开说，否则商家不知道是等一会儿还是重试）。
 */
export async function startBusinessWorkflow(
  workflowId: unknown,
  options: BusinessBrainServiceOptions = {},
): Promise<Result<WorkflowRunView>> {
  const parsed = parseWorkflowId(workflowId);
  if (!parsed.ok) {
    return parsed;
  }

  const repositories = getRepositories();
  const found = await attempt(
    () => repositories.agentWorkflows.findById(parsed.data),
    (cause) => toAppError(cause, "DB_ERROR", "加载经营计划失败"),
  );
  if (!found.ok) {
    return found;
  }
  const workflow = found.data;
  if (!workflow) {
    return fail("NOT_FOUND", "经营计划不存在", `workflowId=${parsed.data}`);
  }

  if (workflow.status === "running") {
    return fail(
      "RATE_LIMITED",
      isStaleRunning(workflow, new Date())
        ? "上一轮执行看起来已经中断，请稍后重试"
        : "这份计划正在执行中，请等它结束",
      `工作流 ${workflow.id} 开始于 ${workflow.createdAt}`,
    );
  }
  if (workflow.status !== "idle") {
    return fail(
      "VALIDATION_FAILED",
      "这份计划已经执行过了",
      "如需重跑没成功的部分，请使用「重试」。",
    );
  }

  const plan = parseStoredBusinessPlan(workflow.plan);
  if (!plan) {
    return fail(
      "SCHEMA_INVALID",
      "这份计划已无法读取",
      "计划内容为空或格式已过期（可能是旧版本写入的）。请重新制定一份计划。",
    );
  }

  return executeStoredPlan(workflow, plan, options, false);
}

/**
 * 重跑一份**没能全部成功**的计划。
 *
 * 这里没有「只挑失败的任务跑」这种精细逻辑，也**不需要**：
 * 复用判定（`resolveReusableTasks`）会看着当前现状把已经拿到结果的步骤标成 `reused`，
 * 于是真正被执行的只有没成的那几步。这样做的好处是只有一条执行路径要维护 ——
 * 手工挑任务重跑，迟早会出现「重试路径与首次执行路径行为不一致」这类最难查的问题。
 */
export async function retryWorkflow(
  workflowId: unknown,
  options: BusinessBrainServiceOptions = {},
): Promise<Result<WorkflowRunView>> {
  const parsed = parseWorkflowId(workflowId);
  if (!parsed.ok) {
    return parsed;
  }

  const repositories = getRepositories();
  const found = await attempt(
    () => repositories.agentWorkflows.findById(parsed.data),
    (cause) => toAppError(cause, "DB_ERROR", "加载经营计划失败"),
  );
  if (!found.ok) {
    return found;
  }
  const workflow = found.data;
  if (!workflow) {
    return fail("NOT_FOUND", "经营计划不存在", `workflowId=${parsed.data}`);
  }

  if (workflow.status === "running" && !isStaleRunning(workflow, new Date())) {
    return fail(
      "RATE_LIMITED",
      "这份计划正在执行中，请等它结束",
      `工作流 ${workflow.id} 开始于 ${workflow.createdAt}`,
    );
  }
  if (workflow.status === "idle") {
    return fail(
      "VALIDATION_FAILED",
      "这份计划还没有执行过",
      "请先执行它，再考虑重试。",
    );
  }
  if (workflow.status === "completed") {
    /**
     * 全部成功的计划没有可重跑的东西。想刷新某个商品的内容或分析，
     * 请到内容工厂 / 商品详情页手动触发 —— 那是商家的明确意图，
     * 而这里只负责「把没成的补上」。
     */
    return fail(
      "VALIDATION_FAILED",
      "这一轮已经全部完成，无需重试",
      "如需刷新，请在内容工厂或商品详情页手动重新生成。",
    );
  }
  /**
   * 走到这里的合法状态：`failed` / `partially_completed` / `cancelled`，
   * 以及**已过期的 `running`**（进程中断留下的孤儿 —— 它其实等同于「上一轮断了」，
   * 不放行的话商家会被永久卡住，那才是最糟的结果）。
   */

  const plan = parseStoredBusinessPlan(workflow.plan);
  if (!plan) {
    return fail(
      "SCHEMA_INVALID",
      "这份计划已无法读取，无法重试",
      "计划内容为空或格式已过期（可能是旧版本写入的）。请重新制定一份计划。",
    );
  }

  return executeStoredPlan(workflow, plan, options, true);
}

/**
 * 开发模式下的「一次性跑完」入口（S4-1 临时）。
 *
 * 正式界面（S4-2）要走「规划 → 商家确认执行 → 执行」，因此这里刻意取了
 * 「一步都不能少」的名字：谁在业务代码里用了它，一眼就能看出这是抄近路。
 * 它只服务于本地验证与集成测试。
 */
export async function planAndRunBusinessGoal(
  goal: unknown,
  options: BusinessBrainServiceOptions = {},
): Promise<Result<WorkflowRunView>> {
  const planned = await createBusinessPlan(goal, options);
  if (!planned.ok) {
    return planned;
  }
  return startBusinessWorkflow(planned.data.workflowId, options);
}

/* ------------------------------------------------------------------ */
/* 读取：工作流状态                                                    */
/* ------------------------------------------------------------------ */

/** 把计划任务的信息与逐步报告合成界面视图 */
function toStepViews(
  plan: StoredBusinessPlan | null,
  summary: AgentWorkflowSummary | null,
): BusinessWorkflowStepView[] {
  const reportByTaskId = new Map(
    (summary?.steps ?? []).map((step) => [step.taskId, step]),
  );

  // 计划是「有哪些步骤」的权威来源，因此以它为准生成视图
  return (plan?.tasks ?? []).map((task) => {
    const report = reportByTaskId.get(task.id);
    return {
      taskId: task.id,
      agent: task.agent,
      title: task.title,
      reason: task.reason,
      productId: task.productId,
      platform: task.platform,
      format: task.format,
      outcome: report?.outcome ?? "pending",
      status: report?.status ?? null,
      note: report?.note ?? null,
      blockedBy: report?.blockedBy ?? [],
      outputRef: report?.outputRef ?? null,
      durationMs: report?.durationMs ?? null,
    } satisfies BusinessWorkflowStepView;
  });
}

/**
 * 读取某一轮工作流的状态；不传 id 时取「最近一轮」。
 *
 * 何时返回 `ok(null)`：库里一条工作流都没有。这不是错误 ——
 * 「还没规划过」是正常的初始状态，界面据此进入空态。
 */
export async function getWorkflowState(
  workflowId?: unknown,
): Promise<Result<BusinessWorkflowState | null>> {
  const repositories = getRepositories();

  return attempt(
    async () => {
      let workflow: AgentWorkflowRecord | null = null;
      if (workflowId === undefined || workflowId === null || workflowId === "") {
        workflow =
          (await findRunningWorkflow(repositories)) ??
          (await repositories.agentWorkflows.listRecent(1))[0] ??
          null;
      } else {
        const parsed = parseWorkflowId(workflowId);
        if (!parsed.ok) {
          return null;
        }
        workflow = await repositories.agentWorkflows.findById(parsed.data);
      }
      if (!workflow) {
        return null;
      }

      const plan = parseStoredBusinessPlan(workflow.plan);
      const summary = toWorkflowSummary(workflow.summary);
      const agentTasks = await repositories.agentTasks.listByWorkflow(workflow.id);
      const running = workflow.status === "running";
      const stale = running ? isStaleRunning(workflow, new Date()) : false;
      const isRunning = running && !stale;

      return {
        workflow,
        plan,
        summary,
        steps: toStepViews(plan, summary),
        agentTasks,
        isRunning,
        isStale: stale,
        canStart: workflow.status === "idle",
        /**
         * `completed` 不可重试（没有可补的东西）；`idle` 不可重试（该用「执行」）。
         * 已过期的 `running` **可以**重试 —— 它其实是「上一轮断了」，
         * 不放行会让商家永久卡住。
         */
        canRetry:
          !isRunning &&
          workflow.status !== "idle" &&
          workflow.status !== "completed",
        provider: getAIProviderStatus(),
      } satisfies BusinessWorkflowState;
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载经营计划状态失败"),
  );
}
