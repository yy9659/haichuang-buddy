/**
 * 工作流展示映射单测（S4-2）
 *
 * 这一层是任务书里最容易「悄悄说错话」的地方，因此测试围绕四条硬约束展开：
 *
 *   1. **复用不能被说成完成**（§10）。`reused` 与 `executed` 在任务状态上都是
 *      `completed`，但对商家含义相反 —— 前者「没花钱」，后者「真跑了」。
 *   2. **被依赖挡住不能说成失败**（§16）。它根本没运行，说成失败会引导商家
 *      去查一个不存在的错误。
 *   3. **不许伪造进度**（§12）。进度只能是「几步已有着落 / 总步数」，
 *      不能出现百分比，也不能把 `pending` 算成已完成。
 *   4. **运行期间的每一步都要如实更新**。`agent_workflows.summary` 要等整轮结束
 *      才写库，因此整轮执行期间「没有报告」是常态；此时必须靠 `agent_tasks`
 *      的真实状态把「已跑完 / 正在跑 / 没轮到」区分开 ——
 *      否则一轮跑了两个任务，界面上六个步骤全是「等待执行」。
 */

import { describe, expect, it } from "vitest";

import type { AgentWorkflowSummary, WorkflowStepReport } from "@/types";

import {
  STEP_DISPLAY_META,
  buildLiveSteps,
  describeSkippedStep,
  isWorkflowSettled,
  shouldKeepPolling,
  summarizeWorkflowOutcome,
  toLiveProgress,
  toSkipCauseLabel,
  toStepDisplayStatus,
  toWorkflowProgress,
  toWorkflowStatusMeta,
  type LiveAgentTaskView,
  type PlanTaskView,
} from "./workflow-display";

/* ------------------------------------------------------------------ */
/* 构造器                                                              */
/* ------------------------------------------------------------------ */

function planTask(overrides: Partial<PlanTaskView> = {}): PlanTaskView {
  return {
    id: "task-1",
    agent: "product_agent",
    title: "确认「连江鲜活鲍鱼」的商品理解",
    reason: "本次的主推商品是「连江鲜活鲍鱼」。",
    dependsOn: [],
    productId: "prod_001",
    platform: null,
    format: null,
    ...overrides,
  };
}

function liveTask(overrides: Partial<LiveAgentTaskView> = {}): LiveAgentTaskView {
  return {
    id: "live-1",
    agentType: "product_agent",
    title: "分析商品：连江鲜活鲍鱼",
    status: "running",
    progress: 10,
    productId: "prod_001",
    workflowId: "wf_1",
    input: null,
    output: null,
    errorMessage: null,
    durationMs: null,
    createdAt: "2026-09-25 10:00",
    completedAt: null,
    ...overrides,
  };
}

function stepReport(overrides: Partial<WorkflowStepReport> = {}): WorkflowStepReport {
  return {
    taskId: "task-1",
    agent: "product_agent",
    title: "确认商品理解",
    status: "completed",
    outcome: "executed",
    note: null,
    blockedBy: [],
    outputRef: null,
    durationMs: 1200,
    ...overrides,
  };
}

