/**
 * 依赖图与拓扑序（S4-1）
 *
 * 职责：把「任务 + 前置依赖」变成执行器可以直接用的东西 ——
 * 一张无环图，外加一个**保证前置任务排在被依赖任务之前**的顺序。
 *
 * 与 `plan-validator.ts` 的分工（两者都能发现环，但目的不同）：
 * - **校验器**用三色 DFS 找环，因为它要的是**环的路径**
 *   （「task-2 → task-3 → task-2」），那是给模型纠错和给人排查用的；
 * - **本模块**用 Kahn 拓扑排序算执行顺序，它要的是**顺序本身**；
 *   有环时只知道「剩下的这些排不出来」，不关心路径长什么样。
 *
 * 两套算法看着重复，其实回答的是两个问题。若强行合成一套，
 * 要么校验器报不出路径、要么执行器被迫理解诊断逻辑，两边都变差。
 */

import {
  fail,
  ok,
  type Result,
} from "@/lib/result";

/** 构图只需要这两个字段，因此接受任意带它们的形状（计划任务天然满足） */
export interface PlanGraphNode {
  id: string;
  dependsOn: readonly string[];
}

export interface TaskGraph {
  /** 拓扑序：任一任务都排在其全部前置任务之后 */
  order: readonly string[];
  /** task id → 直接前置依赖（只含图中存在的 id） */
  dependencies: ReadonlyMap<string, readonly string[]>;
  /** task id → 直接后继（谁依赖了我） */
  dependents: ReadonlyMap<string, readonly string[]>;
}

/**
 * 构建依赖图并算出拓扑序。
 *
 * 关于**指向未知 id 的依赖**：这里直接忽略，不报错。
 * 理由是这个函数位于执行路径上，而「引用不存在的任务」是**校验阶段**该拦下来的问题
 * （`validateBusinessPlan` 会以 `INVALID_DEPENDENCY` 拒绝整份计划）。
 * 若这里也报错，同一件事就会在两个地方各有一套判定；若这里抛异常，
 * 执行路径上就多了一个「理论上到不了、真到了就 500」的分支。
 * 忽略它，最坏情况是顺序略有偏差，而校验器保证了这种情况不会发生。
 *
 * 但**成环必须报错**：环意味着顺序根本不存在，此时静默返回一个假顺序
 * 会让执行器跑出一个没人能预测的结果 —— 那比明确失败糟得多。
 */
export function buildTaskGraph(
  tasks: readonly PlanGraphNode[],
): Result<TaskGraph> {
  const knownIds = new Set(tasks.map((task) => task.id));

  const dependencies = new Map<string, readonly string[]>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    // 去重：同一个前置写两遍会让入度算成 2，拓扑排序就永远排不完
    const deps = [...new Set(task.dependsOn)].filter((dep) => knownIds.has(dep));
    dependencies.set(task.id, deps);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(task.id);
      dependents.set(dep, list);
    }
  }

  const indegree = new Map<string, number>();
  for (const task of tasks) {
    indegree.set(task.id, dependencies.get(task.id)?.length ?? 0);
  }

  // 就绪队列按**原始顺序**入队，让拓扑序尽量贴近模型给出的顺序
  const queue: string[] = tasks
    .filter((task) => (indegree.get(task.id) ?? 0) === 0)
    .map((task) => task.id);

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) {
      break;
    }
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }

  if (order.length !== tasks.length) {
    const stuck = tasks
      .map((task) => task.id)
      .filter((id) => !order.includes(id));
    return fail(
      "PLAN_INVALID",
      "任务之间存在循环依赖，无法确定执行顺序",
      `排不出顺序的任务：${stuck.join("、")}`,
    );
  }

  return ok({ order, dependencies, dependents });
}

/**
 * 取某个任务在**给定已完成集合**下尚未满足的前置任务。
 * 执行器用它判断任务能否开始，以及被谁挡住了。
 */
export function pendingDependencies(
  graph: TaskGraph,
  taskId: string,
  settled: ReadonlySet<string>,
): string[] {
  return (graph.dependencies.get(taskId) ?? []).filter(
    (dep) => !settled.has(dep),
  );
}
