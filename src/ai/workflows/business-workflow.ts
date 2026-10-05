/**
 * 经营工作流的状态机编排（S4-1）
 *
 * 本模块把「一份计划」变成「一次真实执行」，并负责工作流记录的**状态流转**：
 *
 *   running ──┬─→ completed           （全部任务成功或复用）
 *             ├─→ partially_completed （有成功也有失败 / 未执行）
 *             └─→ failed              （一个都没成，或计划本身不能执行）
 *
 * 它自己不写数据库，也不认识任何 Agent —— 仓储能力与「单个任务怎么执行」都从参数注入：
 * - `agentWorkflows`：只要有 `mark*` 这几个方法的实现即可。这样状态机可以配一个假仓储
 *   单测，不必连库；也避免 AI 层反向依赖具体的仓储实现（依赖方向保持单向）。
 * - `runner`：由服务层提供（它才知道该调哪个 Agent Service、该怎么记 agent_tasks）。
 *
 * 与 `executor.ts` 的分工：执行器回答「任务怎么排、怎么并发、怎么传播失败」，
 * 本模块回答「这一轮整体算什么状态」。两者都只依赖注入进来的东西，因此可以分开测。
 */

import { executePlan, type WorkflowTaskRunner } from "./executor";
import {
  resolveReusableTasks,
  type BusinessStateSnapshot,
} from "./reuse-resolver";
import type {
  TaskSkipReason,
  WorkflowRunResult,
  WorkflowTaskRecord,
} from "./types";

import type { BusinessPlanDraft } from "@/ai/schemas/business-plan";
import { attempt, ok, toAppError, type Result } from "@/lib/result";
import type {
  AgentWorkflowRepository,
  AgentWorkflowSummary,
  WorkflowStepReport,
} from "@/repositories/types";

/** 未执行原因的面向商家文案（与 `TaskSkipReason` 一一对应） */
const SKIP_REASON_LABEL: Readonly<Record<TaskSkipReason, string>> = {
  dependency_failed: "上游任务失败，本步因依赖未满足被跳过。",
  workflow_aborted: "整轮执行已中止，本步未来得及开始。",
};

/**
 * 逐步记录的「一句话说明」。
 *
 * 四种 outcome 各自该说什么是确定的，因此用 switch 穷举而不是 `??` 串联：
 * 串联写法在将来新增一种 outcome 时会静默给出 null，
 * 而穷举会让编译器直接把漏掉的分支指出来。
 */
function toStepNote(record: WorkflowTaskRecord): string | null {
  switch (record.outcome) {
    case "reused":
      return record.reuseReason ?? "已有可用结果，本次直接复用。";
    case "failed":
      return record.errorMessage ?? "该步执行失败。";
    case "skipped":
      return record.skipReason
        ? SKIP_REASON_LABEL[record.skipReason]
        : "该步未执行。";
    case "executed":
      // 顺利跑完的一步不需要额外解释 —— 补一句「成功」只会稀释真正要看的失败信息
      return null;
  }
}

/**
 * 逐任务记录 → 落库用的逐步报告（写进 `agent_workflows.summary.steps`）。
 *
 * 为什么非落库不可：复用与跳过的步骤**从未进入任何 Agent 服务**，
 * 因此不会有 `agent_tasks` 记录。不留这份报告，界面就永远说不清
 * 「计划 5 步为什么只跑了 2 步」——而那正是商家最想问的问题。
 */
function toStepReports(
  records: readonly WorkflowTaskRecord[],
): WorkflowStepReport[] {
  return records.map((record) => ({
    taskId: record.taskId,
    agent: record.agent,
    title: record.title,
    status: record.status,
    outcome: record.outcome,
    note: toStepNote(record),
    // 复制一份：这份报告会被序列化进数据库，不该与执行期对象共享引用
    blockedBy: record.blockedBy ? [...record.blockedBy] : [],
    outputRef: record.outputRef ?? null,
    durationMs: record.durationMs,
  }));
}

/**
 * 状态流转所需的最小仓储能力。
 * 刻意只 `Pick` 用到的四个方法，而不是要求整个 `AgentWorkflowRepository` ——
 * 依赖面越小，测试里伪造它就越省事，实现换掉时影响也越小。
 */
