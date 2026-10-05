"use client";

import * as React from "react";
import { LoaderCircle, Play } from "lucide-react";

import { retryBusinessWorkflowAction } from "@/actions/business-workflow";
import { WorkflowResultCards } from "@/components/dashboard/workflow-result-cards";
import { WorkflowSteps } from "@/components/dashboard/workflow-steps";
import { useLiveWorkflow } from "@/components/dashboard/use-live-workflow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { WORKFLOW_STATUS_META } from "@/lib/status-meta";
import { toUserFacingPlanText } from "@/lib/user-facing-text";
import type { DashboardWorkflowListItem } from "@/services/dashboard";

/**
 * 单轮经营任务的详情（任务书 §22）。
 *
 * 刻意**不新增路由**（`/dashboard?workflowId=…` 会带来一份新的状态同步负担），
 * 而是复用对话框：点开时才去取这一轮的 `plan` / `steps` / `status`。
 *
 * 「打开时才取」还有一个实际好处：驾驶舱首屏不必为最近 5 轮各读一遍
 * 逐步报告与任务流水 —— 那是 5 倍的数据量，而商家通常只会点开其中一条。
 */
export function WorkflowDetailDialog({
  workflow,
}: {
  workflow: DashboardWorkflowListItem;
}) {
  const [open, setOpen] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<string | null>(null);
  const live = useLiveWorkflow(workflow.id);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      setRetryError(null);
      /**
       * 打开时：先取一次快照；若这一轮仍在跑（或记录停在 running），
       * 就开始轮询 —— 商家点开一条「运行中」的记录，想看的就是它现在的样子。
       */
      void live.refresh().then(() => {
        live.startPolling();
      });
    } else {
      live.stopPolling();
      live.reset();
    }
  }

  /**
   * 一旦拿到状态且已收尾，就停掉轮询（避免对一条终态记录空转）。
   *
   * 依赖里**只放具体的值**（polling / status / stopPolling），不放整个 `live` 对象：
   * 那个对象每次渲染都是新的，把它当依赖会让 effect 每帧都跑；
   * 而里面又调了 `stopPolling`（setState），于是「跑 → 置状态 → 再跑」会转成死循环。
   */
  const liveStatus = live.state?.workflow.status;
  const { polling: livePolling, stopPolling: stopPollingFn } = live;
  React.useEffect(() => {
    if (livePolling && liveStatus && liveStatus !== "running" && liveStatus !== "idle") {
      stopPollingFn();
    }
  }, [livePolling, liveStatus, stopPollingFn]);

  async function handleRetry(): Promise<void> {
    setRetrying(true);
    setRetryError(null);
    live.startPolling();
    const result = await retryBusinessWorkflowAction(workflow.id);
    live.stopPolling();
    setRetrying(false);
    if (!result.ok) {
      setRetryError(result.error.message);
    }
    await live.refresh();
  }

  const status = live.state?.workflow.status ?? workflow.status;
  const meta = WORKFLOW_STATUS_META[status];
  const progress = live.progress;
  const steps = live.steps;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="shrink-0">
          查看详情
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            经营任务详情
            <Badge variant={meta.tone}>{meta.label}</Badge>
          </DialogTitle>
          <DialogDescription className="line-clamp-2">
            {live.state?.workflow.goal ?? workflow.goal}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3.5">
          {retryError ? (
            <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
              {retryError}
            </p>
          ) : null}

          {/* 状态区：状态 / 进度 / 时间 */}
          <div className="rounded-xl border border-border bg-muted/40 px-3.5 py-3">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>执行进度（真实步数）</span>
              <span className="tabular-nums">
                {progress.done} / {progress.total} 步
                {progress.running > 0 ? ` · ${progress.running} 步进行中` : ""}
              </span>
            </div>
            <Progress
              value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0}
              className="mt-1.5"
            />
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-4">
              <div>
                <dt>创建</dt>
                <dd className="text-foreground">{live.state?.workflow.createdAt ?? workflow.createdAt}</dd>
              </div>
              <div>
                <dt>收尾</dt>
                <dd className="text-foreground">
                  {live.state?.workflow.completedAt ?? workflow.completedAt ?? "—"}
                </dd>
              </div>
              <div>
                <dt>商品</dt>
                <dd className="truncate text-foreground">
                  {workflow.productNames.join("、") || "—"}
                </dd>
              </div>
              <div>
                <dt>耗时</dt>
                <dd className="text-foreground">{workflow.durationText ?? "—"}</dd>
              </div>
            </dl>
          </div>

          {live.state?.isStale ? (
            <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
              这条记录停在「运行中」且已超过 10 分钟，执行进程可能已经中断。
              可以重试本轮 —— 已成功的步骤不会重复执行。
            </p>
          ) : null}

          {live.state?.workflow.errorMessage ? (
            <p className="rounded-lg border border-border bg-card px-3 py-2 text-[12px] leading-5">
              <span className="text-muted-foreground">结果说明：</span>
              {live.state.workflow.errorMessage}
            </p>
          ) : null}

          {/* 计划：目标与思路（计划快照读不回来时如实说明） */}
          {live.state && live.state.plan === null ? (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12px] leading-5 text-muted-foreground">
              这一轮的计划快照已不可读（可能是旧版本写入的），
              下面的步骤直接来自真实的执行流水。
            </p>
          ) : null}

          {live.state?.plan ? (
            <div className="rounded-lg border border-border bg-card px-3 py-2">
              <span className="text-[11px] leading-4 text-muted-foreground">
                规划思路
              </span>
              <p className="mt-0.5 text-[12px] leading-5">
                {toUserFacingPlanText(live.state.plan.summary)}
              </p>
            </div>
          ) : null}

          {!live.state && !live.polling ? (
            <p className="text-[12px] leading-5 text-muted-foreground">
              正在读取这一轮的执行明细…
            </p>
          ) : null}

          {steps.length > 0 ? (
            <div>
              <span className="text-[12px] leading-5 font-medium">
                执行步骤
              </span>
              <WorkflowSteps steps={steps} className="mt-1.5" />
            </div>
          ) : null}

          {steps.length > 0 ? (
            <div>
              <span className="text-[12px] leading-5 font-medium">产出</span>
              <WorkflowResultCards steps={steps} className="mt-1.5" />
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          {live.polling ? (
            <span className="mr-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              正在实时刷新（每 2.5 秒）
            </span>
          ) : null}
          <Button variant="ghost" onClick={() => setOpen(false)}>
            关闭
          </Button>
          {live.state?.canRetry ? (
            <Button onClick={() => void handleRetry()} disabled={retrying}>
              {retrying ? (
                <>
                  <LoaderCircle className="animate-spin" />
                  重试中
                </>
              ) : (
                <>
                  <Play />
                  重试未完成任务
                </>
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
