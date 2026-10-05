/**
 * 服务层：AI 经营驾驶舱的数据入口（S4-2 重写）
 *
 * 与 S0 版本的**根本差别**：那时驾驶舱读的是两份预置的演示数据
 * （`MOCK_AGENT_EMPLOYEES` + `MOCK_WORKFLOW`），页面看着很热闹，
 * 却与商家真实做过的事没有任何关系 —— 点一次「启动今日经营」，
 * 界面上的进度条照样往前爬，纯属演的。
 *
 * 现在分成三类数据，边界写在类型里，也写在界面上：
 *
 * 1. **真实数据**（本文件自己装配，来源是 S4-1 落库的表）：
 *    `agentStates`（各 AI 员工最近一次任务）、`activeWorkflow` / `recentWorkflows`
 *    （`agent_workflows` + `plan` + `summary`）、`workflowStats`、`planningProducts`。
 * 2. **演示数据**（仍是 Mock，界面上明确标注）：经营指标、趋势、直播、经营日报、
 *    经营目标 —— 这些领域本轮没有接（任务书第三十四条明确禁止做 Analytics / Live）。
 * 3. **不可用**：当前数据源下该领域连 Mock 都没有（如 `DATA_SOURCE=db` 时的
 *    直播 / 分析仓储），此时**如实报不可用**，绝不静默给一份空数据让商家
 *    以为「今天没生意」。
 *
 * 三条纪律：
 * - **页面不拼数据**：`page.tsx` 只拿这一份 `DashboardOverview`，不允许它自己
 *   去调仓储或做跨域聚合，否则「一个页面一种口径」是迟早的事。
 * - **员工状态一律由任务推出**。名册（`@/lib/agents`）只回答「这个员工是谁、
 *   能不能干活」；「他现在在不在忙」必须来自 `agent_tasks`。
 *   由此得到一个重要的安全性质：**未接入的 Agent 的状态恒为 `idle`**，
 *   不可能显示成「运行中」—— 假 Agent 在类型层面就构造不出来。
 * - **进度只用真实步数**。绝不出产百分比（任务书 §12）。
 */

import { getAIProviderStatus, type AIProviderStatus } from "@/ai/provider";
import { BUSINESS_BRAIN_PROFILE, EXECUTOR_AGENT_PROFILES } from "@/lib/agents";
import { formatDurationMs } from "@/lib/datetime";
import { attempt, toAppError, type Result } from "@/lib/result";
import {
  getDataSourceStatus,
  getRepositories,
  type AgentTaskRecord,
  type DataSourceStatus,
  type Repositories,
} from "@/repositories";
import { toWorkflowSummary } from "@/repositories/agent-workflow";
import { parseStoredBusinessPlan, type StoredBusinessPlan } from "@/ai";
import { WORKFLOW_STATUS_META } from "@/lib/status-meta";
import {
  summarizeWorkflowOutcome,
  toWorkflowProgress,
  type WorkflowOutcomeSummary,
  type WorkflowProgress,
} from "@/lib/workflow-display";
import type {
  AgentAccent,
  AgentId,
  AgentStatus,
  BusinessGoal,
  BusinessReport,
  IconComponent,
  LiveComment,
  LiveSession,
  LiveStats,
  OverviewMetric,
  Product,
  ProductAnalysisStatus,
  TrendPoint,
  WorkflowStatus,
} from "@/types";

import type { AgentWorkflowRecord } from "@/repositories/types";

import { getCustomerServiceOverview } from "./customer-service";
import { getCurrentAuthUser } from "./auth.service";

/** 判定「孤儿工作流」的阈值。与编排层的 `WORKFLOW_RUNNING_STALE_MS` 同一个数 */
const RUNNING_STALE_MS = 10 * 60 * 1000;

/**
 * 统计口径里最多回看多少条工作流。
 *
 * 刻意不给「全部历史」：`agent_workflows` 会一直增长，而驾驶舱上的
 * 「最近经营任务」只需要一个近期口径。把窗口写进注释与界面文案里
 * （「最近 50 轮」），商家才知道这个数字是怎么来的 ——
 * 一个不写清口径的统计数字，迟早会被当成全量而对不上账。
 */
