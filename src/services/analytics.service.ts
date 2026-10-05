/**
 * 经营分析业务服务（S6-B · 任务书第十四 / 十七 / 三十三 / 三十四节）
 *
 * 这是「经营闭环」里最后一环的编排层：
 *
 *   各业务域的真实数据
 *     → `@/analytics/snapshot` 纯函数算指标（**不经模型**）
 *     → Analytics Agent 做归因与行动建议（**只解释，不计算**）
 *     → `business_reports` 落库（快照 + 结论一起存）
 *     → 页面展示 / 下一轮经营
 *
 * ## 三条不可让步的约定
 *
 * 1. **Service 不直连数据库、不直连模型。** 一律经 Repository 与 Agent。
 *    （因此本文件里没有一处 `@/db`，也没有一处模型 SDK。）
 *
 * 2. **失败不毁掉已有成果。** 生成失败时任务如实记 failed，**旧日报原样保留** ——
 *    我们全程没有触碰 `business_reports`，所以「新失败把旧成功删掉」这种事
 *    在结构上就不可能发生（任务书第三十四节）。界面上由
 *    `getAnalyticsReportState()` 的 `lastRunFailed` 提示「下面是上一次成功的结果」。
 *
 * 3. **并发保护靠任务记录，不靠内存标志位。** 进程内的布尔量在
 *    多实例 / 热重载 / 服务器重启面前一文不值；而 `agent_tasks` 里的 running 记录
 *    是持久事实。过期阈值用来放行「进程中断留下的孤儿任务」，
 *    否则一次崩溃会把经营分析永久卡在「分析中」。
 */

import { runAnalyticsAgent } from "@/ai/agents/analytics-agent";
import { getAIProviderStatus, type AIProviderStatus } from "@/ai/provider";
import type { AIProvider } from "@/ai/provider/types";
import { ANALYTICS_METRIC_KEYS } from "@/analytics/metric-keys";
import { buildSalesReviewSnapshot } from "@/analytics/sales-review";
import { summarizeSales } from "./sales.service";
import {
  buildAnalyticsSnapshot,
  type SnapshotLiveInput,
  type SnapshotWorkflowInput,
} from "@/analytics/snapshot";
import { attempt, fail, ok, toAppError, type AppErrorShape, type Result } from "@/lib/result";
import {
  getRepositories,
  type AgentTaskRecord,
  type AgentWorkflowRecord,
  type Repositories,
  type UpdateAgentTaskInput,
} from "@/repositories";
import { getCustomerServiceOverview, resolveActiveBusinessId } from "./customer-service";
import type {
  AgentId,
  AgentStatus,
  AnalyticsSnapshot,
  BusinessReport,
  SalesReviewMode,
} from "@/types";

/** 写入 `agent_tasks.agent_type` 的值 */
export const ANALYTICS_AGENT_TYPE: AgentId = "analytics_agent";

/** Agent 任务标题（面向商家，说明这次在干什么） */
const AGENT_TASK_TITLE = "生成今日经营日报";

/** 任务类型：本地 Demo 只有「日报」一种复盘粒度，留成字段以便将来加周报 */
const REPORT_TYPE = "daily";

/**
 * 「分析中」的过期阈值。
 *
 * Analytics Agent 走 reasoning 档（比品牌策略还慢一档），因此给得比品牌更宽：
 * 超过它仍未收口，只可能是进程被中断留下的孤儿任务 —— 放行重跑，
 * 而不是让商家永远点不动「生成经营日报」。
 */
export const ANALYTICS_REPORT_STALE_MS = 5 * 60 * 1000;

/** 快照各数据域的读取窗口：够用且不会把整张表拉进内存 */
const SNAPSHOT_WORKFLOW_WINDOW = 50;
const SNAPSHOT_TASK_WINDOW = 200;
const SNAPSHOT_LIVE_SESSION_WINDOW = 20;
/** 历史日报读取上限（页面只展示最近几条，但接口按「最多 N 条」收口） */
export const ANALYTICS_REPORT_HISTORY_LIMIT = 20;
/** 页面上展示的历史日报条数 */
export const ANALYTICS_REPORT_HISTORY_DISPLAY = 5;

/* ------------------------------------------------------------------ */
/* 视图类型                                                            */
/* ------------------------------------------------------------------ */

/** 经营日报的生成状态（对应 empty / generating / completed / failed） */
export type AnalyticsReportStatus = "empty" | "generating" | "completed" | "failed";

