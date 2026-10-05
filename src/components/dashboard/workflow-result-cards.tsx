import Link from "next/link";
import {
  ArrowRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  ChartNoAxesCombined,
  FileText,
  MessageCircleMore,
  Package,
  Palette,
  Radio,
  Recycle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CONTENT_FORMAT_LABEL, CONTENT_PLATFORM_LABEL, WORKFLOW_STATUS_META } from "@/lib/status-meta";
import {
  STEP_DISPLAY_META,
  type LiveStepView,
  type WorkflowOutcomeSummary,
  type WorkflowProgress,
} from "@/lib/workflow-display";
import { cn } from "@/lib/utils";
import type { AgentId, IconComponent, WorkflowStatus } from "@/types";

/** Agent → 图标（结果卡片上用来快速区分是哪位员工的产出） */
const AGENT_ICON: Record<AgentId, IconComponent> = {
  business_brain: FileText,
  product_agent: Package,
  brand_agent: Palette,
  content_agent: FileText,
  live_agent: Radio,
  customer_service_agent: MessageCircleMore,
  analytics_agent: ChartNoAxesCombined,
};

/**
 * 经营结果摘要（任务书 §13）。
 *
 * 每个数字都是**真实计数**，没有一个是估算的：
 * - 「真实执行」= 实际调用了 AI 员工的步数（会花钱的那部分）；
 * - 「复用未重跑」= 已有结果、本次没有再次调用 AI 的步数（省下来的那部分）；
 *   两者分开列，是因为它们的和才是计划步数，合并会让商家算不清账；
 * - 「新增可发布内容」只数内容任务 —— 商品理解与品牌档案是幕后资产，
 *   把它们算进「新增资产」会让数字虚高，而虚高迟早会在内容工厂里被数穿。
 */