export const WORKFLOW_STATS_WINDOW = 50;

/** 最近任务列表展示条数 */
export const RECENT_WORKFLOW_LIMIT = 5;

/** 计划对话框里最多列多少件商品（列表太长会让下拉框本身变成负担） */
const MAX_PLANNING_PRODUCT_OPTIONS = 50;

/* ------------------------------------------------------------------ */
/* 视图类型                                                            */
/* ------------------------------------------------------------------ */

/**
 * AI 员工卡片数据 = 静态名册 + 真实运行时状态。
 *
 * 绝不复用 S0 的 `AgentEmployee`：那个类型把 `status` / `currentTask` / `lastRunAt`
 * 定义成必填，于是「演示态」被固化进了常量类型。现在静态与动态分开声明，
 * 「拿常量当状态」这件事在编译期就不可能发生。
 */
export interface DashboardAgentState {
  /* —— 来自名册（常量） —— */
  id: AgentId;
  name: string;
  role: string;
  description: string;
  icon: IconComponent;
  accent: AgentAccent;
  skills: readonly string[];
  supervisor: boolean;
  available: boolean;
  unavailableNote: string;

  /* —— 来自 agent_tasks（真实） —— */
  /** 运行状态；`available=false` 时恒为 `idle` */
  status: AgentStatus;
  /**
   * 覆盖状态徽标的默认文案。
   *
   * 只有客服需要它：通用的「已完成 / 执行中」描述的是**一次任务**，
   * 而客服卡片要回答的是「这位员工现在提供的服务正不正常」——
   * running → 正在服务、completed → 最近服务正常、failed → 最近一次服务异常。
   * 不设时用 `AGENT_STATUS_META` 的通用文案。
   */
  statusLabel?: string;
  /** 点击卡片跳转的工作台入口；没有独立工作台的员工不设 */
  href?: string;
  /**
   * 客服专属经营指标（仅智能客服卡片有）。
   *
   * `null` 与 `undefined` 含义不同：undefined = 这张卡片不适用；
   * null = 适用但读取失败，卡片要如实显示「指标暂不可用」而不是装作没有。
   * 注意它**绝不影响** status —— 待人工会话多寡是业务提醒，
   * 不是这位 AI 员工执行失败（任务书第二十七节）。
   */
  customerServiceMetrics?: {
    todayAnsweredCount: number;
    needsHumanConversationCount: number;
    openKnowledgeGapCount: number;
  } | null;
  /** 最近一次任务标题；从未跑过为 null（界面显示「暂无任务」而不是编一条） */
  currentTask: string | null;
  /** 最近一次任务的开始时间（展示字符串） */
  lastRunAt: string | null;
  /** 最近一次任务的结果摘要；成功取产出、失败取原因 */
  lastRunSummary: string | null;
  /** 该 Agent 是否已经产生过任务记录 */
  hasHistory: boolean;
}

/**
 * 工作流列表项（驾驶舱的「最近 AI 经营任务」与 Business Brain 卡片共用）。
 *
 * `progress` 是**真实步数**（结局已定的步数 / 计划步数），不是百分比估算。
 */
export interface DashboardWorkflowListItem {
  id: string;
  goal: string;
  status: WorkflowStatus;
  statusLabel: string;
  progress: WorkflowProgress;
  outcome: WorkflowOutcomeSummary;
  createdAt: string;
  completedAt: string | null;
  /** 端到端耗时；未收尾为 null */
  durationText: string | null;
  /** 涉及的商品名（按计划顺序去重，最多 3 个） */
  productNames: string[];
  /** 面向商家的一句话结果说明；一切顺利为 null */
  errorMessage: string | null;
  /** running 但已超过阈值 —— 进程中断留下的孤儿，界面要提示「可能已中断」 */
  isStale: boolean;
  /** 计划里有没有内容任务（决定结果卡片是否展示「查看内容」入口） */
  hasContentTask: boolean;
}