/**
 * 因「该领域在当前数据源下尚未实现」而降级的区块。
 *
 * 存在的理由：`local`（PGlite）与 `db`（Supabase）共用同一套数据库仓储，
 * 而**直播 / 经营日报**两个领域的表还没建（见 `@/repositories/db/index.ts`），
 * 仓储会明确抛 `NOT_IMPLEMENTED`。服务层**不许**把这种「没接上」当成
 * 「读不到数据」静默吞掉 —— 那样商家会以为「直播 0 场 / 还没生成过日报」
 * 是自己的问题，然后对着永远出不来结果的按钮一直点。
 *
 * 因此：能降级的照常降级（页面不 500），但**必须带着这个标注一起交出去**，
 * 由界面显式说明「这个模块在当前数据源下还没启用」。
 */
export interface AnalyticsDegradedModule {
  /** 区块标识：直播数据 / 经营日报 */
  module: "live" | "reports";
  /** 面向用户的原因（来自 `AppError.message`） */
  reason: string;
}

export interface AnalyticsReportState {
  status: AnalyticsReportStatus;
  /** 已有日报、但最近一次重新生成失败 */
  lastRunFailed: boolean;
  latestTask: {
    id: string;
    status: AgentStatus;
    createdAt: string;
    completedAt: string | null;
    durationMs: number | null;
    errorMessage: string | null;
  } | null;
  /** 当前模型通道状态，用于在界面上如实标注「Mock 占位 / 通义千问」 */
  provider: AIProviderStatus;
}

/** 经营分析页 / 驾驶舱所需的真实数据 */
export interface AnalyticsOverviewView {
  snapshot: AnalyticsSnapshot;
  latestReport: BusinessReport | null;
  /** 历史日报（含最新一份），按时间倒序 */
  recentReports: BusinessReport[];
  /** 为真实销售与演示销售分别寻找最近一次建议。 */
  salesReports?: BusinessReport[];
  reportState: AnalyticsReportState;
  /**
   * 因当前数据源缺实现而降级的区块（直播 / 经营日报）；空数组表示全部真实可用。
   * 界面**必须**据此显示「该模块尚未启用」，而不是显示「暂无数据」。
   */
  degradedModules: AnalyticsDegradedModule[];
}

export interface GenerateBusinessReportOptions {
  /** 注入 Provider（测试用）；默认按 AI_PROVIDER 环境变量解析 */
  provider?: AIProvider;
  /** 由经营大脑触发时关联到对应工作流 */
  workflowId?: string | null;
  signal?: AbortSignal;
  salesMode?: SalesReviewMode;
}

