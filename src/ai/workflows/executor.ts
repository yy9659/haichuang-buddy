/**
 * 计划执行器（S4-1）
 *
 * 职责：按依赖关系调度一组任务，**并发上限内并行、依赖满足才启动、上游失败就跳过下游**。
 * 它不认识任何 Agent、不碰数据库、不调用模型 —— 那些通过 `runner` 注入进来。
 * 这样切分的好处很实在：引擎的全部行为（并发、跳过传播、超时、中止）
 * 都能用「一个假的 runner + 一组构造好的任务」测完，不需要起服务或连库。
 *
 * 三条关键语义：
 *
 * 1. **依赖感知失败**：某个任务失败后，依赖它的任务**不会被执行**，而是记为
 *    `skipped / dependency_failed`，并带上「被哪些任务挡住」。
 *    为什么不是「继续跑下游」：内容生成依赖商品理解的结论，上游没产出就往下跑，
 *    下游只能凭空编 —— 那正是这个项目一直在防的「看起来很专业，其实是假的」。
 *
 * 2. **并发上限而非全并行**：同时最多 DEFAULT_MAX_CONCURRENCY 个任务在跑。
 *    全并行看着快，但会瞬间打满模型侧的并发配额，把「快」变成一串 429；
 *    串行又太慢（一份 6 步计划要等 6 个模型的往返）。3 是本轮取的折中值。
 *
 * 3. **任务超时按失败处理，且真的会中断**：超时后不再等 runner 返回，
 *    直接记失败并放开下游。runner 若无视超时信号继续跑完，其结果会被丢弃 ——
 *    这一点是刻意的：任务已经被记为失败，再把迟到的好结果悄悄写进去，
 *    会让「失败」这个结论与事实不符。
 *
 * 关于整轮中止（`signal`）：信号一旦触发，**尚未开始**的任务统一记为
 * `skipped / workflow_aborted`，而不是让它们各自跑一遍再各自超时 ——
 * 后者会在界面上留下一串「失败」，让人误以为任务本身有问题。
 */

import {
  buildTaskGraph,
  pendingDependencies,
} from "./dependency-graph";
import type { ReuseDecision } from "./reuse-resolver";
import type {
  TaskSkipReason,
  WorkflowRunResult,
  WorkflowTaskRecord,
} from "./types";

import type { BusinessPlanDraft, BusinessPlanTaskDraft } from "@/ai/schemas/business-plan";
import type { AgentWorkflowSummary } from "@/repositories/types";
import { ok, type Result } from "@/lib/result";

/** 同时执行的任务数上限 */
export const DEFAULT_MAX_CONCURRENCY = 3;

/**
 * 单个任务的默认超时。
 *
 * 取 2 分钟：本项目的 Agent 都是「一次模型调用 + 一次纠错」的量级，
 * 单次调用在 provider 层另有自己的超时（见 `dashscope.ts`），
 * 这里兜的是「provider 超时没生效 / 调用方忘了传超时」这类兜底场景，
 * 因此给得比单次模型调用宽裕。
 */
export const DEFAULT_TASK_TIMEOUT_MS = 2 * 60 * 1000;

const ABORTED = Symbol("workflow-task-aborted");

/** 执行一个任务所需的一切 */
export interface TaskRunRequest {
  task: BusinessPlanTaskDraft;
  /**
   * 已结束任务的记录，按 task id 索引。
   *
   * 本任务被启动时，它的**全部前置任务都已成功**（失败或跳过的直接不会启动），
   * 因此这里能读到的上游记录一定带有可用产出，可放心取用。
   */
  results: ReadonlyMap<string, WorkflowTaskRecord>;
  /** 任务级取消信号（整轮中止或本任务超时都会触发） */
  signal: AbortSignal;
}

export type TaskRunResponse =
  | {
      ok: true;
      /** 产出对象的标识（内容 id / 品牌档案 id），便于界面跳转 */
      outputRef?: string;
    }
  | {
      ok: false;
      /** 面向商家的中文失败说明（必填 —— 「失败了但不知道哪错了」是没用的信息） */
      errorMessage: string;
      errorCode?: string;
    };

