/**
 * 工作流展示映射（S4-2）
 *
 * 职责：把编排层产出的**真实数据**（计划快照 + 逐步报告 + 工作流状态）
 * 翻译成界面可以直接渲染的状态。
 *
 * 为什么单独抽一层、而不是在组件里写 if：
 * 1. **它必须在服务端与客户端都跑得动**。对话框要轮询、卡片要渲染，
 *    两边都得用同一套映射；写在组件里就会出现两套口径。
 * 2. **它要能被单测穷举**。「复用不能被显示成完成」这类要求是硬约束，
 *    放在渲染函数里只能靠肉眼看；抽成纯函数后每个状态组合都有一条断言。
 * 3. 组件里只剩「把 label 塞进 span」，不再有任何业务判断。
 *
 * 三条硬约束（对应任务书的明确要求）：
 * - **不许伪造进度**。这里只给出 `已完成步数 / 总步数`，且「已完成」的定义是
 *   「这一轮的结局已经确定」（跑完、复用、失败、被挡住都算），而不是
 *   「跑成功了」。绝不产出百分比。
 * - **reused 必须与 completed 分开表达**。`reused` 意味着本次没有再次调用 AI，
 *   说成「已完成」会让商家以为又花了一次钱。
 * - **被依赖挡住的步骤不能说成失败**。它根本没运行，说成失败等于冤枉了一个
 *   没有执行的任务，也会让商家去查一个不存在的错误。
 */

import { AGENT_NAME_LABEL, AGENT_STATUS_META, WORKFLOW_STATUS_META } from "@/lib/status-meta";
import { CONTENT_FORMATS, CONTENT_PLATFORMS } from "@/lib/content-options";
import { toUserFacingPlanText } from "@/lib/user-facing-text";
import type {
  AgentId,
  AgentStatus,
  AgentWorkflowSummary,
  ContentFormat,
  ContentPlatform,
  StatusTone,
  WorkflowStatus,
  WorkflowStepReport,
  WorkflowTaskOutcome,
} from "@/types";

/* ------------------------------------------------------------------ */
/* 步骤展示状态                                                        */
/* ------------------------------------------------------------------ */

/**
 * 步骤在界面上呈现的状态。
 *
 * 与 `WorkflowTaskOutcome` 的差别只有一处，但很关键：
 * outcome 描述「这一轮怎么落地的」，而展示状态还要表达**正在进行**与**尚未开始**
 * —— 这两种情况在 outcome 里都还不存在（没有报告 = `pending`）。
 *
 * `not_run` 专门给「被上游挡住」用：它既不是失败（没运行就无失败可言），
 * 也不是复用（没有可用的既有结果），因此不能用任何带褒贬的措辞。
 */
export type WorkflowStepDisplayStatus =
  | "pending"
  | "running"
  | "executed"
  | "reused"
  | "failed"
  | "not_run";

export interface StepDisplayMeta {
  label: string;
  tone: StatusTone;
  /** 面向商家的一句话解释（用于 tooltip / 摘要行） */
  description: string;
}

/**
 * 展示状态 → 文案与色调。
 *
 * 色调口径（任务书 §10）：
 * - queued / pending → 灰（neutral）
 * - running → 蓝 + 轻量脉冲（primary）
 * - completed（executed）→ 绿（success）
 * - failed → 红（danger）
 * - skipped / reused → 中性色
 *
 * `reused` 与 `not_run` 同为中性色，但**文案与图标必须区分**：
 * 前者是「已经有了，没花钱」，后者是「上游没成，没能开始」。
 * 颜色不承载这个差别，因此不能只靠颜色（无障碍要求，任务书 §29）。
 */
export const STEP_DISPLAY_META: Record<WorkflowStepDisplayStatus, StepDisplayMeta> =
  {
    pending: {
      label: "等待执行",
      tone: "neutral",
      description: "排在前面，等依赖步骤结束后自动开始。",
    },
    running: {
      label: "正在执行",
      tone: "primary",
      description: "正在调用 AI 员工产出结果。",
    },
    executed: {
      label: "已完成",
      tone: "success",
      description: "这一步真实调用了 AI 员工并产出了结果。",
    },
    reused: {
      label: "已复用",
      tone: "neutral",
      description: "已有可用结果，本次没有再次调用 AI（不额外产生费用）。",
    },
    failed: {
      label: "执行失败",
      tone: "danger",
      description: "这一步执行了但没有成功，可以重试。",
    },
    not_run: {
      label: "未执行",
      tone: "neutral",
      description: "前置步骤没有成功，本步没有被执行。",
    },
  };

