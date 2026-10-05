/**
 * 工作流记录的共享纯规则（S4-1）
 *
 * 为什么要单独一个文件（与 `agent-task.ts` / `content-item.ts` 同一理由）：
 * Mock 与数据库两套仓储必须表现**完全一致**，否则「切数据源不改页面」这条约定会被破坏。
 * 凡是「不依赖存储介质」的常量、判定与状态合并一律放这里。
 *
 * 与 `agent-task.ts` 的分工：任务与工作流的**终态集合不同**（工作流多了
 * `partially_completed` / `cancelled`），所以「哪些算终态」各自定义；
 * 但「终态时间怎么定」共用 `./lifecycle.ts`，保证界面耗时口径一致。
 */

import { formatDateTime } from "@/lib/datetime";
import {
  isAgentId,
  isAgentStatus,
  type WorkflowStatus,
} from "@/types";

import { resolveCompletedAt } from "./lifecycle";
import type {
  AgentWorkflowRecord,
  AgentWorkflowSummary,
  WorkflowStepReport,
  WorkflowTaskOutcome,
} from "./types";

/**
 * 终态集合：进入这些状态时仓储会自动写入 `completedAt`，非终态则清空。
 *
 * `cancelled` 也算终态 —— 人工中止的工作流不会再自己动起来，
 * 界面应当把它当「已结束」而不是「还在跑」。
 */
export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  "completed",
  "failed",
  "partially_completed",
  "cancelled",
];

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.includes(status);
}

/**
 * 全 0 摘要。
 *
 * 刻意不用它替代「没有摘要」：`null` 表示「这一轮还没跑完，没有统计」，
 * 而全 0 是一个**结论**（跑了，但一项都没成）。两者在界面上要说的话完全不同。
 */
export const EMPTY_WORKFLOW_SUMMARY: Readonly<AgentWorkflowSummary> = {
  totalTasks: 0,
  executed: 0,
  reused: 0,
  skipped: 0,
  failed: 0,
};

/** 逐步报告里的 outcome 取值清单（运行时校验用，与类型用 `satisfies` 绑定） */
const WORKFLOW_TASK_OUTCOMES = [
  "executed",
  "reused",
  "skipped",
  "failed",
] as const satisfies readonly WorkflowTaskOutcome[];

function isWorkflowTaskOutcome(value: unknown): value is WorkflowTaskOutcome {
  return (
    typeof value === "string" &&
    (WORKFLOW_TASK_OUTCOMES as readonly string[]).includes(value)
  );
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 把 jsonb 里的逐步报告读成强类型。
 *
 * **逐项校验、脏项丢弃**：这份数据会随版本演进（旧记录可能缺字段），
 * 让一条读不出来的报告把整个工作流视图打崩，是最不划算的降级方式。
 * 宁可少显示一步，也不要整页报错 —— 但绝不会伪造一条出来。
 */
function toStepReports(value: unknown): WorkflowStepReport[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const reports: WorkflowStepReport[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const { taskId, agent, title, status, outcome } = record;
    // taskId 是它与计划之间的唯一纽带，缺了就没有意义
    if (typeof taskId !== "string" || !taskId) {
      continue;
    }
    if (!isAgentId(agent) || !isAgentStatus(status) || !isWorkflowTaskOutcome(outcome)) {
      continue;
    }
    const note = typeof record.note === "string" ? record.note : null;
    const outputRef = typeof record.outputRef === "string" ? record.outputRef : null;
    const durationMs =
      typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
        ? Math.max(0, record.durationMs)
        : 0;
    reports.push({
      taskId,
      agent,
      title: typeof title === "string" ? title : "",
      status,
      outcome,
      note,
      blockedBy: readStringList(record.blockedBy),
      outputRef,
      durationMs,
    });
  }
  return reports;
}

/** 从 jsonb 列读回摘要：字段缺失或脏值一律降级为 0，不让脏数据把视图打崩 */
export function toWorkflowSummary(
  value: Record<string, unknown> | null,
): AgentWorkflowSummary | null {
  if (value === null) {
    return null;
  }
  const readCount = (key: keyof AgentWorkflowSummary): number => {
    const raw = value[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return 0;
    }
    return Math.max(0, Math.round(raw));
  };
  return {
    totalTasks: readCount("totalTasks"),
    executed: readCount("executed"),
    reused: readCount("reused"),
    skipped: readCount("skipped"),
    failed: readCount("failed"),
    steps: toStepReports(value.steps),
  };
}

/**
 * 一次状态流转要改的东西。
 *
 * 只列出状态机真正关心的字段。通用 `update(id, patch)` 不提供 ——
 * 工作流的 `status` 与 `completedAt`/`summary`/`errorMessage` 是绑定关系，
 * 开放通用 patch 太容易写出「标了 completed 却没写 summary」这种半成品状态。
 */
export interface WorkflowPatch {
  status: WorkflowStatus;
  /** 显式给 `null` 表示清空（用于「重新跑，作废上一轮结果」） */
  summary?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

/**
 * 把 patch 应用到一条工作流记录上，返回新记录（不修改入参）。
 * `now` 可注入，便于单测断言 `completedAt`。
 *
 * 语义是朴素的「**显式给了才改**」：没给的字段原样保留。
 * 因此「开始新一轮时要清掉上一轮的错误与统计」这件事由调用方显式传入 `null`，
 * 而不是在这里做隐式清空 —— 隐式规则读代码时看不出来。
 */
export function applyWorkflowPatch(
  current: AgentWorkflowRecord,
  patch: WorkflowPatch,
  now: Date = new Date(),
): AgentWorkflowRecord {
  const completedAt = resolveCompletedAt({
    isTerminal: isTerminalWorkflowStatus(patch.status),
    current: current.completedAt,
    now,
  });

  return {
    ...current,
    status: patch.status,
    summary:
      patch.summary === undefined ? current.summary : patch.summary,
    errorMessage:
      patch.errorMessage === undefined
        ? current.errorMessage
        : patch.errorMessage,
    completedAt: completedAt ? formatDateTime(completedAt) : null,
  };
}