export type WorkflowLifecycleStore = Pick<
  AgentWorkflowRepository,
  "markRunning" | "markCompleted" | "markPartiallyCompleted" | "markFailed"
>;

export interface RunBusinessWorkflowParams {
  workflowId: string;
  plan: BusinessPlanDraft;
  /** 规划开始时的经营状态快照（复用判定用） */
  state: BusinessStateSnapshot;
  /** 工作流状态流转的持久化能力 */
  agentWorkflows: WorkflowLifecycleStore;
  /** 单任务执行函数 */
  runner: WorkflowTaskRunner;
  maxConcurrency?: number;
  taskTimeoutMs?: number;
  /** 整轮取消信号（如整轮超时） */
  signal?: AbortSignal;
  /** 可注入时钟（测试用） */
  now?: () => number;
}

/**
 * 执行一轮经营工作流。
 *
 * 返回值语义：
 * - `ok: false` —— **工作流本身没能跑起来或没能记账**（计划成环、仓储报错）。
 *   这类问题调用方必须当成失败处理，因为界面上的工作流记录也不会是终态。
 * - `ok: true` —— 跑完了。至于「跑得好不好」，看 `data.status` 与逐任务记录。
 *   哪怕 5 个任务全失败，这里也是 `ok: true`：那是**一个正常的业务结果**，
 *   不是调用失败。把它塞进 Result 的失败位会让上层把「业务失败」与「系统故障」混为一谈。
 */
export async function runBusinessWorkflow(
  params: RunBusinessWorkflowParams,
): Promise<Result<WorkflowRunResult>> {
  const { workflowId, plan, state, agentWorkflows, runner } = params;

  // 1. 先落 running：让界面立刻能看到「这一轮开始了」，
  //    也让并发的第二次启动能被 findLatestRunning 挡住
  const started = await attempt(
    () => agentWorkflows.markRunning(workflowId),
    (cause) => toAppError(cause, "DB_ERROR", "启动工作流失败"),
  );
  if (!started.ok) {
    return { ok: false, error: started.error };
  }

  // 2. 复用判定 → 执行
  const reuseDecisions = resolveReusableTasks(plan.tasks, state);

  const executed = await executePlan(plan, {
    runner,
    reuseDecisions,
    ...(params.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: params.maxConcurrency }),
    ...(params.taskTimeoutMs === undefined
      ? {}
      : { taskTimeoutMs: params.taskTimeoutMs }),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.now ? { now: params.now } : {}),
  });

  // 3a. 计划本身不能执行（成环）→ 记为整体失败，把原因原样落到工作流记录上
  if (!executed.ok) {
    const marked = await attempt(
      () =>
        agentWorkflows.markFailed(workflowId, {
          errorMessage: executed.error.message,
        }),
      (cause) => toAppError(cause, "DB_ERROR", "更新工作流状态失败"),
    );
    if (!marked.ok) {
      return { ok: false, error: marked.error };
    }
    return { ok: false, error: executed.error };
  }

  const run = executed.data;

  /**
   * 落库的摘要 = 分类计数 + 逐步报告。
   * 逐步报告一并写进去，是因为复用与跳过的步骤没有 `agent_tasks` 记录，
   * 只能靠它把「哪一步没跑、为什么」留在数据库里。
   */
  const summary: AgentWorkflowSummary = {
    ...run.summary,
    steps: toStepReports(run.tasks),
  };

  // 3b. 按执行结果写终态
  const markedTerminal = await attempt(
    () => {
      switch (run.status) {
        case "completed":
          return agentWorkflows.markCompleted(workflowId, summary);
        case "partially_completed":
          return agentWorkflows.markPartiallyCompleted(workflowId, {
            summary,
            errorMessage: run.errorMessage,
          });
        case "failed":
          return agentWorkflows.markFailed(workflowId, {
            // 走到这里说明有任务失败，`errorMessage` 必然非空；
            // 兜底文案只是为了让类型收窄，不是真实的用户可见路径
            errorMessage: run.errorMessage ?? "本轮所有任务都未能完成",
            summary,
          });
      }
    },
    (cause) => toAppError(cause, "DB_ERROR", "更新工作流状态失败"),
  );
  if (!markedTerminal.ok) {
    return { ok: false, error: markedTerminal.error };
  }

  return ok(run);
}