/**
 * AI 经营大脑卡片。
 *
 * `phase` 用四个值而不是任务书里的「空闲 / 规划中 / 执行中」三个：
 * 真正的「规划中」是一次同步请求的**瞬时状态**（对话弹窗里才看得到），
 * 落库后不可能被查询到 —— 把它做成一个查得到的状态，只能是编的。
 * 因此落库态里最接近的是「计划已生成、等商家确认」，
 * 它单列成 `awaiting_confirmation`，比笼统地叫「规划中」信息量更大。
 */
export type BusinessBrainPhase =
  | "idle"
  | "awaiting_confirmation"
  | "executing"
  | "interrupted";

export interface DashboardBusinessBrainState {
  name: string;
  role: string;
  description: string;
  icon: IconComponent;
  skills: readonly string[];
  phase: BusinessBrainPhase;
  /** 当前（或最近一轮）的经营目标 */
  goal: string | null;
  /** 正在执行那一轮的进度；不在执行时为 null */
  progress: WorkflowProgress | null;
  /** 最近一次工作流的状态（含 `idle`） */
  lastStatus: WorkflowStatus | null;
  lastCompletedAt: string | null;
  /** 可以点「启动今日经营」——没有正在跑的计划 */
  canLaunch: boolean;
  /** 当前工作流 id（查看详情用） */
  workflowId: string | null;
  provider: AIProviderStatus;
}

/** 计划对话框用的商品选项（不暴露仓储，页面只拿这一份） */
export interface DashboardProductOption {
  id: string;
  name: string;
  category: string;
  /** 是否已有商品理解 —— 对话框据此预告「这一步会复用」 */
  hasDna: boolean;
  analysisStatus: ProductAnalysisStatus;
}

/** 近期工作流统计（口径：最近 `WORKFLOW_STATS_WINDOW` 轮） */
export interface DashboardWorkflowStats {
  windowSize: number;
  total: number;
  completed: number;
  partiallyCompleted: number;
  failed: number;
  running: number;
  idle: number;
  /** 累计真实执行的任务数 */
  executedTasks: number;
  /** 累计复用的任务数（本次没有再次调用 AI） */
  reusedTasks: number;
}

/** Knowledge Gap 提醒里的单条缺口（驾驶舱只展示这三样，别把整条记录搬过来） */
export interface DashboardKnowledgeGapItem {
  id: string;
  /** 最近一次提问原话 */
  question: string;
  /** 被问次数 —— 商家据此判断先补哪条 */
  occurrenceCount: number;
}

/**
 * 驾驶舱的智能客服经营指标（Task 81）。
 *
 * 口径与 `CustomerServiceOverview` 完全一致 —— 驾驶舱**不做第二次统计**，
 * 只是同一个 Service 结果的投影。两处口径分叉的那天，
 * 商家就会在两个页面看到两个「今日回答数」。
 */
export interface DashboardCustomerServiceState {
  todayAnsweredCount: number;
  todayGroundedCount: number;
  /** 今日 Grounded 率；今日没有 AI 回答时为 null（不是 0） */
  groundedRate: number | null;
  needsHumanConversationCount: number;
  openKnowledgeGapCount: number;
  totalKnowledgeDocuments: number;
  indexedKnowledgeDocuments: number;
  /** 最多 3 条待补缺口，排序复用 Task 78 规则（仓储已排好） */
  topGaps: DashboardKnowledgeGapItem[];
}

/**
 * 当前数据源下不可用的区块。
 *
 * 存在的理由：`DATA_SOURCE=db` 时直播 / 分析等仓储会抛 NOT_IMPLEMENTED。
 * 老实现会让**整页 500** —— 那是把「一个区块没有数据」放大成「整个驾驶舱用不了」。
 * 现在降级为空，但把区块名列出来，界面据此显示「该区块在当前数据源下不可用」。
 * 这与「静默降级」的差别就在这个列表上：降级是允许的，**不告诉用户**才是问题。
 */
export type DashboardSectionId =
  | "metrics"
  | "trend"
  | "live"
  | "dailyReport"
  | "businessGoal"
  | "customerService";

