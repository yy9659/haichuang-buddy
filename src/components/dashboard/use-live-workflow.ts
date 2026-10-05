"use client";

/**
 * 「看住一轮正在跑的经营任务」的轮询钩子（S4-2）
 *
 * 为什么需要它、以及为什么**不能**只等服务端返回：
 *
 * 本轮的执行方式是「一个 Server Action 里把整轮跑完」（任务书 §27 明确要求
 * 不要引入 Redis / BullMQ）。这意味着**发起执行的那次请求会阻塞到整轮结束**，
 * 短则几秒、长则一两分钟。如果界面只是干等，商家看到的就是一个转圈圈 ——
 * 他既不知道 AI 在做什么，也无从判断是卡住了还是在干活。
 *
 * 关键观察：Server Action 的阻塞**不影响客户端发起别的请求**。
 * 因此这里的做法是「并行观察」：
 *   1. 调用 `startBusinessWorkflowAction`（await 到整轮结束）；
 *   2. **同时**每 2.5 秒调一次 `getBusinessStateAction`，读真实的 `agent_tasks`。
 * 于是商家看到的是真实的执行流水（哪一步在跑、跑了多久、哪一步失败了），
 * 而不是一段编出来的动画（任务书 §28 明令禁止用 setTimeout 模拟 Agent 工作）。
 *
 * 三条边界：
 * - **有上限**：最多 48 次或 3 分钟（任务书 §11 要求设上限、避免无限轮询）。
 *   到点就停下并如实说明「仍在执行，可稍后刷新查看」——
 *   悄悄继续转圈比停下来更糟。
 * - **不在轮询里失效缓存**：`getBusinessStateAction` 刻意不 revalidate，
 *   否则每 2.5 秒整页重渲染一次，界面会抖。
 * - **状态从服务端来**：本钩子不做任何状态推断，只负责搬运。
 */

import * as React from "react";

import { getBusinessStateAction } from "@/actions/business-workflow";
import {
  buildLiveSteps,
  shouldKeepPolling,
  toLiveProgress,
  type LiveStepView,
  type WorkflowProgress,
} from "@/lib/workflow-display";
import type { BusinessWorkflowState } from "@/services/business-brain.service";

/** 轮询间隔：2.5 秒（任务书 §11 的「2~3 秒」取中值） */
export const POLL_INTERVAL_MS = 2500;
/** 最大轮询次数：48 × 2.5s ≈ 2 分钟 */
export const MAX_POLL_ATTEMPTS = 48;
/** 最长轮询时长（毫秒） */
export const MAX_POLL_DURATION_MS = 3 * 60 * 1000;

export interface LiveWorkflowController {
  /** 服务端返回的最新状态；尚未取到为 null */
  state: BusinessWorkflowState | null;
  /** 合并后的步骤视图（计划 + 逐步报告 + 实时任务记录） */
  steps: LiveStepView[];
  /** 真实步数进度 */
  progress: WorkflowProgress;
  /** 正在轮询 */
  polling: boolean;
  /** 本轮轮询到期自动停止（仍在 running）—— 界面要如实说出来 */
  timedOut: boolean;
  error: string | null;
  /** 立刻取一次 */
  refresh: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  /** 直接注入一次状态（发起执行后拿到的返回值可以省掉一次往返） */
  applyState: (next: BusinessWorkflowState | null) => void;
  reset: () => void;
}

export function useLiveWorkflow(workflowId: string | null): LiveWorkflowController {
  const [state, setState] = React.useState<BusinessWorkflowState | null>(null);
  const [polling, setPolling] = React.useState(false);
  const [timedOut, setTimedOut] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /**
   * 用 ref 记住「这一轮观察是否已经被取消」。
   * 不能只靠 effect 的清理函数：`refresh` 是暴露给调用方的普通函数，
   * 商家在请求飞行途中关掉对话框时，它返回后仍会写 state。
   */
  const aliveRef = React.useRef(true);
  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = React.useCallback(async () => {
    if (!workflowId) {
      return;
    }
    const result = await getBusinessStateAction(workflowId);
    if (!aliveRef.current) {
      return;
    }
    if (result.ok) {
      setState(result.data);
      setError(null);
    } else {
      // 轮询失败**不清空**已有状态：留着上一次的真实画面，比突然变成空白好
      setError(result.error.message);
    }
  }, [workflowId]);

  React.useEffect(() => {
    if (!polling || !workflowId) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    const startedAt = Date.now();

    const tick = async (): Promise<void> => {
      const result = await getBusinessStateAction(workflowId);
      if (cancelled) {
        return;
      }

      if (!result.ok) {
        // 单次失败不终止轮询：网络抖动不该让商家丢掉整个实时视图
        setError(result.error.message);
      } else {
        setState(result.data);
        setError(null);
      }

      const status = result.ok ? (result.data?.workflow.status ?? "running") : "running";
      attempts += 1;

      if (
        shouldKeepPolling({
          status,
          attempts,
          maxAttempts: MAX_POLL_ATTEMPTS,
          elapsedMs: Date.now() - startedAt,
          maxDurationMs: MAX_POLL_DURATION_MS,
        })
      ) {
        timer = window.setTimeout(() => {
          void tick();
        }, POLL_INTERVAL_MS);
        return;
      }

      setPolling(false);
      /**
       * 「因为到上限而停」与「因为跑完了而停」是两件完全不同的事，
       * 必须分开告诉商家：前者说明任务可能还在跑（或者卡住了），
       * 后者说明有结论了。这里只标记前者。
       */
      if (status === "idle" || status === "running") {
        setTimedOut(true);
      }
    };

    timer = window.setTimeout(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [polling, workflowId]);

  const steps = React.useMemo(
    () =>
      buildLiveSteps({
        planTasks: state?.plan?.tasks ?? [],
        summary: state?.summary ?? null,
        liveTasks: state?.agentTasks ?? [],
        // 计划读不回来时仍有真实执行记录 —— 不展示它们会让界面谎称「本轮没有步骤」
        includeUnplanned: true,
      }),
    [state],
  );

  const progress = React.useMemo(() => toLiveProgress(steps), [steps]);

  const startPolling = React.useCallback(() => {
    setTimedOut(false);
    setPolling(true);
  }, []);

  const stopPolling = React.useCallback(() => {
    setPolling(false);
  }, []);

  const reset = React.useCallback(() => {
    setPolling(false);
    setTimedOut(false);
    setError(null);
    setState(null);
  }, []);

  return {
    state,
    steps,
    progress,
    polling,
    timedOut,
    error,
    refresh,
    startPolling,
    stopPolling,
    applyState: setState,
    reset,
  };
}