export function WorkflowResultSummary({
  goal,
  status,
  progress,
  outcome,
  durationText,
  errorMessage,
}: {
  goal: string;
  status: WorkflowStatus;
  progress: WorkflowProgress;
  outcome: WorkflowOutcomeSummary;
  durationText: string | null;
  errorMessage: string | null;
}) {
  const meta = WORKFLOW_STATUS_META[status];
  const succeeded = outcome.executed + outcome.reused;

  const metrics: { label: string; value: string; tone?: "success" | "danger" | "warning" }[] = [
    { label: "计划任务", value: `${outcome.total}` },
    { label: "真实执行", value: `${outcome.executed}` },
    { label: "复用未重跑", value: `${outcome.reused}` },
    { label: "新增可发布内容", value: `${outcome.newAssets}`, tone: "success" },
  ];
  if (outcome.notRun > 0) {
    metrics.push({ label: "未执行", value: `${outcome.notRun}`, tone: "warning" });
  }
  if (outcome.failed > 0) {
    metrics.push({ label: "失败", value: `${outcome.failed}`, tone: "danger" });
  }
  if (durationText) {
    metrics.push({ label: "总耗时", value: durationText });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-border bg-muted/40 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={meta.tone}>{meta.label}</Badge>
          {/*
            部分完成时**必须**先说清楚「几步成了」，而不是只丢一个「部分完成」。
            §15 明确要求：3 / 4 步成功 —— 这个分数是真实的，且比状态词更有信息量。
          */}
          {status === "partially_completed" ? (
            <span className="text-[12px] leading-5 text-warning">
              {succeeded} / {progress.total} 步成功，其余未完成
            </span>
          ) : null}
        </div>
        <p className="mt-1.5 text-[12px] leading-5">
          <span className="text-muted-foreground">经营目标：</span>
          {goal}
        </p>
        {errorMessage ? (
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
            {errorMessage}
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="rounded-lg border border-border bg-card px-3 py-2"
          >
            <dt className="text-[11px] leading-4 text-muted-foreground">
              {metric.label}
            </dt>
            <dd
              className={cn(
                "text-[15px] leading-6 font-semibold tabular-nums",
                metric.tone === "success" && "text-success",
                metric.tone === "danger" && "text-destructive",
                metric.tone === "warning" && "text-warning",
              )}
            >
              {metric.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 步骤数组按 Agent 归组（保持计划顺序） */
function groupByAgent(steps: readonly LiveStepView[]) {
  const groups = new Map<AgentId, LiveStepView[]>();
  for (const step of steps) {
    const list = groups.get(step.agent) ?? [];
    list.push(step);
    groups.set(step.agent, list);
  }
  return [...groups.entries()];
}

/** 结果卡片上的「查看产出」入口（按 Agent 决定去哪、怎么说） */
function resolveResultLink(
  agent: AgentId,
  steps: readonly LiveStepView[],
): { href: string; label: string } | null {
  switch (agent) {
    case "product_agent": {
      const productId = steps.find((step) => step.productId)?.productId;
      return productId
        ? { href: `/products/${productId}`, label: "查看商品理解" }
        : null;
    }
    case "brand_agent":
      return { href: "/brand", label: "查看品牌档案" };
    case "content_agent": {
      /**
       * 深链到**第一条真正有内容**的槽位。
       * 优先挑「已完成 / 已复用」的那条 —— 深链到一条生成失败的槽位只会让商家
       * 看到失败页，而他刚刚才在结果卡片上被告知这一步是坏消息。
       */
      const step =
        steps.find(
          (item) =>
            item.displayStatus === "executed" || item.displayStatus === "reused",
        ) ?? steps[0];
      if (!step?.productId) {
        return { href: "/content", label: "查看内容工厂" };
      }
      const query = new URLSearchParams({ productId: step.productId });
      if (step.platform) {
        query.set("platform", step.platform);
      }
      if (step.format) {
        query.set("format", step.format);
      }
      return { href: `/content?${query.toString()}`, label: "查看生成内容" };
    }
    case "customer_service_agent":
      return { href: "/customer-service", label: "查看客服预演" };
    case "live_agent":
      return { href: "/live", label: "查看直播建议" };
    case "analytics_agent":
      return { href: "/analytics", label: "查看经营报告" };
    default:
      return null;
  }
}

/** 一组步骤的结果说明（如「复用已有商品理解」「生成抖音短视频脚本」） */
function describeGroup(steps: readonly LiveStepView[]): string {
  const statuses = steps.map((step) => step.displayStatus);
  if (statuses.every((status) => status === "reused")) {
    return steps.length > 1
      ? `复用已有结果（${steps.length} 项，本次未重复调用 AI）`
      : "复用已有结果（本次未重复调用 AI）";
  }
  if (statuses.every((status) => status === "failed" || status === "not_run")) {
    return steps.length > 1 ? `${steps.length} 项未能完成` : "本步未能完成";
  }
  const done = steps.filter((step) => step.displayStatus === "executed");
  const others = steps.length - done.length;
  if (done.length > 0 && others === 0) {
    return done
      .map((step) =>
        step.agent === "content_agent" && step.platform && step.format
          ? `已生成${CONTENT_PLATFORM_LABEL[step.platform]}${CONTENT_FORMAT_LABEL[step.format]}`
          : step.title,
      )
      .join("；");
  }
  return `${done.length} 项已完成，${others} 项未完成`;
}

/**
 * 逐 Agent 的结果卡片（任务书 §14）。
 *
 * 按 Agent 归组而不是按步骤罗列：商家关心的是「商品经理干了什么 / 内容运营
 * 产出了什么」，而不是「第 1 步、第 2 步」。一个 Agent 产出多项时
 * （如两条内容），描述行会用「；」串起来，仍然是一张卡片 ——
 * 拆成两张会让「内容运营」这个名字重复出现，看着像两个不同的员工。
 */
export function WorkflowResultCards({
  steps,
  className,
}: {
  steps: readonly LiveStepView[];
  className?: string;
}) {
  const groups = groupByAgent(steps).filter(([agent]) =>
    steps.some((step) => step.agent === agent),
  );

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className={cn("grid gap-2.5 sm:grid-cols-2", className)}>
      {groups.map(([agent, agentSteps]) => {
        const Icon = AGENT_ICON[agent];
        const hasResult = agentSteps.some(
          (step) => step.displayStatus === "executed" || step.displayStatus === "reused",
        );
        const link = hasResult ? resolveResultLink(agent, agentSteps) : null;
        const worst = agentSteps.some(
          (step) => step.displayStatus === "failed",
        );
        const anyNotRun = agentSteps.some(
          (step) => step.displayStatus === "not_run",
        );
        const anyPendingOrRunning = agentSteps.some(
          (step) =>
            step.displayStatus === "pending" || step.displayStatus === "running",
        );
        const StatusIcon = worst
          ? CircleX
          : anyPendingOrRunning || anyNotRun
            ? CircleSlash
            : CircleCheck;
        const statusLabel = worst ? "失败" : anyNotRun ? "未执行" : null;

        return (
          <div
            key={agent}
            className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3.5 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                <Icon className="size-3.5" strokeWidth={1.9} />
              </span>
              <span className="text-[13px] leading-5 font-semibold">
                {agentSteps[0]?.agentName ?? ""}
              </span>
              <span
                className={cn(
                  "ml-auto flex size-5 items-center justify-center rounded-full",
                  worst
                    ? "text-destructive"
                    : anyPendingOrRunning || anyNotRun
                      ? "text-muted-foreground"
                      : "text-success",
                )}
                role="img"
                aria-label={statusLabel ?? (anyPendingOrRunning ? "进行中" : "已完成")}
              >
                <StatusIcon className="size-4" />
              </span>
            </div>

            <p className="text-[12px] leading-5 text-muted-foreground">
              {describeGroup(agentSteps)}
            </p>

            {statusLabel ? (
              <span className={cn("text-[11px]", worst ? "text-destructive" : "text-muted-foreground")}>
                {statusLabel}
              </span>
            ) : null}

            {agentSteps.some((step) => step.displayStatus === "reused") ? (
              <span className="inline-flex w-fit items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                <Recycle className="size-3" />
                {STEP_DISPLAY_META.reused.label}
              </span>
            ) : null}

            {link ? (
              <Button
                asChild
                size="sm"
                variant="outline"
                className="mt-auto w-fit"
              >
                <Link href={link.href}>
                  {link.label}
                  <ArrowRight />
                </Link>
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