/** 任务执行函数：由服务层提供，内部决定调用哪个 Agent Service 并落库业务结果 */
export type WorkflowTaskRunner = (
  request: TaskRunRequest,
) => Promise<TaskRunResponse>;

export interface ExecutePlanOptions {
  runner: WorkflowTaskRunner;
  /** 复用判定结果；命中的任务不会调用 `runner`，直接记 `reused` */
  reuseDecisions?: ReadonlyMap<string, ReuseDecision>;
  maxConcurrency?: number;
  taskTimeoutMs?: number;
  /** 整轮取消信号（如整轮超时） */
  signal?: AbortSignal;
  /** 可注入时钟，便于测试断言 `durationMs` */
  now?: () => number;
}

/** 统计各分类的任务数 */
export function summarizeTaskRecords(
  records: readonly WorkflowTaskRecord[],
): AgentWorkflowSummary {
  let executed = 0;
  let reused = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of records) {
    switch (record.outcome) {
      case "executed":
        executed += 1;
        break;
      case "reused":
        reused += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "failed":
        failed += 1;
        break;
    }
  }

  return { totalTasks: records.length, executed, reused, skipped, failed };
}

/**
 * 由摘要推导收尾状态。
 *
 * 判据只有「有没有成功」「有没有失败或未执行」，**不看具体是哪个任务**：
 * 编排层不该替商家判断「这一步失败算不算严重」——
 * 例如内容任务失败与商品理解任务失败，对商家的严重程度完全不同，
 * 但那是商家的判断，不是引擎的。引擎只如实说「有成功也有失败」。
 */
function deriveStatus(
  summary: AgentWorkflowSummary,
): WorkflowRunResult["status"] {
  if (summary.failed === 0 && summary.skipped === 0) {
    return "completed";
  }
  const succeeded = summary.executed + summary.reused;
  return succeeded === 0 ? "failed" : "partially_completed";
}

/** 拼一句商家看得懂的结果说明；全绿时返回 null（没坏事就不必说） */
function buildErrorMessage(
  status: WorkflowRunResult["status"],
  summary: AgentWorkflowSummary,
  records: readonly WorkflowTaskRecord[],
): string | null {
  if (status === "completed") {
    return null;
  }

  const parts: string[] = [];
  if (summary.failed > 0) {
    parts.push(`${summary.failed} 个任务失败`);
  }
  if (summary.skipped > 0) {
    parts.push(`${summary.skipped} 个任务未执行`);
  }

  const offenders = records
    .filter(
      (record) => record.outcome === "failed" || record.outcome === "skipped",
    )
    .map((record) => `「${record.title}」`)
    .slice(0, 3)
    .join("、");

  const succeeded = summary.executed + summary.reused;
  const head = parts.join("，");
  const tail = offenders ? `：${offenders}` : "";
  const successNote = succeeded > 0 ? `（成功 ${succeeded} 个）` : "";

  return `${head}${tail}${successNote}`;
}

/**
 * 与取消信号赛跑：信号先到就返回 `ABORTED`，不再等 runner。
 * （见文件头第 3 条 —— 迟到的结果会被丢弃，而不是写进已经判负的记录里。）
 */
function raceWithAbort<T>(
  promise: Promise<T>,
  controller: AbortController,
): Promise<T | typeof ABORTED> {
  if (controller.signal.aborted) {
    return Promise.resolve(ABORTED);
  }
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(ABORTED), {
      once: true,
    });
  });
  return Promise.race([promise, aborted]);
}

/**
 * 按依赖关系执行整份计划。
 *
 * 返回 `Result` 只表达**计划本身没法跑**（成环），因此 `ok: false` 是编排层的失败；
 * 单个任务的失败属于**正常业务结果**，体现在 `WorkflowRunResult` 里，不占用 Result 的失败位。
 * 这个区分很重要：否则「第 3 步失败了」与「这份计划根本不能执行」会被混成同一类错误。
 */