export interface StepDisplayInput {
  /** 逐步报告里的落地方式；没有报告（尚未跑到）时传 `"pending"` */
  outcome: WorkflowTaskOutcome | "pending";
  /** 对应的 `agent_tasks` 状态；没有任务记录时为 null */
  status: AgentStatus | null;
}

/**
 * 判定一个步骤在界面上该显示成什么。
 *
 * 判定顺序很重要：**先看报告，再看任务状态**。原因是报告由编排层在
 * 整轮结束时一次性写入，它是「这一轮最终怎么算的」的权威结论；
 * 而 `agent_tasks` 的状态是执行侧的中间记录。两者在 `reused` 与 `skipped`
 * 上必然不一致（那两类任务压根没有记录），以报告为准才不会自相矛盾。
 *
 * ---------- 为什么没有报告时不能只看 `running` ----------
 *
 * 这是本项目最容易被写错的一处，值得说清楚：
 * `agent_workflows.summary`（含逐步报告）**要等整轮结束才写库**。
 * 也就是说，在整轮执行期间，「没有报告」是**常态**，而不是「这一步还没轮到」。
 * 若此时只把 `running` 认成进行中、其余一律当成 `pending`，
 * 那么在一轮持续一两分钟的执行里，已经跑完的步骤会一直显示「等待执行」——
 * 商家看到的是一个永远不动的清单，而库里明明躺着 `completed` 记录。
 * 进度条也会一直停在 `0 / N`，直到整轮结束才突然跳到终值。
 *
 * 任务状态 → 展示状态的映射因此必须完整。它不引入任何新的信息，
 * 只是把 `agent_tasks` 已经写下的事实翻译出来：
 * - `running` → 正在执行；`queued` / `idle` → 还没开始；
 * - `completed` → 已完成（**这不是「猜」**：复用与跳过的步骤根本不会产生任务记录，
 *   因此「有记录且 completed」只可能是真跑过一次）；
 * - `failed` → 执行失败；`skipped` → 未执行（编排层给被挡住的步骤补的记录）。
 */
export function toStepDisplayStatus(
  input: StepDisplayInput,
): WorkflowStepDisplayStatus {
  switch (input.outcome) {
    case "executed":
      return "executed";
    case "reused":
      return "reused";
    case "failed":
      return "failed";
    case "skipped":
      return "not_run";
    case "pending":
      // 还没有报告（整轮仍在跑，或这一步压根没轮到）：只能看任务状态
      switch (input.status) {
        case "running":
          return "running";
        case "completed":
          return "executed";
        case "failed":
          return "failed";
        case "skipped":
          return "not_run";
        // idle / queued / 没有记录：都还没开始
        default:
          return "pending";
      }
  }
}

/* ------------------------------------------------------------------ */
/* 进度（真实步数，绝不编百分比）                                      */
/* ------------------------------------------------------------------ */

export interface WorkflowProgress {
  /** 结局已确定的步数（跑完 / 复用 / 失败 / 被挡住） */
  done: number;
  total: number;
  /** 正在执行的步数 */
  running: number;
}

/**
 * 统计真实进度。
 *
 * 「已完成」在这里是**结局已定**，包含失败与被挡住 —— 因为这两类也不会再有下文，
 * 把它们排除掉会让进度条在失败收尾时永远停在半路，商家会以为任务还在跑。
 * 界面上的文案是「已完成 2 / 4 步」，讲的是「有几步已经有了着落」。
 */
export function toWorkflowProgress(
  steps: readonly StepDisplayInput[],
): WorkflowProgress {
  let done = 0;
  let running = 0;
  for (const step of steps) {
    const status = toStepDisplayStatus(step);
    if (status === "running") {
      running += 1;
    } else if (status !== "pending") {
      done += 1;
    }
  }
  return { done, total: steps.length, running };
}

/* ------------------------------------------------------------------ */
/* 未执行的归因（不能冤枉任何一个没跑的任务）                          */
/* ------------------------------------------------------------------ */

