/**
 * 计划执行器单测
 *
 * 执行器的价值不在「能跑」，而在**异常路径下的行为是确定的**：
 * 上游失败下游怎么办、超时的迟到结果认不认、整轮中止时未开始的任务记成什么。
 * 这些行为每一条都对应商家会看到的界面文案，错了就是「看起来很专业，其实是假的」。
 *
 * 因此这里全部用「假 runner + 构造好的计划」来测 —— 引擎不认识任何 Agent，
 * 这正是它能被这样测的原因（见 executor.ts 文件头）。
 */

import { describe, expect, it } from "vitest";

import type { BusinessPlanDraft, BusinessPlanTaskDraft } from "@/ai/schemas/business-plan";

import {
  DEFAULT_MAX_CONCURRENCY,
  executePlan,
  summarizeTaskRecords,
  type WorkflowTaskRunner,
} from "./executor";
import type { ReuseDecision } from "./reuse-resolver";
import type { WorkflowTaskRecord } from "./types";

function planTask(overrides: Partial<BusinessPlanTaskDraft> = {}): BusinessPlanTaskDraft {
  return {
    id: "task-1",
    agent: "product_agent",
    title: "分析「连江鲜活鲍鱼」",
    reason: "该商品尚无商品理解。",
    dependsOn: [],
    productId: "prod_001",
    platform: null,
    format: null,
    ...overrides,
  };
}

function plan(tasks: BusinessPlanTaskDraft[]): BusinessPlanDraft {
  return {
    goal: "把鲍鱼的内容做起来",
    summary: "先分析再产出内容。",
    tasks,
    confidence: 0.6,
  };
}

/** 永远成功的 runner，记录每次调用 */
function okRunner(log: string[] = []): WorkflowTaskRunner {
  return async (request) => {
    log.push(request.task.id);
    return { ok: true, outputRef: `ref-${request.task.id}` };
  };
}

function recordOf(records: readonly WorkflowTaskRecord[], taskId: string) {
  const record = records.find((item) => item.taskId === taskId);
  expect(record).toBeDefined();
  return record!;
}

/* ------------------------------------------------------------------ */
/* 1. 正常执行                                                         */
/* ------------------------------------------------------------------ */