/** 一次日报生成的结果 */
export interface BusinessReportGenerationResult {
  taskId: string;
  report: BusinessReport;
  providerId: string;
  /** 是否为 Mock 占位数据（界面据此提示「结果不可当真实结论」） */
  isMock: boolean;
  /** 实际使用的模型档位 */
  tier: string;
  /** 是否因推理档不可用回落到了快速档 */
  tierFallback: boolean;
  attempts: number;
  repaired: boolean;
  durationMs: number;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 「该领域在当前数据源下尚未实现」的判定。
 *
 * **只认 `NOT_IMPLEMENTED` 这一个码**，绝不用它去接住其它错误。
 * 把「没实现」和「读不到（数据库连不上 / 表被删）」混为一谈，
 * 会让一次真实的存储故障在界面上表现为「你还没有数据」——
 * 那是最难排查的一类问题：页面看着一切正常。
 */
function isNotImplemented(error: AppErrorShape): boolean {
  return error.code === "NOT_IMPLEMENTED";
}

/**
 * 把一个 `Result` 收敛成值：**只有**「尚未实现」才降级为 `fallback`，
 * 并顺带把原因记进 `modules`（同一区块只记一次）。
 *
 * 其它任何失败原样上抛 —— 降级是给「没接上」的，不是给「坏了」的。
 */
function degradePendingModule<T>(
  result: Result<T>,
  fallback: T,
  modules: AnalyticsDegradedModule[],
  module: AnalyticsDegradedModule["module"],
): T {
  if (result.ok) {
    return result.data;
  }
  if (!isNotImplemented(result.error)) {
    throw result.error;
  }
  if (!modules.some((item) => item.module === module)) {
    modules.push({ module, reason: result.error.message });
  }
  return fallback;
}

/**
 * 收口任务记录。
 * **刻意不把失败上抛**：报告已经产出，任务记录写不进去（存储抖动）不应该
 * 把一次成功的生成改判为失败 —— 只记录日志，让人能从日志里发现。
 */
async function closeTask(
  repositories: Repositories,
  taskId: string,
  patch: UpdateAgentTaskInput,
): Promise<void> {
  const updated = await attempt(
    () => repositories.agentTasks.update(taskId, patch),
    (cause) => toAppError(cause, "DB_ERROR", "更新经营分析任务失败"),
  );
  if (!updated.ok) {
    console.warn(
      `[analytics] 任务记录更新失败 taskId=${taskId}：${updated.error.message}`,
    );
  }
}

/** 运行中的任务是否已经过期（进程中断留下的孤儿） */
function isStaleRunningTask(record: AgentTaskRecord, now: Date): boolean {
  const startedAt = record.createdAt ? new Date(record.createdAt).getTime() : NaN;
  if (!Number.isFinite(startedAt)) {
    // 时间不可解析时不阻塞用户，按过期处理
    return true;
  }
  return now.getTime() - startedAt > ANALYTICS_REPORT_STALE_MS;
}

/**
 * 把工作流记录收敛成快照层需要的**最小形状**。
 *
 * `agent_workflows.summary` 是 jsonb：库里可能留着旧版本结构，也可能缺字段。
 * 这里只认「`executed` / `reused` 都是数字」的摘要，其余一律降级为 `null`
 * —— 快照层的口径是「不可知就不算」，把半截数据当 0 会让复用能力凭空消失。
 */
function toWorkflowInput(record: AgentWorkflowRecord): SnapshotWorkflowInput {
  const readCount = (key: "executed" | "reused"): number | null => {
    const value = record.summary?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const executed = readCount("executed");
  const reused = readCount("reused");

  return {
    status: record.status,
    summary: executed !== null && reused !== null ? { executed, reused } : null,
  };
}

/** 一次直播输入读取：数据本身 + 「该领域没实现」时的原因 */
interface LiveInputLoad {
  input: SnapshotLiveInput;
  /** 直播仓储在当前数据源下未实现时的原因；可用时为 null */
  unavailableReason: string | null;
}

/** 直播输入：**跨全部场次**汇总（经营复盘看的是累计，不是最近一场） */
async function loadLiveInput(repositories: Repositories): Promise<LiveInputLoad> {
  const probe = await attempt(
    () => repositories.live.listSessions(SNAPSHOT_LIVE_SESSION_WINDOW),
    (cause) => toAppError(cause, "DB_ERROR", "加载直播场次失败"),
  );

  /**
   * S7 起直播仓储已接上数据库（`live_sessions` / `live_comments` /
   * `live_suggestions`），正常路径不再抛 NOT_IMPLEMENTED。这里保留降级分支
   * 是**防御性**的：万一某个数据源将来又退回未实现，经营快照不至于整份失败。
   * 真实的数据库故障（连不上、表被删）仍然照常抛出，不会被吞成「读不到」。
   */
  if (!probe.ok) {
    if (!isNotImplemented(probe.error)) {
      throw probe.error;
    }
    return {
      input: { sessions: [], comments: [], suggestions: [] },
      unavailableReason: probe.error.message,
    };
  }

  const sessions = probe.data;

  const perSession = await Promise.all(
    sessions.map(async (session) => ({
      comments: await repositories.live.listComments(session.id),
      suggestions: await repositories.live.listSuggestions(session.id),
    })),
  );

  return {
    input: {
      sessions,
      comments: perSession.flatMap((item) => item.comments),
      suggestions: perSession.flatMap((item) => item.suggestions),
    },
    unavailableReason: null,
  };
}

/* ------------------------------------------------------------------ */
/* 读取：快照                                                          */
/* ------------------------------------------------------------------ */

/** 快照构建结果：快照本身 + 构建过程中因数据源缺实现而降级的区块 */
interface SnapshotBuildOutcome {
  snapshot: AnalyticsSnapshot;
  degradedModules: AnalyticsDegradedModule[];
}

/**
 * 构建当前经营快照，并**如实记录**哪些区块因为「该领域还没接到这个数据源上」
 * 而降级（目前只有直播）。
 *
 * 与 `buildCurrentAnalyticsSnapshot` 的关系：后者是薄封装，只交出快照本身
 * （脚本与单测要的就是这个）；总览页需要知道自己少看了什么，
 * 因此走这个更完整的内部入口。
 *
 * 数字全部来自 `@/analytics/snapshot` 的纯函数；本函数只负责**把数据取齐**。
 * 客服指标复用 `getCustomerServiceOverview()` 而不是自己再查一遍会话与消息：
 * 「今日回答数」的口径已经在客服服务层定死（分母只算 AI 真正写出回答的消息），
 * 在这里重算等于给自己留一个口径慢慢漂移的机会。
 */
async function buildSnapshotOutcome(): Promise<Result<SnapshotBuildOutcome>> {
  return attempt(
    async () => {
      const repositories = getRepositories();
      const degradedModules: AnalyticsDegradedModule[] = [];

      const customerService = await getCustomerServiceOverview();
      if (!customerService.ok) {
        throw customerService.error;
      }
      const cs = customerService.data;

      const [products, contents, workflowRecords, agentTasks, live] = await Promise.all([
        repositories.products.list(),
        repositories.content.list(),
        repositories.agentWorkflows.listRecent(SNAPSHOT_WORKFLOW_WINDOW),
        repositories.agentTasks.listRecent(SNAPSHOT_TASK_WINDOW),
        loadLiveInput(repositories),
      ]);

      if (live.unavailableReason) {
        degradedModules.push({ module: "live", reason: live.unavailableReason });
      }

      const workflows = workflowRecords.map(toWorkflowInput);

      const snapshot = buildAnalyticsSnapshot({
        now: new Date(),
        products,
        contents,
        workflows,
        agentTasks,
        customerService: {
          answeredCount: cs.todayAnsweredCount,
          groundedCount: cs.todayGroundedCount,
          needsHumanCount: cs.needsHumanConversationCount,
          openKnowledgeGapCount: cs.openGapCount,
          // 只把**未解决**的缺口交给聚合：已补齐的缺口是「做对了的证据」，
          // 混进来会让「缺口集中在哪」这个结论彻底失真
          openGaps: cs.knowledgeGaps
            .filter((gap) => gap.status === "open")
            .map((gap) => ({ intent: gap.intent })),
        },
        live: live.input,
      });

      return { snapshot, degradedModules };
    },
    (cause) => toAppError(cause, "DB_ERROR", "构建经营快照失败"),
  );
}

/**
 * 构建当前经营快照（面向脚本 / 单测 / 日报生成）。
 *
 * 只交出快照本身 —— 需要「哪些区块降级了」的调用方请用 `getAnalyticsOverview()`，
 * 它会把降级信息一并以 `degradedModules` 交出去。
 */
export async function buildCurrentAnalyticsSnapshot(): Promise<
  Result<AnalyticsSnapshot>
> {
  const built = await buildSnapshotOutcome();
  if (!built.ok) {
    return built;
  }
  return ok(built.data.snapshot);
}

/* ------------------------------------------------------------------ */
/* 读取：日报与状态                                                     */
/* ------------------------------------------------------------------ */

export async function getLatestBusinessReport(): Promise<Result<BusinessReport | null>> {
  return attempt(
    () => getRepositories().reports.findLatest(),
    (cause) => toAppError(cause, "DB_ERROR", "加载最新经营日报失败"),
  );
}

export async function listBusinessReports(
  limit: number = ANALYTICS_REPORT_HISTORY_LIMIT,
): Promise<Result<BusinessReport[]>> {
  return attempt(
    () => getRepositories().reports.listRecent(limit),
    (cause) => toAppError(cause, "DB_ERROR", "加载经营日报历史失败"),
  );
}

/**
 * 日报生成状态。
 *
 * 状态派生规则（顺序即优先级，与品牌生成状态同一套判断）：
 *   1. 已有日报 → completed（最近一次任务失败时另用 `lastRunFailed` 提示）
 *   2. 最近一次任务运行中且未过期 → generating
 *   3. 最近一次任务失败，或运行中但已过期（进程中断）→ failed
 *   4. 其余（没有任务、也没有日报）→ empty
 */
export async function getAnalyticsReportState(): Promise<Result<AnalyticsReportState>> {
  return attempt(
    async () => {
      const repositories = getRepositories();
      const [task, latestResult] = await Promise.all([
        repositories.agentTasks.findLatestByType(ANALYTICS_AGENT_TYPE),
        attempt(
          () => repositories.reports.findLatest(),
          (cause) => toAppError(cause, "DB_ERROR", "加载最新经营日报失败"),
        ),
      ]);
      const provider = getAIProviderStatus();

      /**
       * `business_reports` 属于**部署阶段**领域（`local` / `db` 下尚未建表）。
       * 这里把「未实现」降级为「没有日报」；真实故障仍然上抛。
       * 只降级不改口径：状态仍如实是 empty —— 界面另据 `degradedModules`
       * 说明「原因不是你没生成过，而是这个模块还没接上」。
       */
      if (!latestResult.ok && !isNotImplemented(latestResult.error)) {
        throw latestResult.error;
      }
      const latest = latestResult.ok ? latestResult.data : null;

      const taskView = task
        ? {
            id: task.id,
            status: task.status,
            createdAt: task.createdAt,
            completedAt: task.completedAt,
            durationMs: task.durationMs,
            errorMessage: task.errorMessage,
          }
        : null;

      if (task && task.status === "running" && !isStaleRunningTask(task, new Date())) {
        return { status: "generating" as const, lastRunFailed: false, latestTask: taskView, provider };
      }

      if (latest) {
        return {
          status: "completed" as const,
          lastRunFailed: task?.status === "failed",
          latestTask: taskView,
          provider,
        };
      }

      if (task && task.status === "failed") {
        return {
          status: "failed" as const,
          lastRunFailed: false,
          latestTask: taskView,
          provider,
        };
      }

      return {
        status: "empty" as const,
        lastRunFailed: false,
        latestTask: taskView,
        provider,
      };
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载经营日报状态失败"),
  );
}

/**
 * 经营分析总览（任务书第十四节）。
 *
 * 页面只调这一个入口就能拿到「真实指标 + 最新日报 + 历史 + 状态」，
 * 不需要（也不允许）自己去碰 Repository 或 Agent。
 */
export async function getAnalyticsOverview(): Promise<Result<AnalyticsOverviewView>> {
  return attempt(
    async () => {
      const [built, latest, recent, reportState] = await Promise.all([
        buildSnapshotOutcome(),
        getLatestBusinessReport(),
        listBusinessReports(ANALYTICS_REPORT_HISTORY_LIMIT),
        getAnalyticsReportState(),
      ]);
      if (!built.ok) throw built.error;
      if (!reportState.ok) throw reportState.error;

      const degradedModules: AnalyticsDegradedModule[] = [...built.data.degradedModules];

      /**
       * 日报读取分两种结局：
       * - **尚未实现**（该领域没接到这个数据源上）→ 降级为空并记进 `degradedModules`，
       *   页面据此显示「该模块尚未启用」，而不是「你还没生成过日报」；
       * - **真实故障**（连不上 / 表被删）→ 照常上抛，别让故障伪装成空数据。
       */
      const latestReport = degradePendingModule(latest, null, degradedModules, "reports");
      const recentReports = degradePendingModule(
        recent,
        [],
        degradedModules,
        "reports",
      );

      return {
        snapshot: built.data.snapshot,
        latestReport,
        recentReports: recentReports.slice(0, ANALYTICS_REPORT_HISTORY_DISPLAY),
        salesReports: recentReports,
        reportState: reportState.data,
        degradedModules,
      };
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载经营分析数据失败"),
  );
}

/* ------------------------------------------------------------------ */
/* 写入：生成经营日报                                                   */
/* ------------------------------------------------------------------ */

/**
 * 生成今日经营日报。
 *
 * 顺序刻意如此（每一步都能解释）：
 *   ① 并发保护（读 running 任务）→ ② 构建快照 → ③ 建任务（running）
 *   → ④ 跑 Agent → ⑤ 失败则任务记 failed 并返回错误（**旧日报不动**）
 *   → ⑥ 成功则落库 → ⑦ 任务收口
 *
 * 为什么把「构建快照」放在建任务之前：快照构建失败（存储读不到）
 * 不应该在任务表里留下一条注定失败的记录 —— 那不是 Agent 的失败，
 * 而是数据源的问题，混在一起会让失败率统计失去意义。
 */
export async function generateBusinessReport(
  options: GenerateBusinessReportOptions = {},
): Promise<Result<BusinessReportGenerationResult>> {
  const repositories = getRepositories();

  /** ① 并发保护：同一时刻只允许一次经营分析 */
  const latestTask = await attempt(
    () => repositories.agentTasks.findLatestByType(ANALYTICS_AGENT_TYPE),
    (cause) => toAppError(cause, "DB_ERROR", "读取经营分析任务失败"),
  );
  if (!latestTask.ok) {
    return latestTask;
  }
  const running = latestTask.data;
  if (running && running.status === "running" && !isStaleRunningTask(running, new Date())) {
    return fail(
      "RATE_LIMITED",
      "经营日报正在生成中，请稍候再试",
      `任务 ${running.id} 开始于 ${running.createdAt}，仍在运行`,
    );
  }

  /** ② 构建快照（真实数据 → 程序指标） */
  const businessId = await resolveActiveBusinessId();
  if (!businessId.ok) {
    return businessId;
  }

  const snapshot = await buildCurrentAnalyticsSnapshot();
  if (!snapshot.ok) {
    return snapshot;
  }

  const salesMode = options.salesMode ?? "real";
  const salesContext = await attempt(async () => {
    const [allRecords, products] = await Promise.all([
      repositories.sales.list(businessId.data), repositories.products.list(),
    ]);
    const records = allRecords.filter(row => row.businessId === businessId.data && row.isDemo === (salesMode === "demo"));
    const now = new Date(snapshot.data.generatedAt);
    return buildSalesReviewSnapshot(records, summarizeSales(records, salesMode === "demo", now), products, now);
  }, cause => toAppError(cause, "DB_ERROR", "读取销售分析依据失败"));
  if (!salesContext.ok) return salesContext;
  if (options.salesMode && salesContext.data.summary.count === 0) return fail("VALIDATION_FAILED", "当前没有销售记录，请先导入记录或载入演示数据。");
  snapshot.data.sales = salesContext.data;

  const providerStatus = getAIProviderStatus();
  const startedAt = Date.now();

  /** ③ 建任务。input 只记**索引**，不把整份快照抄一遍（任务书第三十二节） */
  const createdTask = await attempt(
    () =>
      repositories.agentTasks.create({
        agentType: ANALYTICS_AGENT_TYPE,
        title: AGENT_TASK_TITLE,
        workflowId: options.workflowId ?? null,
        status: "running",
        progress: 10,
        input: {
          snapshotGeneratedAt: snapshot.data.generatedAt,
          metricCount: ANALYTICS_METRIC_KEYS.length,
          reportType: REPORT_TYPE,
          salesMode,
          salesFingerprint: salesContext.data.fingerprint,
        },
      }),
    (cause) => toAppError(cause, "DB_ERROR", "创建经营分析任务失败"),
  );
  if (!createdTask.ok) {
    return createdTask;
  }
  const taskId = createdTask.data.id;

  /** ④ 跑 Analytics Agent */
  const run = await runAnalyticsAgent(snapshot.data, {
    ...(options.provider ? { provider: options.provider } : {}),
    signal: options.signal ?? AbortSignal.timeout(75_000),
  });

  const durationMs = Date.now() - startedAt;

  /** ⑤ 失败分支：如实记录，**不触碰已有日报** */
  if (!run.ok) {
    const detail = run.error.detail ? `（${run.error.detail}）` : "";
    await closeTask(repositories, taskId, {
      status: "failed",
      durationMs,
      errorMessage: `${run.error.message}${detail}`,
    });
    return run;
  }

  /** ⑥ 落库：快照与结论一起存，历史才可回溯 */
  const saved = await attempt(
    () =>
      repositories.reports.create({
        businessId: businessId.data,
        snapshot: snapshot.data,
        report: {
          ...run.data.report,
          ...(run.data.report.salesReview ? { salesReview: { ...run.data.report.salesReview, isMock: run.data.providerId === "mock", providerId: run.data.providerId } } : {}),
        },
      }),
    (cause) => toAppError(cause, "DB_ERROR", "保存经营日报失败"),
  );
  if (!saved.ok) {
    await closeTask(repositories, taskId, {
      status: "failed",
      durationMs,
      errorMessage: saved.error.message,
    });
    return saved;
  }

  /** ⑦ 任务收口：output 只放**统计量**，完整报告在 business_reports（§32） */
  await closeTask(repositories, taskId, {
    status: "completed",
    progress: 100,
    durationMs,
    output: {
      health: run.data.report.health,
      highlightCount: run.data.report.highlights.length,
      issueCount: run.data.report.issues.length,
      actionCount: run.data.report.actions.length,
      durationMs,
      reportId: saved.data.id,
      providerId: run.data.providerId,
      tier: run.data.tier,
      tierFallback: run.data.tierFallback,
    },
  });

  return ok({
    taskId,
    report: saved.data,
    providerId: run.data.providerId,
    isMock: providerStatus.isMock,
    tier: run.data.tier,
    tierFallback: run.data.tierFallback,
    attempts: run.data.attempts,
    repaired: run.data.repaired,
    durationMs,
    warnings: run.data.warnings,
  });
}