export async function executePlan(
  plan: BusinessPlanDraft,
  options: ExecutePlanOptions,
): Promise<Result<WorkflowRunResult>> {
  const graphResult = buildTaskGraph(plan.tasks);
  if (!graphResult.ok) {
    return graphResult;
  }
  const graph = graphResult.data;

  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  const reuseDecisions = options.reuseDecisions ?? new Map<string, ReuseDecision>();
  const maxConcurrency = Math.max(
    1,
    options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
  );
  const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const parentSignal = options.signal;
  const now = options.now ?? Date.now;

  const records = new Map<string, WorkflowTaskRecord>();
  const settled = new Set<string>();
  /** 正在执行的任务：key 是 task id，value 是「包含收尾动作」的 promise */
  const inFlight = new Map<string, Promise<void>>();

  const baseOf = (task: BusinessPlanTaskDraft) => ({
    taskId: task.id,
    agent: task.agent,
    title: task.title,
  });

  /** 记为未执行（复用与失败之外的第三种结局） */
  const markSkipped = (
    taskId: string,
    skipReason: TaskSkipReason,
    blockedBy?: readonly string[],
  ): void => {
    const task = taskById.get(taskId);
    if (!task || settled.has(taskId)) {
      return;
    }
    const record: WorkflowTaskRecord = {
      ...baseOf(task),
      status: "skipped",
      outcome: "skipped",
      skipReason,
      durationMs: 0,
    };
    if (blockedBy && blockedBy.length > 0) {
      record.blockedBy = [...blockedBy];
    }
    records.set(taskId, record);
    settled.add(taskId);
  };

  /** 执行单个任务：建取消控制器 → 调用 runner → 写记录 → 收尾 */
  const runOne = (taskId: string): Promise<void> => {
    const task = taskById.get(taskId);
    if (!task) {
      return Promise.resolve();
    }

    return (async () => {
      const startedAt = now();
      const controller = new AbortController();
      const relayAbort = (): void => controller.abort();
      parentSignal?.addEventListener("abort", relayAbort, { once: true });
      /**
       * 补一次「已经中止」的检查：`addEventListener` 对**已触发过**的信号
       * 不会再回调，若整轮恰好在上面那次 `aborted` 判断与本行之间被中止，
       * 这个任务就会带着一个永不触发的信号跑到底。
       */
      if (parentSignal?.aborted) {
        controller.abort();
      }
      const timer = setTimeout(() => controller.abort(), taskTimeoutMs);

      try {
        const response = await raceWithAbort(
          options.runner({
            task,
            results: records,
            signal: controller.signal,
          }),
          controller,
        );
        const durationMs = Math.max(0, now() - startedAt);

        if (response === ABORTED) {
          const abortedByWorkflow = parentSignal?.aborted === true;
          records.set(taskId, {
            ...baseOf(task),
            status: "failed",
            outcome: "failed",
            errorMessage: abortedByWorkflow
              ? "整轮执行已中止，本任务未取回结果。"
              : `任务超过 ${Math.round(taskTimeoutMs / 1000)} 秒仍未返回，已按失败处理（模型可能仍在后台运行，其迟到结果会被忽略）。`,
            errorCode: abortedByWorkflow ? "UNKNOWN" : "MODEL_TIMEOUT",
            durationMs,
          });
        } else if (response.ok) {
          const record: WorkflowTaskRecord = {
            ...baseOf(task),
            status: "completed",
            outcome: "executed",
            durationMs,
          };
          if (response.outputRef) {
            record.outputRef = response.outputRef;
          }
          records.set(taskId, record);
        } else {
          const record: WorkflowTaskRecord = {
            ...baseOf(task),
            status: "failed",
            outcome: "failed",
            errorMessage: response.errorMessage,
            durationMs,
          };
          if (response.errorCode) {
            record.errorCode = response.errorCode;
          }
          records.set(taskId, record);
        }
      } catch (cause) {
        /**
         * runner 的约定是「不抛异常，用 `ok: false` 表达失败」。
         * 但真抛了也必须留下一条失败记录 —— 否则这个任务既不在 inFlight、
         * 也没写进 records，会永远「悬空」，整轮执行卡死在等待里。
         */
        const message = cause instanceof Error ? cause.message : String(cause);
        records.set(taskId, {
          ...baseOf(task),
          status: "failed",
          outcome: "failed",
          errorMessage: `任务执行时抛出异常：${message}`,
          errorCode: "UNKNOWN",
          durationMs: Math.max(0, now() - startedAt),
        });
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", relayAbort);
        inFlight.delete(taskId);
        settled.add(taskId);
      }
    })();
  };

  while (settled.size < plan.tasks.length) {
    // 整轮已中止：剩下的统一记为「未执行」，不再逐个启动
    if (parentSignal?.aborted) {
      for (const task of plan.tasks) {
        markSkipped(task.id, "workflow_aborted");
      }
      break;
    }

    let progressed = false;

    for (const task of plan.tasks) {
      const { id } = task;
      if (settled.has(id) || inFlight.has(id)) {
        continue;
      }
      if (inFlight.size >= maxConcurrency) {
        break;
      }
      if (pendingDependencies(graph, id, settled).length > 0) {
        continue;
      }

      // 依赖已全部结束：其中只要有失败或被跳过的，本任务就不再执行
      const blockedBy = (graph.dependencies.get(id) ?? []).filter((dep) => {
        const outcome = records.get(dep)?.outcome;
        return outcome === "failed" || outcome === "skipped";
      });
      if (blockedBy.length > 0) {
        markSkipped(id, "dependency_failed", blockedBy);
        progressed = true;
        continue;
      }

      const decision = reuseDecisions.get(id);
      if (decision) {
        records.set(id, {
          ...baseOf(task),
          status: "completed",
          outcome: "reused",
          reuseReason: decision.reason,
          durationMs: 0,
        });
        settled.add(id);
        progressed = true;
        continue;
      }

      /**
       * 注意顺序：`runOne(id)` 先求值（返回一个**尚未结算**的 promise），
       * 再放进 `inFlight`。runOne 内部只在 `await` 之后才会写 `settled` 并删除自己，
       * 因此这里不可能出现「先删后加」导致 inFlight 永远非空、循环卡死。
       */
      inFlight.set(id, runOne(id));
      progressed = true;
    }

    if (inFlight.size > 0) {
      // 等到「有一个任务连收尾动作一起做完」，再重新计算可启动集合
      await Promise.race(inFlight.values());
    } else if (!progressed) {
      /**
       * 到不了这里：计划已通过校验（无环），且中止在上面处理过，
       * 因此必然存在可推进的任务。留这个分支是为了**不死循环** ——
       * 万一将来有逻辑改坏，宁可提前收尾也不要把整个请求挂死。
       */
      break;
    }
  }

  /**
   * 兜底：把任何仍未结束的任务记账。
   *
   * 正常路径下这里没有剩余（无环 + 每轮必有推进，见上面那个 break 的说明）。
   * 万一命中，原因只可能是「前置任务始终没结束」，因此记为被上游挡住；
   * 若整轮确实被中止过，则如实记为未执行。
   */
  for (const task of plan.tasks) {
    if (settled.has(task.id)) {
      continue;
    }
    markSkipped(
      task.id,
      parentSignal?.aborted ? "workflow_aborted" : "dependency_failed",
      pendingDependencies(graph, task.id, settled),
    );
  }

  /**
   * 输出按**计划顺序**而不是拓扑序排列。
   *
   * 计划的数组顺序就是商家看到的展示顺序（校验器已保证前置任务排在前面），
   * 而拓扑序可能会把互不依赖的任务重排（如 0,2,1），
   * 让界面上的「第 1/2/3 步」与计划文案对不上。
   */
  const orderedRecords: WorkflowTaskRecord[] = [];
  for (const task of plan.tasks) {
    const record = records.get(task.id);
    if (record) {
      orderedRecords.push(record);
    }
  }

  const summary = summarizeTaskRecords(orderedRecords);
  const status = deriveStatus(summary);

  return ok({
    status,
    summary,
    tasks: orderedRecords,
    errorMessage: buildErrorMessage(status, summary, orderedRecords),
  });
}