/** AI 经营驾驶舱所需的全部数据 */
export interface DashboardOverview {
  /* —— 真实数据 —— */
  agentStates: DashboardAgentState[];
  businessBrain: DashboardBusinessBrainState;
  /** 正在执行（且未被视为孤儿）的那一轮 */
  activeWorkflow: DashboardWorkflowListItem | null;
  recentWorkflows: DashboardWorkflowListItem[];
  workflowStats: DashboardWorkflowStats;
  planningProducts: DashboardProductOption[];
  /**
   * 智能客服经营指标（Task 81）。
   *
   * 这是**辅助指标**：读取失败只降级为 null 并记入 `unavailableSections`，
   * 不拖垮整个驾驶舱（任务书第十四节）；而客服 Agent 卡片的**状态**
   * 来自 `agent_tasks`，走真实数据的硬失败路径，两者互不影响。
   */
  customerService: DashboardCustomerServiceState | null;

  /* —— 仍是演示数据 —— */
  metrics: OverviewMetric[];
  trend: TrendPoint[];
  spotlightProduct: Product | null;
  productCount: number;
  liveSession: LiveSession | null;
  liveStats: LiveStats | null;
  liveComments: LiveComment[];
  /**
   * 最新一份 **AI 经营日报**（S6-B 起为真实产出）。
   *
   * 以前这里返回的是 `MOCK_DAILY_REPORT` 常量 —— 一份「看起来是 AI 生成的」
   * 固定文本。经营日报已改为真的跑一次 Analytics Agent 并落库，
   * 因此**从未生成过时它就是 null**，界面显示「尚未生成」而不是一份假日报。
   */
  dailyReport: BusinessReport | null;
  businessGoal: BusinessGoal | null;