/** 跳过原因 → 面向商家的措辞（与编排层的 `TaskSkipReason` 一一对应） */
const SKIP_CAUSE_LABEL: Readonly<Record<string, string>> = {
  dependency_failed: "依赖条件未满足",
  workflow_aborted: "整轮执行被中止",
};

/**
 * 把 `blockedBy` 的任务 id 翻译成「是哪几步把它挡住了」。
 *
 * 为什么必须翻译：任务书写得很明确 ——
 * 「Product Agent 失败 → 品牌经理：未执行 + 原因『商品分析失败，依赖条件未满足』」，
 * 而**不能**显示成「品牌 Agent 失败」。后者会引导商家去查一个根本没发生的错误。
 *
 * `titleById` 由调用方从同一份计划里取（计划是标题的权威来源）。
 * 找不到标题时退化为任务 id 本身：显示一个 id 虽然不好看，但至少指向了正确的那一步，
 * 比编一句「上游任务」去糊弄要诚实。
 */
export function describeSkippedStep(
  blockedBy: readonly string[],
  note: string | null,
  titleById: ReadonlyMap<string, string>,
): string {
  const names = blockedBy.map((taskId) => titleById.get(taskId) ?? taskId);
  const cause = names.length > 0 ? `「${names.join("」「")}」未成功，本步没有执行` : null;

  // note 里已经带了编排层的解释（含原因分类），两者都有时拼在一起读起来更完整
  if (cause && note) {
    return `${cause}（${note}）`;
  }
  if (cause) {
    return cause;
  }
  return note ?? "本步没有执行。";
}

/** 把 `TaskSkipReason` 原文（如 `dependency_failed`）翻成中文短语；未知原因原样返回 */
export function toSkipCauseLabel(reason: string | null | undefined): string | null {
  if (!reason) {
    return null;
  }
  return SKIP_CAUSE_LABEL[reason] ?? reason;
}

/* ------------------------------------------------------------------ */
/* 工作流层                                                            */
/* ------------------------------------------------------------------ */

/** 工作流状态 → 文案与色调（直接复用全局元数据，避免出现第二套口径） */
export function toWorkflowStatusMeta(status: WorkflowStatus): {
  label: string;
  tone: StatusTone;
} {
  return WORKFLOW_STATUS_META[status];
}

/** 步骤的 `agent_tasks` 状态 → 文案（无记录时不显示状态徽标） */
export function toAgentStatusLabel(status: AgentStatus | null): string | null {
  return status ? AGENT_STATUS_META[status].label : null;
}

/**
 * 工作流是否已经收尾。
 * 界面据此决定「还要不要继续轮询」—— 这是避免无限轮询的第一道闸门。
 */
export function isWorkflowSettled(status: WorkflowStatus): boolean {
  return status !== "idle" && status !== "running";
}

export interface WorkflowOutcomeSummary {
  /** 计划任务数 */
  total: number;
  /** 真实执行成功 */
  executed: number;
  /** 复用（没有再次调用 AI） */
  reused: number;
  /** 被依赖挡住，未执行 */
  notRun: number;
  failed: number;
  /** 新增资产数（成功执行的内容任务数 —— 品牌 / 商品理解是「更新」而非「新增资产」） */
  newAssets: number;
}

/**
 * 由摘要与逐步报告归纳出「本次经营结果」。
 *
 * 为什么 `newAssets` 单独算、而不直接用 `executed`：
 * 商家关心的是「多了几条能发的内容」。商品理解与品牌档案是**幕后资产**
 * （它们让内容更准，但本身不能发），把它们算进「新增资产」会让数字虚高，
 * 而虚高的数字迟早会被商家在内容工厂里数出来对不上。
 */
