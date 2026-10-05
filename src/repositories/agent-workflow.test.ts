/**
 * 工作流记录的共享纯规则
 *
 * 为什么单独测这一层：`agent_workflows` 的状态流转规则（终态补 `completedAt`、
 * 首次终态时间优先、重开一轮清空统计）被 Mock 与数据库**两套实现共用**。
 * 规则写歪了，两种数据源会给出不同结果，而这类差异通常要等到切到真实库才暴露。
 *
 * 还有一个更具体的原因：`completedAt` 是**展示字符串**（`formatDateTime`，
 * 精度到分钟）。数据库集成测试无法用两条同一分钟内的记录去区分
 * 「保留了最早那次」与「被后一次覆盖」—— 两者格式化后完全一样。
 * 只有在纯函数层注入 `now`，才能把这条规则钉死。
 */

import { describe, expect, it } from "vitest";

import { formatDateTime } from "@/lib/datetime";

import { applyWorkflowPatch, isTerminalWorkflowStatus } from "./agent-workflow";
import { resolveCompletedAt } from "./lifecycle";
import type { AgentWorkflowRecord } from "./types";

function makeRecord(
  overrides: Partial<AgentWorkflowRecord> = {},
): AgentWorkflowRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    businessId: "22222222-2222-2222-2222-222222222222",
    goal: "把三款海产品的内容补齐",
    status: "running",
    plan: null,
    summary: null,
    errorMessage: null,
    createdAt: "2026-09-27 10:00",
    completedAt: null,
    ...overrides,
  };
}

describe("isTerminalWorkflowStatus", () => {
  it("部分完成与取消都算终态（界面按「已结束」看待）", () => {
    expect(isTerminalWorkflowStatus("completed")).toBe(true);
    expect(isTerminalWorkflowStatus("failed")).toBe(true);
    expect(isTerminalWorkflowStatus("partially_completed")).toBe(true);
    expect(isTerminalWorkflowStatus("cancelled")).toBe(true);
  });

  it("运行中的状态不算终态", () => {
    expect(isTerminalWorkflowStatus("idle")).toBe(false);
    expect(isTerminalWorkflowStatus("running")).toBe(false);
  });
});

describe("resolveCompletedAt", () => {
  const now = new Date("2026-09-27T10:20:31.480Z");

  it("非终态一律 null（重开一轮时清空）", () => {
    expect(
      resolveCompletedAt({ isTerminal: false, current: now, now }),
    ).toBeNull();
  });

  it("首次进入终态用 now，且返回 Date 而不是展示字符串", () => {
    const result = resolveCompletedAt({
      isTerminal: true,
      current: null,
      now,
    });
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(now.getTime());
  });

  it("已经有完成时间时保留原值（同一轮里写两次终态，取最早那次）", () => {
    const first = new Date("2026-09-27T10:05:00.000Z");
    const later = new Date("2026-09-27T10:19:00.000Z");
    const result = resolveCompletedAt({
      isTerminal: true,
      current: first,
      now: later,
    });
    expect(result?.getTime()).toBe(first.getTime());
  });
});

describe("applyWorkflowPatch", () => {
  const now = new Date("2026-09-27T10:20:31.480Z");

  it("显式给了才改：未传的字段原样保留", () => {
    const current = makeRecord({
      status: "partially_completed",
      summary: { totalTasks: 3, executed: 2, reused: 0, failed: 1, skipped: 0 },
      errorMessage: "第 2 步失败",
      completedAt: "2026-09-27 10:05",
    });

    const next = applyWorkflowPatch(
      current,
      { status: "failed", errorMessage: "执行器异常退出" },
      now,
    );

    expect(next.status).toBe("failed");
    expect(next.errorMessage).toBe("执行器异常退出");
    // 没传 summary —— 上一轮的统计必须留着，否则界面变成「什么都没跑过」
    expect(next.summary).toEqual(current.summary);
  });

  it("重开一轮：显式传 null 才清空统计与错误", () => {
    const current = makeRecord({
      status: "failed",
      summary: { totalTasks: 3, executed: 2, reused: 0, failed: 1, skipped: 0 },
      errorMessage: "执行器异常退出",
      completedAt: "2026-09-27 10:05",
    });

    const next = applyWorkflowPatch(
      current,
      { status: "running", summary: null, errorMessage: null },
      now,
    );

    expect(next.summary).toBeNull();
    expect(next.errorMessage).toBeNull();
    // 非终态 → 完成时间清空，避免下一轮沿用上一轮的耗时
    expect(next.completedAt).toBeNull();
  });

  /**
   * 这条是 S7 修复的回归点。
   *
   * 规则（见 `./lifecycle`）：同一次执行里写两次终态，保留**最早**那次，
   * 否则界面上的「耗时 = startedAt → completedAt」会被后一次写撑大 ——
   * 一条跑了 3 秒、隔了 10 分钟才被判定失败的工作流会显示成「耗时 10 分钟」。
   *
   * 数据库集成测试断言不了这一条：两次写入落在同一分钟内时，
   * 格式化后的字符串完全一样，「保留最早」与「被覆盖」不可区分。
   */
  it("同一轮内第二次终态不覆盖第一次的完成时间", () => {
    const firstRound = applyWorkflowPatch(
      makeRecord(),
      { status: "partially_completed", summary: { totalTasks: 2 } },
      new Date("2026-09-27T10:05:00.000Z"),
    );

    const secondRound = applyWorkflowPatch(
      firstRound,
      { status: "failed", errorMessage: "执行器异常退出" },
      new Date("2026-09-27T10:19:00.000Z"),
    );

    expect(secondRound.completedAt).toBe(firstRound.completedAt);
    expect(secondRound.completedAt).toBe(
      formatDateTime(new Date("2026-09-27T10:05:00.000Z")),
    );
  });

  it("返回的记录带展示精度的 completedAt（分钟）", () => {
    const next = applyWorkflowPatch(
      makeRecord(),
      { status: "completed" },
      new Date("2026-09-27T10:20:31.480Z"),
    );
    expect(next.completedAt).not.toBeNull();
    // 领域记录只承载展示值；毫秒精度由仓储写库时另行保留
    expect(next.completedAt).not.toContain("31.480");
  });
});
