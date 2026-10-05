/**
 * 依赖图与拓扑排序单测
 *
 * 执行器的全部调度行为（并发、跳过传播、顺序）都建立在「这张图是对的」之上，
 * 因此这里把图的每条不变量都钉死：
 * - 拓扑序必须保证前置先于后继（这是执行器敢把 settled 集合当「已完成」的前提）；
 * - 未知依赖被忽略而不是报错（判定权归 plan-validator，两套判定只留一份）；
 * - 成环必须报 PLAN_INVALID 并点名卡住的任务（静默返回假顺序比失败糟得多）。
 */

import { describe, expect, it } from "vitest";

import { buildTaskGraph, pendingDependencies, type PlanGraphNode } from "./dependency-graph";

function node(id: string, dependsOn: readonly string[] = []): PlanGraphNode {
  return { id, dependsOn };
}

/** 断言「任一任务都排在其全部前置之后」—— 拓扑序的定义本身 */
function assertTopologicalOrder(order: readonly string[], tasks: readonly PlanGraphNode[]) {
  const position = new Map(order.map((id, index) => [id, index]));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!position.has(dep)) {
        continue; // 指向未知 id 的依赖被构图忽略
      }
      expect(position.get(dep)!).toBeLessThan(position.get(task.id)!);
    }
  }
}

describe("buildTaskGraph：合法输入", () => {
  it("线性依赖产出一条链，顺序与依赖方向一致", () => {
    const tasks = [node("task-1"), node("task-2", ["task-1"]), node("task-3", ["task-2"])];
    const result = buildTaskGraph(tasks);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.order).toEqual(["task-1", "task-2", "task-3"]);
    assertTopologicalOrder(result.data.order, tasks);
  });

  it("互不依赖的任务保持原始顺序（拓扑序尽量贴近模型给出的展示顺序）", () => {
    const tasks = [node("a"), node("b"), node("c")];
    const result = buildTaskGraph(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.order).toEqual(["a", "b", "c"]);
  });

  it("菱形依赖：d 依赖 b、c，b、c 各依赖 a", () => {
    const tasks = [
      node("a"),
      node("b", ["a"]),
      node("c", ["a"]),
      node("d", ["b", "c"]),
    ];
    const result = buildTaskGraph(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    assertTopologicalOrder(result.data.order, tasks);
    expect(result.data.order.at(-1)).toBe("d");
  });

  it("指向未知 id 的依赖被忽略，不报错（判定权归 plan-validator）", () => {
    const tasks = [node("a"), node("b", ["a", "ghost"])];
    const result = buildTaskGraph(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.dependencies.get("b")).toEqual(["a"]);
    expect(result.data.order).toEqual(["a", "b"]);
  });

  it("重复声明的依赖被去重（否则入度算成 2，拓扑排序永远排不完）", () => {
    const tasks = [node("a"), node("b", ["a", "a", "a"])];
    const result = buildTaskGraph(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.dependencies.get("b")).toEqual(["a"]);
  });

  it("dependencies / dependents 两张索引互为反向", () => {
    const tasks = [node("a"), node("b", ["a"]), node("c", ["a"])];
    const result = buildTaskGraph(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.dependents.get("a")).toEqual(["b", "c"]);
    expect(result.data.dependencies.get("c")).toEqual(["a"]);
    expect(result.data.dependents.get("c")).toBeUndefined();
  });

  it("空任务列表返回空图（执行器对空计划的处理由上游校验器负责）", () => {
    const result = buildTaskGraph([]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.order).toEqual([]);
  });
});

describe("buildTaskGraph：循环依赖", () => {
  it("两任务互相依赖 → PLAN_INVALID，并点名排不出顺序的任务", () => {
    const tasks = [node("task-1", ["task-2"]), node("task-2", ["task-1"])];
    const result = buildTaskGraph(tasks);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("PLAN_INVALID");
    expect(result.error.message).toContain("循环依赖");
    expect(result.error.detail).toContain("task-1");
    expect(result.error.detail).toContain("task-2");
  });

  it("自引用（防御性用例：正常计划已被校验器拦下，这里确认引擎层也不吞）", () => {
    const result = buildTaskGraph([node("task-1", ["task-1"])]);
    expect(result.ok).toBe(false);
  });

  it("环外的任务正常排序，只有环上的任务被点名", () => {
    const tasks = [
      node("free"),
      node("a", ["b"]),
      node("b", ["a"]),
    ];
    const result = buildTaskGraph(tasks);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.detail).toContain("a");
    expect(result.error.detail).toContain("b");
    expect(result.error.detail).not.toContain("free");
  });
});

describe("pendingDependencies", () => {
  const tasks = [node("a"), node("b", ["a"]), node("c", ["a", "b"])];
  const graph = buildTaskGraph(tasks);
  expect(graph.ok).toBe(true);
  if (!graph.ok) {
    throw new Error("测试夹具本身不合法");
  }

  it("前置未结束时返回缺失的依赖", () => {
    expect(pendingDependencies(graph.data, "b", new Set())).toEqual(["a"]);
    expect(pendingDependencies(graph.data, "c", new Set())).toEqual(["a", "b"]);
  });

  it("全部前置已结束返回空数组", () => {
    expect(pendingDependencies(graph.data, "c", new Set(["a", "b"]))).toEqual([]);
  });

  it("只看缺的那一个（部分完成时）", () => {
    expect(pendingDependencies(graph.data, "c", new Set(["a"]))).toEqual(["b"]);
  });

  it("无依赖任务永远返回空数组", () => {
    expect(pendingDependencies(graph.data, "a", new Set())).toEqual([]);
  });
});