  /* —— 诚实标注 —— */
  dataSource: DataSourceStatus;
  unavailableSections: DashboardSectionId[];
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/** running 且已超过阈值 → 视为进程中断留下的孤儿 */
function isStaleRunning(
  workflow: AgentWorkflowRecord,
  now: number,
): boolean {
  if (workflow.status !== "running") {
    return false;
  }
  const startedAt = workflow.createdAt ? new Date(workflow.createdAt).getTime() : NaN;
  // 时间不可解析时按过期处理：卡住不放行比误放行更糟（商家会一直点不动按钮）
  return !Number.isFinite(startedAt) || now - startedAt > RUNNING_STALE_MS;
}

/** 时间差 → 「12.4s」；无法计算时为 null */
function toDurationText(
  startedAt: string,
  completedAt: string | null,
): string | null {
  if (!completedAt) {
    return null;
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return formatDurationMs(end - start);
}

/**
 * 计划里涉及的商品名（按计划顺序去重，最多 3 个）。
 *
 * 用「商品名」而不是 id：驾驶舱是给经营者看的，
 * 一排 `prod_001` 对他没有任何意义。
 */
function toProductNames(
  plan: StoredBusinessPlan | null,
  nameById: ReadonlyMap<string, string>,
): string[] {
  if (!plan) {
    return [];
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const task of plan.tasks) {
    if (!task.productId || seen.has(task.productId)) {
      continue;
    }
    const name = nameById.get(task.productId);
    if (!name) {
      continue;
    }
    seen.add(task.productId);
    names.push(name);
  }
  return names.slice(0, 3);
}

/**
 * 逐条工作流 → 列表项。
 *
 * 复用 `@/repositories/agent-workflow` 的 `toWorkflowSummary` 读摘要：
 * jsonb 读回来的是 `unknown`，需要运行时校验（库里可能留着旧版本的结构）。
 * 读不出来时 `summary` 为 null，此时进度退化为「全部待定」而不是「全部完成」——
 * 宁可显示得保守，也不要给出一个没有依据的完成度。
 */
function toWorkflowListItem(params: {
  workflow: AgentWorkflowRecord;
  nameById: ReadonlyMap<string, string>;
  now: number;
}): DashboardWorkflowListItem {
  const { workflow, nameById, now } = params;
  const plan = parseStoredBusinessPlan(workflow.plan);
  const summary = toWorkflowSummary(workflow.summary);
  const reportByTaskId = new Map(
    (summary?.steps ?? []).map((step) => [step.taskId, step]),
  );

  /**
   * 计划是「有哪些步骤」的权威来源，逐步报告是「每步怎么落地的」权威来源。
   * 没有报告就是 `pending` —— 包括正在跑的那一轮（摘要要等整轮结束才写库），
   * 因此运行中的列表项进度会显示为 0/N。这是**真实的**：库里确实还没有结果。
   * 实时的「第几步在跑」由轮询对话框负责（它读的是 `agent_tasks`）。
   */
  const steps =
    plan?.tasks.map((task) => ({
      agent: task.agent as string,
      outcome: reportByTaskId.get(task.id)?.outcome ?? ("pending" as const),
    })) ?? [];

  const progress = toWorkflowProgress(
    steps.map((step) => ({ outcome: step.outcome, status: null })),
  );

  return {
    id: workflow.id,
    goal: workflow.goal,
    status: workflow.status,
    statusLabel: WORKFLOW_STATUS_META[workflow.status].label,
    progress,
    outcome: summarizeWorkflowOutcome({ summary, steps }),
    createdAt: workflow.createdAt,
    completedAt: workflow.completedAt,
    durationText: toDurationText(workflow.createdAt, workflow.completedAt),
    productNames: toProductNames(plan, nameById),
    errorMessage: workflow.errorMessage,
    isStale: isStaleRunning(workflow, now),
    hasContentTask:
      plan?.tasks.some((task) => task.agent === "content_agent") ?? false,
  };
}

/** 搜索历史任务时，显式核对归属；记录不属于当前商户时不返回任何详情。 */
export async function getDashboardWorkflow(id: string): Promise<Result<DashboardWorkflowListItem | null>> {
  return attempt(async () => {
    const user = await getCurrentAuthUser();
    if (!user || !id || id.length > 64) return null;
    const repositories = getRepositories();
    const workflow = await repositories.agentWorkflows.findById(id);
    if (!workflow || workflow.businessId !== user.businessId) return null;
    const products = await repositories.products.list();
    return toWorkflowListItem({ workflow, nameById: new Map(products.map(item => [item.id, item.name])), now: Date.now() });
  }, cause => toAppError(cause, "DB_ERROR", "暂时无法查看这条经营任务"));
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/** 各 AI 员工「最近一次任务」的读取（仅对已接入的 Agent 发起） */
async function loadAgentStates(repositories: Repositories): Promise<{
  states: DashboardAgentState[];
  tasksByAgent: Map<AgentId, AgentTaskRecord>;
}> {
  const tasksByAgent = new Map<AgentId, AgentTaskRecord>();

  /** 只查已接入的 Agent；当前六位均可执行，保留过滤便于未来灰度下线。 */
  const queryable = EXECUTOR_AGENT_PROFILES.filter((profile) => profile.available);

  await Promise.all(
    queryable.map(async (profile) => {
      /**
       * 单个 Agent 的查询失败**不影响其它卡片**：一位员工的历史读不出来，
       * 不该让另外五张卡片一起变成空态。失败即视为「没有记录」，
       * 卡片显示「暂无任务」—— 与「确实没跑过」在界面上是同一句话，
       * 而这句话在此刻是**成立**的（读不到就可以说没有）。
       */
      const latest = await repositories.agentTasks
        .findLatestByType(profile.id)
        .catch(() => null);
      if (latest) {
        tasksByAgent.set(profile.id, latest);
      }
    }),
  );

  const states: DashboardAgentState[] = EXECUTOR_AGENT_PROFILES.map((profile) => {
    const task = profile.available ? tasksByAgent.get(profile.id) : undefined;

    return {
      id: profile.id,
      name: profile.name,
      role: profile.role,
      description: profile.description,
      icon: profile.icon,
      accent: profile.accent,
      skills: profile.skills,
      supervisor: profile.supervisor,
      available: profile.available,
      unavailableNote: profile.unavailableNote,

      /**
       * 未接入 → 恒为 `idle`。
       * 这不是「碰巧没跑」，而是**能力不存在**；给它们任何别的状态都会造出假 Agent。
       * 界面靠 `available=false` 显示「待接入」，而不是靠 status。
       */
      status: task?.status ?? "idle",
      currentTask: task?.title ?? null,
      lastRunAt: task?.createdAt ?? null,
      lastRunSummary: task
        ? task.status === "failed"
          ? (task.errorMessage ?? "上次执行失败，可重新触发。")
          : task.status === "running"
            ? "正在执行中…"
            : task.status === "queued"
              ? "已排队，等待执行。"
              : "最近一次执行已完成。"
        : null,
      hasHistory: task !== undefined,
    };
  });

  return { states, tasksByAgent };
}

/**
 * 读取驾驶舱所需的全部数据。
 *
 * 失败语义：
 * - **真实业务数据**（商品 / 工作流 / 任务）读取失败 → 整体失败。
 *   这些是驾驶舱的主体，读不到就没法如实呈现，不该装作没事。
 * - **演示 / 装饰性区块**（指标、趋势、直播、日报、目标）读取失败 → 降级为空，
 *   并把区块名记进 `unavailableSections`，由界面显示「当前数据源下不可用」。
 */
export async function getDashboardOverview(): Promise<Result<DashboardOverview>> {
  return attempt(
    async () => {
      const repositories = getRepositories();
      const now = Date.now();
      const unavailableSections: DashboardSectionId[] = [];

      /** 装饰性区块：读失败就降级并记账，不让整页跟着挂掉 */
      async function optional<T>(section: DashboardSectionId, load: () => Promise<T>, fallback: T): Promise<T> {
        const result = await attempt(load);
        if (result.ok) {
          return result.data;
        }
        unavailableSections.push(section);
        return fallback;
      }

      const [
        allProducts,
        workflows,
        agentStateResult,
        customerService,
        metrics,
        trend,
        liveSession,
        liveStats,
        liveComments,
        dailyReport,
        businessGoal,
      ] = await Promise.all([
        repositories.products.list(),
        repositories.agentWorkflows.listRecent(WORKFLOW_STATS_WINDOW),
        loadAgentStates(repositories),
        optional(
          "customerService",
          async (): Promise<DashboardCustomerServiceState> => {
            /**
             * 抛错（而不是返回 Result）是刻意的：`optional` 靠捕获异常记账降级。
             * 这里最可能的失败是「商家档案还没建立」（全新库、没跑 seed）——
             * 那确实是客服指标暂不可用，如实降级即可。
             */
            const overview = await getCustomerServiceOverview();
            if (!overview.ok) {
              throw overview.error;
            }
            const data = overview.data;
            return {
              todayAnsweredCount: data.todayAnsweredCount,
              todayGroundedCount: data.todayGroundedCount,
              groundedRate: data.groundedRate,
              needsHumanConversationCount: data.needsHumanConversationCount,
              openKnowledgeGapCount: data.openGapCount,
              totalKnowledgeDocuments: data.totalKnowledgeDocuments,
              indexedKnowledgeDocuments: data.indexedKnowledgeDocuments,
              /** 仓储已按 Task 78 规则排序（open 优先 → 次数 → 最近），取前 3 条 */
              topGaps: data.knowledgeGaps
                .filter((gap) => gap.status === "open")
                .slice(0, 3)
                .map((gap) => ({
                  id: gap.id,
                  question: gap.question,
                  occurrenceCount: gap.occurrenceCount,
                })),
            };
          },
          null as DashboardCustomerServiceState | null,
        ),
        optional("metrics", () => repositories.analytics.getDashboardMetrics(), []),
        optional(
          "trend",
          async () => (await repositories.analytics.getOverview()).trend,
          [] as TrendPoint[],
        ),
        optional("live", () => repositories.live.getSession(), null),
        optional("live", () => repositories.live.getStats(), null),
        optional("live", () => repositories.live.listComments(), []),
        optional("dailyReport", () => repositories.reports.findLatest(), null),
        optional("businessGoal", () => repositories.analytics.getBusinessGoal(), null),
      ]);

      // 商品名映射：工作流列表要把 productId 翻成商家看得懂的名字
      const nameById = new Map(allProducts.map((product) => [product.id, product.name]));

      /**
       * 智能客服卡片的专属装配（Task 81 第八 / 九节）。
       *
       * 状态文案映射的是**服务是否正常**，不是任务结果本身：
       * - running / queued → 正在服务
       * - failed → 最近一次服务异常（只有真的没跑完才算）
       * - completed → 最近服务正常 —— **包括 grounded=false + needsHuman 的那种**：
       *   Agent 正确识别出「知识不足」是它的本职工作，不是执行失败。
       * - 从未跑过 → 待命
       *
       * 与之独立的业务提醒（待人工会话数、知识缺口数）走 metrics，
       * 绝不反过来把卡片状态染成失败（任务书第二十七节）。
       */
      const csTask = agentStateResult.tasksByAgent.get("customer_service_agent");
      const liveTask = agentStateResult.tasksByAgent.get("live_agent");
      const analyticsTask = agentStateResult.tasksByAgent.get("analytics_agent");

      /**
       * 「服务是否正常」的统一措辞（客服与直播共用同一套判断，只是文案贴合各自场景）。
       * 状态的语义与客服卡片一致：**grounded=false 也是正常服务**，
       * 只有真的没跑完才算 failed（任务书第二十七节）。
       */
      function serviceStatusLabel(
        task: AgentTaskRecord | undefined,
        labels: { idle: string; active: string; failed: string; ok: string },
      ): string {
        if (!task) {
          return labels.idle;
        }
        if (task.status === "running" || task.status === "queued") {
          return labels.active;
        }
        if (task.status === "failed") {
          return labels.failed;
        }
        return labels.ok;
      }

      const agentStates: DashboardAgentState[] = agentStateResult.states.map(
        (state): DashboardAgentState => {
          if (state.id === "customer_service_agent") {
            return {
              ...state,
              href: "/customer-service",
              statusLabel: serviceStatusLabel(csTask, {
                idle: "待命",
                active: "正在服务",
                failed: "最近一次服务异常",
                ok: "最近服务正常",
              }),
              customerServiceMetrics: customerService
                ? {
                    todayAnsweredCount: customerService.todayAnsweredCount,
                    needsHumanConversationCount:
                      customerService.needsHumanConversationCount,
                    openKnowledgeGapCount: customerService.openKnowledgeGapCount,
                  }
                : null,
            };
          }

          /**
           * S6：AI 直播导演上线。它的「最近任务」来自 `agent_tasks`
           * （`live_agent` 类型），`href` 指向直播间工作台。
           * 这里**不**额外编造「正在直播」之类的状态 —— 直播场次状态由
           * `/live` 页面自己的数据回答，卡片只回答「这位员工服务正不正常」。
           */
          if (state.id === "live_agent") {
            return {
              ...state,
              href: "/live",
              statusLabel: serviceStatusLabel(liveTask, {
                idle: "待命",
                active: "正在分析评论",
                failed: "最近一次分析异常",
                ok: "最近分析正常",
              }),
            };
          }

          /**
           * S6-B：经营分析师（Analytics Agent）上线，Dashboard 由此补全 6 / 6。
           *
           * 文案映射的是**复盘是否正常**，不是任务字样本身：
           * 没有任务 → 待命（还没做过一次复盘）；running → 分析中；
           * completed → 最近复盘正常；failed → 最近一次复盘异常。
           *
           * 这里用「复盘」而不是「生成日报」，是因为**一次成功复盘的产物就是一份
           * 日报**（我们只在报告落库之后才把任务标 completed），
           * 因此任务状态与「有没有一份可信日报」在语义上是同一件事，
           * 不需要再去查一次 `business_reports`。
           */
          if (state.id === "analytics_agent") {
            return {
              ...state,
              href: "/analytics",
              statusLabel: serviceStatusLabel(analyticsTask, {
                idle: "待命",
                active: "分析中",
                failed: "最近一次复盘异常",
                ok: "最近复盘正常",
              }),
            };
          }

          return state;
        },
      );

      const recentWorkflows = workflows
        .map((workflow) => toWorkflowListItem({ workflow, nameById, now }))
        .slice(0, RECENT_WORKFLOW_LIMIT);

      // 「正在执行」的那一轮：running 且未过期
      const runningWorkflow = workflows.find(
        (workflow) => workflow.status === "running" && !isStaleRunning(workflow, now),
      );
      /** 状态为 running 但已过期的那一轮（用于 Business Brain 卡片提示「可能已中断」） */
      const interruptedWorkflow = workflows.find(
        (workflow) => workflow.status === "running" && isStaleRunning(workflow, now),
      );

      const activeWorkflow = runningWorkflow
        ? toWorkflowListItem({ workflow: runningWorkflow, nameById, now })
        : null;
      const interruptedItem = interruptedWorkflow
        ? toWorkflowListItem({ workflow: interruptedWorkflow, nameById, now })
        : null;

      const stats: DashboardWorkflowStats = {
        windowSize: WORKFLOW_STATS_WINDOW,
        total: workflows.length,
        completed: workflows.filter((item) => item.status === "completed").length,
        partiallyCompleted: workflows.filter(
          (item) => item.status === "partially_completed",
        ).length,
        failed: workflows.filter((item) => item.status === "failed").length,
        running: workflows.filter((item) => item.status === "running").length,
        idle: workflows.filter((item) => item.status === "idle").length,
        executedTasks: workflows.reduce(
          (sum, item) => sum + (toWorkflowSummary(item.summary)?.executed ?? 0),
          0,
        ),
        reusedTasks: workflows.reduce(
          (sum, item) => sum + (toWorkflowSummary(item.summary)?.reused ?? 0),
          0,
        ),
      };

      /**
       * Business Brain 卡片的状态。
       *
       * 优先级：执行中 > 中断 > 待确认（最新一条是 idle）> 空闲。
       * 「中断」排在「待确认」之前，是因为它是同一批记录里更需要商家处理的情况
       * —— 一条卡住的 running 不处理掉，新建计划会被并发保护挡住。
       */
      const latest = workflows[0] ?? null;
      const brainPhase: BusinessBrainPhase = activeWorkflow
        ? "executing"
        : interruptedItem
          ? "interrupted"
          : latest?.status === "idle"
            ? "awaiting_confirmation"
            : "idle";

      const brainFocus = activeWorkflow ?? interruptedItem ?? recentWorkflows[0] ?? null;

      // 计划对话框的商品选项：与前 50 件商品一起取回，避免对话框再发起一次请求
      const planningProducts: DashboardProductOption[] = await Promise.all(
        allProducts.slice(0, MAX_PLANNING_PRODUCT_OPTIONS).map(async (product) => {
          const dna = await repositories.productDna
            .getByProductId(product.id)
            .catch(() => null);
          return {
            id: product.id,
            name: product.name,
            category: product.category,
            hasDna: dna !== null,
            analysisStatus: product.analysisStatus,
          } satisfies DashboardProductOption;
        }),
      );

      return {
        agentStates,
        businessBrain: {
          name: BUSINESS_BRAIN_PROFILE.name,
          role: BUSINESS_BRAIN_PROFILE.role,
          description: BUSINESS_BRAIN_PROFILE.description,
          icon: BUSINESS_BRAIN_PROFILE.icon,
          skills: BUSINESS_BRAIN_PROFILE.skills,
          phase: brainPhase,
          goal: brainFocus?.goal ?? null,
          progress:
            activeWorkflow && activeWorkflow.progress.total > 0
              ? activeWorkflow.progress
              : null,
          lastStatus: latest?.status ?? null,
          lastCompletedAt: latest?.completedAt ?? null,
          canLaunch: activeWorkflow === null,
          workflowId: brainFocus?.id ?? null,
          provider: getAIProviderStatus(),
        },
        activeWorkflow,
        recentWorkflows,
        workflowStats: stats,
        planningProducts,
        customerService,

        metrics,
        trend,
        spotlightProduct: allProducts[0] ?? null,
        productCount: allProducts.length,
        liveSession,
        liveStats,
        liveComments,
        dailyReport,
        businessGoal,

        dataSource: getDataSourceStatus(),
        /**
         * 同一区块可能被记录多次（如 live 有三次读取），去重并**排序**：
         * 这几处读取是并发进行的，写入顺序不确定；不排序的话同一个数据源
         * 两次请求可能返回顺序不同的数组，让快照测试与「是不是变了」的判断都失效。
         */
        unavailableSections: [...new Set(unavailableSections)].sort(),
      } satisfies DashboardOverview;
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载经营驾驶舱数据失败"),
  );
}