export function summarizeWorkflowOutcome(params: {
  summary: AgentWorkflowSummary | null;
  steps: readonly { agent: string; outcome: WorkflowTaskOutcome | "pending" }[];
}): WorkflowOutcomeSummary {
  const { summary, steps } = params;

  let executed = 0;
  let reused = 0;
  let notRun = 0;
  let failed = 0;
  let newAssets = 0;

  for (const step of steps) {
    switch (step.outcome) {
      case "executed":
        executed += 1;
        if (step.agent === "content_agent") {
          newAssets += 1;
        }
        break;
      case "reused":
        reused += 1;
        break;
      case "skipped":
        notRun += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "pending":
        break;
    }
  }

  /**
   * 有摘要时以摘要为准，逐步报告缺失（旧记录 / jsonb 降级）时用计数兜底。
   * 为什么不让两者互相校验：摘要由编排层写入，逐步报告是它的展开；
   * 真的不一致时，说明这条记录来自旧版本，此时**摘要的计数更可信**
   * （它从 S4-1 就有，而 `steps` 是同轮才加的）。
   */
  return {
    total: summary?.totalTasks ?? steps.length,
    executed: summary?.executed ?? executed,
    reused: summary?.reused ?? reused,
    notRun: summary?.skipped ?? notRun,
    failed: summary?.failed ?? failed,
    newAssets,
  };
}

/**
 * 「还要不要继续轮询」的判定。
 *
 * 收在纯函数里，是因为这条规则必须**只有一处**：轮询组件与单测读同一个判断，
 * 不会出现「界面停了、其实还在跑」或「界面一直转、任务早结束了」。
 * 上限（次数 / 时长）由调用方叠加，这里只回答「从状态看该不该停」。
 */
export function shouldKeepPolling(params: {
  status: WorkflowStatus;
  /** 已轮询次数 */
  attempts: number;
  /** 最大轮询次数 */
  maxAttempts: number;
  /** 已轮询时长（毫秒） */
  elapsedMs: number;
  /** 最长轮询时长（毫秒） */
  maxDurationMs: number;
}): boolean {
  if (isWorkflowSettled(params.status)) {
    return false;
  }
  return (
    params.attempts < params.maxAttempts && params.elapsedMs < params.maxDurationMs
  );
}

/* ------------------------------------------------------------------ */
/* 实时步骤合并（运行中的那一轮）                                      */
/* ------------------------------------------------------------------ */

/**
 * 计划里的一个步骤（**结构化最小视图**）。
 *
 * 刻意不直接引用 `@/ai/schemas/business-plan` 的 `BusinessPlanDraft`：
 * 那个模块依赖 Zod，而本文件会被**客户端组件**（对话框）引用 ——
 * 为了几个字段把 Zod 打进浏览器包不划算。这里只声明要用到的那几个键，
 * 落库计划的对象结构天然满足它（见 `PlanTaskView` 的赋值点）。
 */
export interface PlanTaskView {
  id: string;
  agent: AgentId;
  title: string;
  reason: string;
  dependsOn: readonly string[];
  productId: string | null;
  platform: ContentPlatform | null;
  format: ContentFormat | null;
}

/**
 * `agent_tasks` 记录的最小视图（同样是为了避免把数据层类型带进客户端）。
 *
 * 字段与 `AgentTaskRecord` 一一对应，因此服务端返回的真实记录可以直接当它用。
 */
