/**
 * Agent 任务记录的共享状态流转规则
 *
 * 为什么抽出来：Mock 与数据库两套实现**必须给出完全一致的语义**，
 * 否则「本地看着对、切到数据库就不对」这种问题会在最不该出现的时候冒出来。
 * 具体来说这两件事最容易写歪，所以统一在这里定义：
 *
 * 1. **终态驱动 completedAt**：进入终态时补上完成时间；重新跑时清空。
 *    具体规则实现在 `./lifecycle.ts`（与工作流共用，保证耗时口径一致）。
 * 2. **首次终态时间优先**：同一次执行里若多次 patch 终态，保留最早的那次，
 *    避免「耗时被最后一次写覆盖」导致口径漂移。
 *
 * 对应 `src/repositories/product-query.ts` 的做法 —— 共享纯逻辑，两套实现共吃。
 */

import { formatDateTime } from "@/lib/datetime";

import { resolveCompletedAt } from "./lifecycle";
import {
  isTerminalAgentStatus,
  type AgentTaskRecord,
  type UpdateAgentTaskInput,
} from "./types";

/** 进度夹取到 0 ~ 100；非法值视为 0，避免界面出现 NaN% */
export function clampTaskProgress(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * 计算下一次的完成时间。
 *
 * 任务这一侧只负责回答「这个状态算不算终态」，时间规则本身交给
 * `./lifecycle.ts`，与工作流共用同一份实现。
 */
export function nextCompletedAt(params: {
  status: AgentTaskRecord["status"];
  currentCompletedAt: Date | string | null;
  now: Date;
}): Date | null {
  return resolveCompletedAt({
    isTerminal: isTerminalAgentStatus(params.status),
    current: params.currentCompletedAt,
    now: params.now,
  });
}

/**
 * 计算下一次的耗时（毫秒）。
 * 耗时描述的是「刚刚结束的那一次运行」，因此：
 * - patch 显式给了耗时 → 用它；
 * - 未给且状态是终态 → 保留原值（上层在收口时应当已经写入）；
 * - 未给且状态非终态 → null（任务正在跑、或刚被重跑，不存在「本次耗时」）
 */
export function nextDurationMs(params: {
  status: AgentTaskRecord["status"];
  currentDurationMs: number | null;
  /** 与 UpdateAgentTaskInput.durationMs 同构：允许显式写 null（清空耗时） */
  patchDurationMs: number | null | undefined;
}): number | null {
  if (params.patchDurationMs !== undefined) {
    return params.patchDurationMs;
  }
  return isTerminalAgentStatus(params.status) ? params.currentDurationMs : null;
}

/**
 * 把 patch 应用到一条任务记录上，返回新记录（不修改入参）。
 * `now` 可注入，便于单测断言 completedAt。
 */
export function applyAgentTaskPatch(
  current: AgentTaskRecord,
  patch: UpdateAgentTaskInput,
  now: Date = new Date(),
): AgentTaskRecord {
  const status = patch.status ?? current.status;
  const completedAt = nextCompletedAt({
    status,
    currentCompletedAt: current.completedAt,
    now,
  });

  return {
    ...current,
    status,
    progress:
      patch.progress === undefined
        ? current.progress
        : clampTaskProgress(patch.progress),
    output: patch.output === undefined ? current.output : patch.output,
    errorMessage:
      patch.errorMessage === undefined ? current.errorMessage : patch.errorMessage,
    durationMs: nextDurationMs({
      status,
      currentDurationMs: current.durationMs,
      patchDurationMs: patch.durationMs,
    }),
    completedAt: completedAt ? formatDateTime(completedAt) : null,
  };
}