function summary(overrides: Partial<AgentWorkflowSummary> = {}): AgentWorkflowSummary {
  return {
    totalTasks: 1,
    executed: 1,
    reused: 0,
    skipped: 0,
    failed: 0,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 步骤状态映射                                                      */
/* ------------------------------------------------------------------ */

describe("toStepDisplayStatus：报告优先，任务状态兜底", () => {
  it("有报告时以报告为准 —— 即使任务状态看起来是另一回事", () => {
    // 复用与跳过的步骤没有任务记录，两者在这一层必然不一致，以报告为准才不会自相矛盾
    expect(toStepDisplayStatus({ outcome: "executed", status: "failed" })).toBe("executed");
    expect(toStepDisplayStatus({ outcome: "reused", status: "completed" })).toBe("reused");
    expect(toStepDisplayStatus({ outcome: "skipped", status: null })).toBe("not_run");
  });

  it("reused 绝不能被映射成 completed（§10 的核心约束）", () => {
    const reused = toStepDisplayStatus({ outcome: "reused", status: "completed" });
    expect(reused).toBe("reused");
    expect(STEP_DISPLAY_META[reused].label).toBe("已复用");
    expect(STEP_DISPLAY_META[reused].label).not.toBe(STEP_DISPLAY_META.executed.label);
    // 也不靠颜色区分：两者色调不同，但文案与图标本身就必须能区分（无障碍，§29）
    expect(STEP_DISPLAY_META[reused].tone).not.toBe(STEP_DISPLAY_META.executed.tone);
  });

  it("skipped 映射成「未执行」而不是「执行失败」（§16）", () => {
    const status = toStepDisplayStatus({ outcome: "skipped", status: "skipped" });
    expect(status).toBe("not_run");
    expect(STEP_DISPLAY_META[status].label).toBe("未执行");
    expect(status).not.toBe("failed");
  });

  it("没有报告时，用真实任务状态区分「正在跑」「已跑完」「没轮到」", () => {
    // 整轮执行期间没有报告是常态；只看 running 会让已完成的步骤一直显示「等待执行」
    expect(toStepDisplayStatus({ outcome: "pending", status: "running" })).toBe("running");
    expect(toStepDisplayStatus({ outcome: "pending", status: "completed" })).toBe("executed");
    expect(toStepDisplayStatus({ outcome: "pending", status: "failed" })).toBe("failed");
    expect(toStepDisplayStatus({ outcome: "pending", status: "skipped" })).toBe("not_run");
  });

  it("没有报告且任务尚未开始（queued / idle / 无记录）→ 等待执行", () => {
    expect(toStepDisplayStatus({ outcome: "pending", status: "queued" })).toBe("pending");
    expect(toStepDisplayStatus({ outcome: "pending", status: "idle" })).toBe("pending");
    expect(toStepDisplayStatus({ outcome: "pending", status: null })).toBe("pending");
  });
});

/* ------------------------------------------------------------------ */
/* 2. 进度：只能是真实步数                                              */
/* ------------------------------------------------------------------ */

describe("toWorkflowProgress：真实步数，绝不编百分比", () => {
  it("done 统计「结局已定」的步数 —— 包含失败与被挡住", () => {
    const progress = toWorkflowProgress([
      { outcome: "executed", status: "completed" },
      { outcome: "reused", status: null },
      { outcome: "failed", status: "failed" },
      { outcome: "skipped", status: "skipped" },
      { outcome: "pending", status: "running" },
      { outcome: "pending", status: null },
    ]);

    // 失败与被挡住也不会再有下文；不把它们计入，进度条会在失败收尾时永远停在半路
    expect(progress).toEqual({ done: 4, total: 6, running: 1 });
  });

  it("空计划 → 0 / 0（界面据此显示空态，而不是 100%）", () => {
    expect(toWorkflowProgress([])).toEqual({ done: 0, total: 0, running: 0 });
  });

  it("运行中且摘要未写库时，已完成的步骤也计入 done（回归）", () => {
    // 计划 3 步：第一步已跑完、第二步正在跑、第三步没轮到
    const progress = toLiveProgress([
      {
        taskId: "1",
        agent: "product_agent",
        agentName: "商品经理",
        title: "第一步",
        reason: "",
        displayStatus: "executed",
        outcome: "pending",
        liveStatus: "completed",
        note: null,
        blockedByTitles: [],
        outputRef: null,
        durationMs: 100,
        productId: null,
        platform: null,
        format: null,
      },
      {
        taskId: "2",
        agent: "brand_agent",
        agentName: "品牌经理",
        title: "第二步",
        reason: "",
        displayStatus: "running",
        outcome: "pending",
        liveStatus: "running",
        note: null,
        blockedByTitles: [],
        outputRef: null,
        durationMs: null,
        productId: null,
        platform: null,
        format: null,
      },
      {
        taskId: "3",
        agent: "content_agent",
        agentName: "内容运营",
        title: "第三步",
        reason: "",
        displayStatus: "pending",
        outcome: "pending",
        liveStatus: null,
        note: null,
        blockedByTitles: [],
        outputRef: null,
        durationMs: null,
        productId: null,
        platform: null,
        format: null,
      },
    ]);

    expect(progress).toEqual({ done: 1, total: 3, running: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* 3. 结果归纳                                                          */
/* ------------------------------------------------------------------ */

describe("summarizeWorkflowOutcome：经营结果的四类计数", () => {
  it("按逐步报告计数，新增资产只数内容任务", () => {
    const outcome = summarizeWorkflowOutcome({
      summary: null,
      steps: [
        { agent: "product_agent", outcome: "executed" },
        { agent: "brand_agent", outcome: "executed" },
        { agent: "content_agent", outcome: "executed" },
        { agent: "content_agent", outcome: "executed" },
        { agent: "content_agent", outcome: "reused" },
        { agent: "content_agent", outcome: "skipped" },
        { agent: "content_agent", outcome: "failed" },
        { agent: "content_agent", outcome: "pending" },
      ],
    });

    expect(outcome.total).toBe(8);
    expect(outcome.executed).toBe(4);
    expect(outcome.reused).toBe(1);
    expect(outcome.notRun).toBe(1);
    expect(outcome.failed).toBe(1);
    // 商品理解与品牌档案是幕后资产，把它们算进「新增内容」会让数字虚高
    expect(outcome.newAssets).toBe(2);
  });

  it("有摘要时以摘要为准（旧记录没有逐步报告，只能信计数）", () => {
    const outcome = summarizeWorkflowOutcome({
      summary: summary({ totalTasks: 4, executed: 2, reused: 1, skipped: 0, failed: 1 }),
      // 逐步报告缺失：jsonb 降级 / 旧版本写入
      steps: [{ agent: "content_agent", outcome: "executed" }],
    });

    expect(outcome.total).toBe(4);
    expect(outcome.executed).toBe(2);
    expect(outcome.reused).toBe(1);
    expect(outcome.failed).toBe(1);
    // 四类计数与 total 全部取自摘要（它从 S4-1 就有，比本轮才加的逐步报告更可信）
    expect(outcome.notRun).toBe(0);
    // 但「新增内容」只能从逐步报告推：报告缺失时它是 0，而不是拿 executed 顶替
    expect(outcome.newAssets).toBe(1);
  });

  it("空步骤 + 无摘要 → 全 0（不是 NaN、不是 100%）", () => {
    expect(summarizeWorkflowOutcome({ summary: null, steps: [] })).toEqual({
      total: 0,
      executed: 0,
      reused: 0,
      notRun: 0,
      failed: 0,
      newAssets: 0,
    });
  });
});

/* ------------------------------------------------------------------ */
/* 4. 轮询闸门                                                          */
/* ------------------------------------------------------------------ */

describe("shouldKeepPolling：有上限，且收尾即停", () => {
  it("收尾状态一律停（这是避免无限轮询的第一道闸门）", () => {
    for (const status of ["completed", "failed", "partially_completed", "cancelled"] as const) {
      expect(
        shouldKeepPolling({
          status,
          attempts: 0,
          maxAttempts: 48,
          elapsedMs: 0,
          maxDurationMs: 180_000,
        }),
      ).toBe(false);
    }
  });

  it("running 且未超限 → 继续", () => {
    expect(
      shouldKeepPolling({
        status: "running",
        attempts: 5,
        maxAttempts: 48,
        elapsedMs: 12_500,
        maxDurationMs: 180_000,
      }),
    ).toBe(true);
  });

  it("到达次数上限或时长上限 → 停（§11 要求设上限）", () => {
    expect(
      shouldKeepPolling({
        status: "running",
        attempts: 48,
        maxAttempts: 48,
        elapsedMs: 1_000,
        maxDurationMs: 180_000,
      }),
    ).toBe(false);
    expect(
      shouldKeepPolling({
        status: "running",
        attempts: 5,
        maxAttempts: 48,
        elapsedMs: 180_000,
        maxDurationMs: 180_000,
      }),
    ).toBe(false);
  });

  it("isWorkflowSettled 与轮询判据是同一个口径", () => {
    expect(isWorkflowSettled("idle")).toBe(false);
    expect(isWorkflowSettled("running")).toBe(false);
    expect(isWorkflowSettled("partially_completed")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 实时步骤合并                                                      */
/* ------------------------------------------------------------------ */

describe("buildLiveSteps：计划 × 逐步报告 × 执行流水", () => {
  it("计划可读且没有报告时，用执行流水如实呈现每一步（回归）", () => {
    const steps = buildLiveSteps({
      planTasks: [
        planTask({ id: "task-1", productId: "prod_001" }),
        planTask({ id: "task-2", agent: "brand_agent", productId: "prod_001" }),
        planTask({
          id: "task-3",
          agent: "content_agent",
          productId: "prod_001",
          platform: "douyin",
          format: "short-video",
        }),
      ],
      summary: null,
      liveTasks: [
        liveTask({ id: "live-1", agentType: "product_agent", status: "completed" }),
        liveTask({ id: "live-2", agentType: "brand_agent", status: "failed" }),
        liveTask({
          id: "live-3",
          agentType: "content_agent",
          status: "running",
          input: { platform: "douyin", format: "short-video" },
        }),
      ],
      includeUnplanned: true,
    });

    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.displayStatus)).toEqual([
      "executed",
      "failed",
      "running",
    ]);
    // 顺序必须跟计划一致 —— 商家看到的「第 2 步」要是计划里的第 2 步
    expect(steps.map((step) => step.taskId)).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("同一个槽位有多条记录（重试）时，配对的是最新那条，而不是上一轮的失败记录", () => {
    const steps = buildLiveSteps({
      planTasks: [
        planTask({
          id: "task-2",
          agent: "content_agent",
          productId: "prod_001",
          platform: "douyin",
          format: "short-video",
        }),
      ],
      summary: null,
      liveTasks: [
        // 仓储契约：按创建时间倒序，因此最前面的是最新的一次执行
        liveTask({
          id: "live-new",
          agentType: "content_agent",
          status: "running",
          input: { platform: "douyin", format: "short-video" },
        }),
        liveTask({
          id: "live-old",
          agentType: "content_agent",
          status: "failed",
          errorMessage: "上一轮模型超时",
          input: { platform: "douyin", format: "short-video" },
        }),
      ],
      includeUnplanned: true,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]?.liveStatus).toBe("running");
    expect(steps[0]?.displayStatus).toBe("running");
    // 上一轮的历史记录不该作为「额外步骤」冒出来 —— 那看起来像 AI 把同一件事安排了两遍
    expect(steps.map((step) => step.taskId)).toEqual(["task-2"]);
  });

  it("计划可读时，逐条报告是最高优先级（复用不会被历史记录带成「已完成」）", () => {
    const steps = buildLiveSteps({
      planTasks: [planTask({ id: "task-1" })],
      summary: {
        steps: [
          stepReport({
            taskId: "task-1",
            outcome: "reused",
            note: "已有商品理解，本次直接复用。",
          }),
        ],
      },
      // 上一轮留下的记录是 completed，但本轮这一步是复用 —— 报告说了算
      liveTasks: [liveTask({ id: "live-1", status: "completed" })],
      includeUnplanned: true,
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]?.displayStatus).toBe("reused");
    expect(steps[0]?.note).toContain("复用");
  });

  it("品牌兜底配对：计划里商品为空、记录里商品有值，且各只有一条时仍能配上", () => {
    const steps = buildLiveSteps({
      planTasks: [
        planTask({ id: "task-1", agent: "brand_agent", productId: null, title: "确认本店品牌档案" }),
      ],
      summary: null,
      liveTasks: [
        liveTask({ id: "live-brand", agentType: "brand_agent", status: "completed" }),
      ],
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]?.displayStatus).toBe("executed");
  });

  it("兜底不覆盖精确匹配：同 Agent 有多条计划任务时，绝不胡乱配对", () => {
    const steps = buildLiveSteps({
      planTasks: [
        planTask({ id: "task-1", agent: "content_agent", productId: "prod_001", platform: "douyin", format: "short-video" }),
        planTask({ id: "task-2", agent: "content_agent", productId: "prod_001", platform: "xiaohongshu", format: "article" }),
      ],
      summary: null,
      liveTasks: [
        liveTask({ id: "live-1", agentType: "content_agent", status: "running", input: { platform: "douyin", format: "short-video" } }),
      ],
    });

    expect(steps.map((step) => step.displayStatus)).toEqual(["running", "pending"]);
  });

  it("计划读不回来时，执行流水里的记录照样展示（不能谎称「本轮没有步骤」）", () => {
    const steps = buildLiveSteps({
      planTasks: [],
      summary: null,
      liveTasks: [
        liveTask({ id: "live-1", status: "completed" }),
        liveTask({
          id: "live-2",
          agentType: "content_agent",
          status: "running",
          productId: "prod_001",
          input: { platform: "douyin", format: "short-video" },
        }),
      ],
      includeUnplanned: true,
    });

    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.displayStatus)).toEqual(["executed", "running"]);
    // 槽位要从 input 读出来：结果卡片要靠它拼出「查看内容」的深链
    expect(steps[1]?.platform).toBe("douyin");
    expect(steps[1]?.format).toBe("short-video");
  });

  it("不要求展示计划外记录时，计划为空就返回空数组", () => {
    const steps = buildLiveSteps({
      planTasks: [],
      summary: null,
      liveTasks: [liveTask({ id: "live-1", status: "completed" })],
    });

    expect(steps).toEqual([]);
  });

  it("被挡住的步骤带上「是谁挡住了它」的标题（§16）", () => {
    const steps = buildLiveSteps({
      planTasks: [
        planTask({ id: "task-1", title: "确认「连江鲜活鲍鱼」的商品理解" }),
        planTask({ id: "task-2", agent: "brand_agent", title: "确认本店品牌档案" }),
      ],
      summary: {
        steps: [
          stepReport({ taskId: "task-1", outcome: "failed", status: "failed", note: "商品分析失败" }),
          stepReport({
            taskId: "task-2",
            agent: "brand_agent",
            outcome: "skipped",
            status: "skipped",
            note: "上游任务失败，本步因依赖未满足被跳过。",
            blockedBy: ["task-1"],
          }),
        ],
      },
      liveTasks: [],
    });

    expect(steps[1]?.displayStatus).toBe("not_run");
    expect(steps[1]?.blockedByTitles).toEqual(["确认「连江鲜活鲍鱼」的商品理解"]);
    // 绝不能显示成「品牌经理执行失败」
    expect(steps[1]?.displayStatus).not.toBe("failed");
  });
});

/* ------------------------------------------------------------------ */
/* 6. 未执行归因与状态文案                                              */
/* ------------------------------------------------------------------ */

describe("describeSkippedStep / toSkipCauseLabel", () => {
  it("把前置任务 id 翻成标题，并拼上编排层给的原因", () => {
    const titleById = new Map([["task-1", "分析「连江鲜活鲍鱼」"]]);
    const text = describeSkippedStep(
      ["task-1"],
      "上游任务失败，本步因依赖未满足被跳过。",
      titleById,
    );
    expect(text).toContain("分析「连江鲜活鲍鱼」");
    expect(text).toContain("没有执行");
    expect(text).toContain("依赖未满足");
  });

  it("找不到标题时退化为任务 id —— 不好看，但指向的是正确的那一步", () => {
    expect(describeSkippedStep(["task-9"], null, new Map())).toContain("task-9");
  });

  it("没有任何依据时给出一句中性说明，而不是空白", () => {
    expect(describeSkippedStep([], null, new Map())).toBe("本步没有执行。");
  });

  it("跳过原因翻成中文；未知原因原样返回（不编一个像样的说法）", () => {
    expect(toSkipCauseLabel("dependency_failed")).toBe("依赖条件未满足");
    expect(toSkipCauseLabel("workflow_aborted")).toBe("整轮执行被中止");
    expect(toSkipCauseLabel("what_is_this")).toBe("what_is_this");
    expect(toSkipCauseLabel(null)).toBeNull();
  });
});

describe("toWorkflowStatusMeta：与全局状态元数据同一套口径", () => {
  it("部分完成必须是「部分完成」，不能被折叠成 failed 或 completed（§15）", () => {
    expect(toWorkflowStatusMeta("partially_completed").label).toBe("部分完成");
    expect(toWorkflowStatusMeta("partially_completed").label).not.toBe(
      toWorkflowStatusMeta("failed").label,
    );
    expect(toWorkflowStatusMeta("partially_completed").label).not.toBe(
      toWorkflowStatusMeta("completed").label,
    );
  });
});