export interface LiveAgentTaskView {
  id: string;
  agentType: AgentId;
  title: string;
  status: AgentStatus;
  progress: number;
  productId: string | null;
  workflowId: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

/** 合并后的步骤视图（计划 + 逐步报告 + 实时任务记录） */
export interface LiveStepView {
  taskId: string;
  agent: AgentId;
  agentName: string;
  title: string;
  reason: string;
  displayStatus: WorkflowStepDisplayStatus;
  outcome: WorkflowTaskOutcome | "pending";
  /** `agent_tasks` 里的状态；没有对应记录时为 null */
  liveStatus: AgentStatus | null;
  /** 一句话说明（复用 / 失败 / 未执行的归因） */
  note: string | null;
  /** 被哪些步骤挡住（已翻成标题） */
  blockedByTitles: string[];
  /** 产出对象标识 */
  outputRef: string | null;
  /** 耗时（毫秒）；未结束为 null */
  durationMs: number | null;
  /**
   * 槽位参数。结果卡片要据此拼出「查看内容」的深链
   * （`/content?productId=…&platform=…&format=…`），因此必须随步骤一起带出来 ——
   * 让卡片自己去计划里翻一遍，等于把配对逻辑又抄了一份。
   */
  productId: string | null;
  platform: ContentPlatform | null;
  format: ContentFormat | null;
}

/** 内容任务的匹配键：商品 × 平台 × 形态（三者合起来就是一个槽位） */
function contentKey(agent: string, productId: string | null, platform: unknown, format: unknown): string {
  return `${agent}|${productId ?? ""}|${typeof platform === "string" ? platform : ""}|${typeof format === "string" ? format : ""}`;
}

/**
 * 从 `agent_tasks.input` 里读槽位参数。
 *
 * `input` 是 `Record<string, unknown>`（数据库里是 jsonb），值是**运行时**数据，
 * 因此必须校验而不是断言 —— 写进去的是内容服务，读出来的是这里，
 * 中间隔着一次序列化。判错只影响「深链能不能带上平台参数」，
 * 所以非法值退化为 null（链接指向内容工厂首页），不报错。
 */
function asContentPlatform(value: unknown): ContentPlatform | null {
  return typeof value === "string" &&
    (CONTENT_PLATFORMS as readonly string[]).includes(value)
    ? (value as ContentPlatform)
    : null;
}

function asContentFormat(value: unknown): ContentFormat | null {
  return typeof value === "string" &&
    (CONTENT_FORMATS as readonly string[]).includes(value)
    ? (value as ContentFormat)
    : null;
}

/**
 * 由计划 + 逐步报告 + 实时任务记录合成步骤视图。
 *
 * **为什么可以做配对**（S4-1 曾在服务层刻意回避配对，那是对的，但那只针对
 * 「只有 report 与 agentTasks 两个来源」的情况）：现在配对键是
 * `工作流 id（调用方已按它取的任务） + agent 类型 + 商品 id + 平台 + 形态`，
 * 而一份计划里不可能存在两个「同 Agent、同商品、同槽位」的任务
 * （槽位唯一 + 计划校验器禁止重复任务）。因此这是**精确匹配，不是猜测**。
 *
 * **三级优先**，对应三种时间状态：
 * 1. 已有逐步报告 → 用报告的 `outcome`（这一轮的**最终结论**，权威）；
 * 2. 没有报告但有对应的实时任务记录 → 用任务状态（跑完了 / 正在跑 / 失败）；
 * 3. 两者都没有 → `pending`（还没轮到它）。
 *
 * 第 2 级是「运行中界面」唯一可能的真实来源：摘要要等整轮结束才写库，
 * 在那之前 `agent_tasks` 就是唯一能证明「某一步真的在跑」的证据。
 */
export function buildLiveSteps(params: {
  planTasks: readonly PlanTaskView[];
  summary: Pick<AgentWorkflowSummary, "steps"> | null;
  liveTasks: readonly LiveAgentTaskView[];
  /**
   * 计划快照读不出来时，是否把执行流水里的记录也展示出来。默认 false。
   * 默认**在计划可读时不开**，理由见函数体末尾的说明。
   */
  includeUnplanned?: boolean;
}): LiveStepView[] {
  const { planTasks, summary, liveTasks } = params;

  const reportByTaskId = new Map<string, WorkflowStepReport>(
    (summary?.steps ?? []).map((step) => [step.taskId, step]),
  );

  /**
   * 精确键 → 任务记录。
   *
   * **同一个键可能有多条记录**：一次重试会给同一个槽位再建一条。
   * 这里保留**最先遇到**的那一条，而不是最后一条。
   * 依据是仓储契约「按创建时间倒序」—— 最先遇到的就是最新的一次执行。
   *
   * 为什么不比时间戳：`createdAt` 是**分钟精度**的展示字符串
   * （`formatDateTime` 的结果，如 `2026-09-25 10:24`），同一分钟内的几条记录
   * 时间戳完全相同，比较不出先后；数组顺序才是唯一可靠的时效信号。
   *
   * 取错这一条的后果不是「少显示一步」这么轻：重试期间它会显示上一轮的 `failed`，
   * 商家会以为重试又失败了，而其实新的一轮正在跑。
   */
  const liveByKey = new Map<string, LiveAgentTaskView>();
  /** Agent → 记录数：用于品牌这类「一个工作流只可能有一条」的兜底匹配 */
  const liveByAgent = new Map<string, LiveAgentTaskView[]>();
  for (const task of liveTasks) {
    const key = contentKey(
      task.agentType,
      task.productId,
      task.input?.platform,
      task.input?.format,
    );
    if (!liveByKey.has(key)) {
      liveByKey.set(key, task);
    }
    const list = liveByAgent.get(task.agentType) ?? [];
    list.push(task);
    liveByAgent.set(task.agentType, list);
  }

  const titleById = new Map(planTasks.map((task) => [task.id, task.title]));
  /** 已经被配对过的任务记录 id，用于最后挑出「计划外的任务」 */
  const usedTaskIds = new Set<string>();

  const steps: LiveStepView[] = planTasks.map((task) => {
    const report = reportByTaskId.get(task.id);

    let live: LiveAgentTaskView | undefined = liveByKey.get(
      contentKey(task.agent, task.productId, task.platform, task.format),
    );
    /**
     * 兜底：该 Agent 在本计划里只有一步、而这个工作流下也恰好只有一条它的记录时，
     * 直接配对。品牌档案就是这种情况（全店唯一，且计划里的 `productId` 可能为空，
     * 而记录里的 `productId` 是服务层解析出来的商家主商品，两边对不上）。
     * 加上「计划里只有一步」这个条件，是为了不让兜底覆盖掉精确匹配的结果。
     */
    if (!live) {
      const sameAgent = liveByAgent.get(task.agent) ?? [];
      const plannedSameAgent = planTasks.filter((item) => item.agent === task.agent);
      if (sameAgent.length === 1 && plannedSameAgent.length === 1) {
        live = sameAgent[0];
      }
    }
    if (live) {
      usedTaskIds.add(live.id);
    }

    const outcome = report?.outcome ?? ("pending" as const);
    const displayStatus = toStepDisplayStatus({
      outcome,
      status: live?.status ?? report?.status ?? null,
    });

    return {
      taskId: task.id,
      agent: task.agent,
      agentName: AGENT_NAME_LABEL[task.agent],
      title: toUserFacingPlanText(task.title),
      reason: toUserFacingPlanText(task.reason),
      displayStatus,
      outcome,
      liveStatus: live?.status ?? null,
      note: report?.note ? toUserFacingPlanText(report.note) : null,
      blockedByTitles: (report?.blockedBy ?? []).map(
        (taskId) => titleById.get(taskId) ?? taskId,
      ),
      outputRef: report?.outputRef ?? null,
      durationMs: report?.durationMs ?? live?.durationMs ?? null,
      productId: task.productId,
      platform: task.platform,
      format: task.format,
    };
  });

  /**
   * 计划外的任务 —— **只在计划快照读不出来时**才展示。
   *
   * 什么情况真的需要它：计划 jsonb 读不回来（旧版本写入 / 降级）时 `planTasks` 为空，
   * 但任务记录是真实存在的。若不展示，界面会显示「本轮没有任何步骤」，
   * 而库里明明躺着 3 条执行记录。
   *
   * 为什么计划**可读**时反而不能展示未配对的记录：
   * 一次重试会让同一个槽位留下多轮记录（上一轮失败的 + 这一轮在跑的），
   * 它们与计划里的某一步配对之后，剩下的那些「未配对记录」并不是新步骤，
   * 而是历史。把它们当作步骤列出来，界面会出现重复的同名步骤 ——
   * 商家会以为 AI 把同一件事安排了两遍。
   */
  if (params.includeUnplanned && planTasks.length === 0) {
    for (const task of liveTasks) {
      if (usedTaskIds.has(task.id)) {
        continue;
      }
      steps.push({
        taskId: task.id,
        agent: task.agentType,
        agentName: AGENT_NAME_LABEL[task.agentType],
        title: task.title,
        reason: "这一步不属于当前计划快照（计划可能已不可读），记录直接来自执行流水。",
        displayStatus: toStepDisplayStatus({ outcome: "pending", status: task.status }),
        outcome: "pending",
        liveStatus: task.status,
        note: task.errorMessage,
        blockedByTitles: [],
        outputRef: null,
        durationMs: task.durationMs,
        productId: task.productId,
        // 计划外的记录只能从 input 里读槽位（内容任务会把 platform / format 写进去）
        platform: asContentPlatform(task.input?.platform),
        format: asContentFormat(task.input?.format),
      });
    }
  }

  return steps;
}

/** 由 LiveStepView 统计进度（复用同一套「结局已定」口径） */
export function toLiveProgress(steps: readonly LiveStepView[]): WorkflowProgress {
  return toWorkflowProgress(
    steps.map((step) => ({ outcome: step.outcome, status: step.liveStatus })),
  );
}