describe("executePlan：正常执行", () => {
  it("全部成功 → completed，记录按计划顺序（而非拓扑序）返回", async () => {
    const tasks = [
      planTask({ id: "task-1" }),
      planTask({ id: "task-2", agent: "content_agent", dependsOn: ["task-1"], platform: "douyin", format: "short-video" }),
      planTask({ id: "task-3", productId: "prod_002" }),
    ];
    const result = await executePlan(plan(tasks), { runner: okRunner() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.status).toBe("completed");
    expect(result.data.errorMessage).toBeNull();
    expect(result.data.summary).toEqual({
      totalTasks: 3,
      executed: 3,
      reused: 0,
      skipped: 0,
      failed: 0,
    });
    // 输出顺序 = 计划展示顺序，界面上的「第 1/2/3 步」才能与计划文案对上
    expect(result.data.tasks.map((record) => record.taskId)).toEqual([
      "task-1",
      "task-2",
      "task-3",
    ]);
    for (const record of result.data.tasks) {
      expect(record.status).toBe("completed");
      expect(record.outcome).toBe("executed");
      expect(record.outputRef).toBe(`ref-${record.taskId}`);
    }
  });

  it("依赖保证满足：下游启动时上游产出已在 results 里", async () => {
    const upstreamRefs: (string | undefined)[] = [];
    const runner: WorkflowTaskRunner = async (request) => {
      if (request.task.id === "task-2") {
        upstreamRefs.push(request.results.get("task-1")?.outputRef);
      }
      return { ok: true, outputRef: `ref-${request.task.id}` };
    };

    await executePlan(
      plan([
        planTask({ id: "task-1" }),
        planTask({ id: "task-2", dependsOn: ["task-1"], productId: "prod_002" }),
      ]),
      { runner },
    );
    expect(upstreamRefs).toEqual(["ref-task-1"]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 复用                                                             */
/* ------------------------------------------------------------------ */

describe("executePlan：复用判定", () => {
  it("命中的任务不调用 runner，直接记 reused / completed", async () => {
    const calls: string[] = [];
    const reuseDecisions = new Map<string, ReuseDecision>([
      ["task-1", { taskId: "task-1", reason: "该商品已有商品理解结论。" }],
      ["task-2", { taskId: "task-2", reason: "品牌档案已存在。" }],
    ]);

    const result = await executePlan(
      plan([planTask({ id: "task-1" }), planTask({ id: "task-2", agent: "brand_agent", productId: null })]),
      { runner: okRunner(calls), reuseDecisions },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(calls).toEqual([]); // 一个 Agent 都不该被调用 —— 省钱是这一层的存在理由
    expect(result.data.status).toBe("completed");
    expect(result.data.summary).toEqual({
      totalTasks: 2,
      executed: 0,
      reused: 2,
      skipped: 0,
      failed: 0,
    });
    expect(recordOf(result.data.tasks, "task-1").reuseReason).toBe("该商品已有商品理解结论。");
    expect(recordOf(result.data.tasks, "task-1").durationMs).toBe(0);
  });

  it("复用与执行混合：复用的步骤仍占位，下游照常推进", async () => {
    const calls: string[] = [];
    const reuseDecisions = new Map<string, ReuseDecision>([
      ["task-1", { taskId: "task-1", reason: "该商品已有商品理解结论。" }],
    ]);

    const result = await executePlan(
      plan([
        planTask({ id: "task-1" }),
        planTask({ id: "task-2", agent: "content_agent", dependsOn: ["task-1"], platform: "douyin", format: "short-video" }),
      ]),
      { runner: okRunner(calls), reuseDecisions },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(calls).toEqual(["task-2"]); // 只真的跑了下游
    expect(result.data.status).toBe("completed");
    expect(result.data.summary.reused).toBe(1);
    expect(result.data.summary.executed).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 失败传播                                                         */
/* ------------------------------------------------------------------ */

describe("executePlan：依赖感知失败", () => {
  it("上游失败 → 下游记 skipped / dependency_failed 并点名阻塞来源，整体 partially_completed", async () => {
    const runner: WorkflowTaskRunner = async (request) =>
      request.task.id === "task-1"
        ? { ok: false, errorMessage: "模型服务暂时不可用", errorCode: "MODEL_UNAVAILABLE" }
        : { ok: true };

    const result = await executePlan(
      plan([
        planTask({ id: "task-1" }),
        planTask({ id: "task-2", agent: "content_agent", dependsOn: ["task-1"], platform: "douyin", format: "short-video" }),
        planTask({ id: "task-3", productId: "prod_002" }),
      ]),
      { runner },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.status).toBe("partially_completed");

    const failed = recordOf(result.data.tasks, "task-1");
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("模型服务暂时不可用");
    expect(failed.errorCode).toBe("MODEL_UNAVAILABLE");

    const skipped = recordOf(result.data.tasks, "task-2");
    expect(skipped.outcome).toBe("skipped");
    expect(skipped.skipReason).toBe("dependency_failed");
    expect(skipped.blockedBy).toEqual(["task-1"]);

    // 与计划无关的 task-3 不受牵连
    expect(recordOf(result.data.tasks, "task-3").outcome).toBe("executed");

    // 商家要看得懂哪里出了问题
    expect(result.data.errorMessage).toContain("1 个任务失败");
    expect(result.data.errorMessage).toContain("1 个任务未执行");
    expect(result.data.errorMessage).toContain("「");
  });

  it("跳过也会向下游传播：A 失败 → B 被跳过 → 依赖 B 的 C 同样被跳过", async () => {
    const runner: WorkflowTaskRunner = async (request) =>
      request.task.id === "a" ? { ok: false, errorMessage: "失败" } : { ok: true };

    const result = await executePlan(
      plan([
        planTask({ id: "a" }),
        planTask({ id: "b", dependsOn: ["a"], productId: "prod_002" }),
        planTask({ id: "c", dependsOn: ["b"], productId: "prod_003" }),
      ]),
      { runner },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(recordOf(result.data.tasks, "b").skipReason).toBe("dependency_failed");
    expect(recordOf(result.data.tasks, "c").skipReason).toBe("dependency_failed");
    // c 被挡的直接原因是 b（a 没结束不在 settled？不 —— a 已失败进 settled，
    // 但 c 的直接依赖只有 b，因此 blockedBy 只含 b）
    expect(recordOf(result.data.tasks, "c").blockedBy).toEqual(["b"]);
  });

  it("全部失败 → 整体 failed", async () => {
    const runner: WorkflowTaskRunner = async () => ({
      ok: false,
      errorMessage: "模型服务暂时不可用",
    });

    const result = await executePlan(
      plan([planTask({ id: "task-1" }), planTask({ id: "task-2", productId: "prod_002" })]),
      { runner },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.status).toBe("failed");
    expect(result.data.summary.failed).toBe(2);
    expect(result.data.errorMessage).toContain("2 个任务失败");
  });
});

/* ------------------------------------------------------------------ */
/* 4. 成环计划                                                         */
/* ------------------------------------------------------------------ */

describe("executePlan：计划本身不能执行", () => {
  it("成环计划 → Result 失败（PLAN_INVALID），不进入执行", async () => {
    const calls: string[] = [];
    const result = await executePlan(
      plan([
        planTask({ id: "task-1", dependsOn: ["task-2"] }),
        planTask({ id: "task-2", dependsOn: ["task-1"], productId: "prod_002" }),
      ]),
      { runner: okRunner(calls) },
    );

    // 「计划不能跑」是编排层失败，占用 Result 的失败位 —— 与单个任务失败严格区分
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("PLAN_INVALID");
    expect(calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 并发上限                                                         */
/* ------------------------------------------------------------------ */

describe("executePlan：并发控制", () => {
  it("maxConcurrency=1 时严格串行，且同时只有 1 个任务在跑", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const runner: WorkflowTaskRunner = async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(request.task.id);
      // 让出一轮事件循环，给「并发失控」留出暴露的机会
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true };
    };

    const result = await executePlan(
      plan([
        planTask({ id: "task-1" }),
        planTask({ id: "task-2", productId: "prod_002" }),
        planTask({ id: "task-3", productId: "prod_003" }),
      ]),
      { runner, maxConcurrency: 1 },
    );

    expect(result.ok).toBe(true);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("默认并发上限为 3（防全并行打满模型配额）", () => {
    expect(DEFAULT_MAX_CONCURRENCY).toBe(3);
  });

  it("互不依赖的三个任务在默认上限内可以并行", async () => {
    let active = 0;
    let maxActive = 0;
    const runner: WorkflowTaskRunner = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { ok: true };
    };

    const result = await executePlan(
      plan([
        planTask({ id: "task-1" }),
        planTask({ id: "task-2", productId: "prod_002" }),
        planTask({ id: "task-3", productId: "prod_003" }),
      ]),
      { runner },
    );

    expect(result.ok).toBe(true);
    expect(maxActive).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 超时                                                             */
/* ------------------------------------------------------------------ */

describe("executePlan：任务超时", () => {
  it("超时按失败处理（MODEL_TIMEOUT），迟到的好结果被丢弃", async () => {
    /**
     * runner 在超时信号触发**之后**才异步返回成功 —— 这个迟到的好结果必须被丢弃。
     * 注意必须异步（`setTimeout`）返回：若在 abort 事件里同步 resolve，
     * 它会先于 `raceWithAbort` 自己的监听器结算，反而「赢」了这场竞速，
     * 那就测不到「迟到结果被丢弃」这条语义了。
     */
    const runner: WorkflowTaskRunner = (request) =>
      new Promise((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => setTimeout(() => resolve({ ok: true }), 20),
          { once: true },
        );
      });

    const result = await executePlan(
      plan([
        planTask({ id: "task-1" }),
        planTask({ id: "task-2", dependsOn: ["task-1"], productId: "prod_002" }),
      ]),
      { runner, taskTimeoutMs: 30 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const timedOut = recordOf(result.data.tasks, "task-1");
    expect(timedOut.status).toBe("failed");
    expect(timedOut.errorCode).toBe("MODEL_TIMEOUT");
    expect(timedOut.errorMessage).toContain("按失败处理");
    // 迟到的 `{ ok: true }` 没有覆盖掉这条失败记录
    expect(timedOut.outcome).toBe("failed");

    // 下游被超时的上游挡住
    const skipped = recordOf(result.data.tasks, "task-2");
    expect(skipped.skipReason).toBe("dependency_failed");
    expect(skipped.blockedBy).toEqual(["task-1"]);

    expect(result.data.status).toBe("failed");
  }, 10_000);
});

/* ------------------------------------------------------------------ */
/* 7. 异常与中止                                                       */
/* ------------------------------------------------------------------ */

describe("executePlan：runner 抛异常", () => {
  it("异常被记为失败而不是让整轮卡死", async () => {
    const runner: WorkflowTaskRunner = async (request) => {
      if (request.task.id === "task-1") {
        throw new Error("runner 内部炸了");
      }
      return { ok: true };
    };

    const result = await executePlan(
      plan([planTask({ id: "task-1" }), planTask({ id: "task-2", productId: "prod_002" })]),
      { runner },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const record = recordOf(result.data.tasks, "task-1");
    expect(record.status).toBe("failed");
    expect(record.errorMessage).toContain("runner 内部炸了");
    // 另一个任务不受牵连
    expect(recordOf(result.data.tasks, "task-2").outcome).toBe("executed");
  });
});

describe("executePlan：整轮中止（signal）", () => {
  it("开始前就中止 → 全部记 skipped / workflow_aborted，不调用 runner", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();

    const result = await executePlan(
      plan([planTask({ id: "task-1" }), planTask({ id: "task-2", productId: "prod_002" })]),
      { runner: okRunner(calls), signal: controller.signal },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(calls).toEqual([]);
    for (const record of result.data.tasks) {
      expect(record.outcome).toBe("skipped");
      expect(record.skipReason).toBe("workflow_aborted");
    }
    // 一个都没成：failed=0 但 skipped>0 且无成功 → failed
    expect(result.data.status).toBe("failed");
  });

  it("运行中中止：在跑的记失败（整轮执行已中止），未开始的记 skipped", async () => {
    const controller = new AbortController();

    // task-1 一直挂到信号触发；task-2 依赖 task-1，因此尚未开始
    // （同上：迟到结果必须异步返回，否则会先于竞速的中止分支结算）
    const runner: WorkflowTaskRunner = (request) =>
      new Promise((resolve) => {
        const finish = () => setTimeout(() => resolve({ ok: true }), 20);
        if (request.signal.aborted) {
          finish();
          return;
        }
        request.signal.addEventListener("abort", finish, { once: true });
      });

    const timer = setTimeout(() => controller.abort(), 20);
    try {
      const result = await executePlan(
        plan([
          planTask({ id: "task-1" }),
          planTask({ id: "task-2", dependsOn: ["task-1"], productId: "prod_002" }),
        ]),
        { runner, signal: controller.signal, taskTimeoutMs: 5_000 },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const running = recordOf(result.data.tasks, "task-1");
      expect(running.status).toBe("failed");
      expect(running.errorMessage).toContain("整轮执行已中止");

      const pending = recordOf(result.data.tasks, "task-2");
      expect(pending.outcome).toBe("skipped");
      expect(pending.skipReason).toBe("workflow_aborted");
    } finally {
      clearTimeout(timer);
    }
  }, 10_000);
});

/* ------------------------------------------------------------------ */
/* 8. 可观测性                                                         */
/* ------------------------------------------------------------------ */

describe("executePlan：耗时统计", () => {
  it("durationMs 来自注入的时钟（复用与跳过恒为 0）", async () => {
    let tick = 0;
    const result = await executePlan(
      plan([planTask({ id: "task-1" }), planTask({ id: "task-2", productId: "prod_002" })]),
      {
        runner: async () => {
          tick += 100;
          return { ok: true };
        },
        now: () => tick,
        reuseDecisions: new Map([["task-2", { taskId: "task-2", reason: "已有结果" }]]),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(recordOf(result.data.tasks, "task-1").durationMs).toBe(100);
    expect(recordOf(result.data.tasks, "task-2").durationMs).toBe(0);
  });
});

describe("summarizeTaskRecords", () => {
  it("四种结局各自计数，不混淆", () => {
    const summary = summarizeTaskRecords([
      { taskId: "a", agent: "product_agent", title: "A", status: "completed", outcome: "executed", durationMs: 1 },
      { taskId: "b", agent: "product_agent", title: "B", status: "completed", outcome: "reused", durationMs: 0 },
      { taskId: "c", agent: "product_agent", title: "C", status: "skipped", outcome: "skipped", durationMs: 0 },
      { taskId: "d", agent: "product_agent", title: "D", status: "failed", outcome: "failed", durationMs: 1 },
    ]);
    expect(summary).toEqual({
      totalTasks: 4,
      executed: 1,
      reused: 1,
      skipped: 1,
      failed: 1,
    });
  });
});
