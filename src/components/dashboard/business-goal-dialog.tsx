"use client";

import * as React from "react";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  LoaderCircle,
  Play,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  createBusinessPlanAction,
  retryBusinessWorkflowAction,
  startBusinessWorkflowAction,
} from "@/actions/business-workflow";
import { WorkflowResultCards, WorkflowResultSummary } from "@/components/dashboard/workflow-result-cards";
import { WorkflowStepItem } from "@/components/dashboard/workflow-steps";
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
import {
  BUSINESS_GOAL_CHANNELS,
  MAX_BUSINESS_GOAL_LENGTH,
  buildBusinessGoalText,
  type BusinessGoalChannel,
} from "@/lib/business-goal";
import type { AppErrorShape } from "@/lib/result";
import { AGENT_NAME_LABEL, WORKFLOW_STATUS_META } from "@/lib/status-meta";
import { toUserFacingPlanText } from "@/lib/user-facing-text";
import { cn } from "@/lib/utils";
import {
  summarizeWorkflowOutcome,
  toLiveProgress,
  type LiveStepView,
} from "@/lib/workflow-display";
import type { BusinessPlanResult, WorkflowRunView } from "@/services/business-brain.service";
import type { DashboardProductOption } from "@/services/dashboard";
import type { WorkflowStatus } from "@/types";

type DialogStep = "form" | "planned" | "executing" | "result";
type GoalTemplateId = "custom" | "promotion" | "service" | "live" | "full_chain";

const GOAL_TEMPLATES: readonly {
  id: Exclude<GoalTemplateId, "custom">;
  label: string;
  goal: string;
  channels: readonly string[];
}[] = [
  { id: "promotion", label: "推广素材", goal: "为这件商品准备可发布的推广素材", channels: ["douyin"] },
  { id: "service", label: "客服答疑", goal: "预演这件商品的常见顾客问题，检查回答依据", channels: [] },
  { id: "live", label: "直播彩排", goal: "围绕这件商品预演直播提问和主播回答", channels: [] },
  { id: "full_chain", label: "六岗位全链路", goal: "完成六岗位全链路：商品理解、品牌、推广素材、客服答疑、直播彩排与工作复盘", channels: ["douyin"] },
];

export interface BusinessGoalDialogProps {
  /** 可规划的商品（服务端已连同「是否已有商品理解」一起取回） */
  products: readonly DashboardProductOption[];
  /** 当前是否允许发起（有正在执行的一轮时为 false —— 与并发保护同一个判据） */
  canLaunch: boolean;
  /** 正在执行的那一轮的目标，用于把 RATE_LIMITED 说清楚 */
  activeGoal: string | null;
  /** 是否需要提示「当前是 Mock 模型通道」 */
  isMock: boolean;
  triggerLabel?: string;
  triggerClassName?: string;
  triggerSize?: "sm" | "default" | "lg";
  triggerVariant?: "default" | "secondary" | "outline" | "soft";
}

/**
 * 「启动今日经营」对话框（S4-2 主流程）。
 *
 * 六个步骤对应任务书 §5：
 *   填写目标 → 生成计划 → 展示计划 → 确认执行 → 实时状态 → 经营结果
 *
 * 三条纪律贯穿全组件：
 * - **人拥有最终确认权**：计划生成后**绝不自动执行**，必须等商家点
 *   「确认并启动 AI 团队」。这条不只是提示词里的礼貌，而是产品立场
 *   （技术文档 5.4）：AI 建议、人拍板。
 * - **不伪造任何进度**：执行中的每一行状态都来自 `agent_tasks` 的真实记录，
 *   进度是「几步已有着落 / 总步数」。没有百分比，没有用 setTimeout 演的动画。
 * - **不静默失败**：任何错误都翻成中文提示落在界面上；server action 已把
 *   开发者向的 `detail` 剥掉，这里不展示任何内部结构。
 */
export function BusinessGoalDialog({
  products,
  canLaunch,
  activeGoal,
  isMock,
  triggerLabel = "制定经营目标",
  triggerClassName,
  triggerSize = "lg",
  triggerVariant = "default",
}: BusinessGoalDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState<DialogStep>("form");

  const [goal, setGoal] = React.useState("");
  const [selectedTemplate, setSelectedTemplate] = React.useState<GoalTemplateId>("custom");
  const [productId, setProductId] = React.useState<string>(products[0]?.id ?? "");
  const [targetAudience, setTargetAudience] = React.useState("");
  const [channelValues, setChannelValues] = React.useState<string[]>([]);

  const [planning, setPlanning] = React.useState(false);
  const [executing, setExecuting] = React.useState(false);
  const [planResult, setPlanResult] = React.useState<BusinessPlanResult | null>(null);
  const [runResult, setRunResult] = React.useState<WorkflowRunView | null>(null);
  const [error, setError] = React.useState<AppErrorShape | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);

  const live = useLiveWorkflow(planResult?.workflowId ?? null);

  const selectedProduct = products.find((product) => product.id === productId) ?? null;
  const selectedChannels: BusinessGoalChannel[] = React.useMemo(
    () =>
      BUSINESS_GOAL_CHANNELS.filter((channel) =>
        channelValues.includes(channel.platform),
      ),
    [channelValues],
  );

  /** 与服务端**同一个函数**算出的最终文本，因此预览不会与实际发给模型的不一致 */
  const goalDraft = React.useMemo(
    () =>
      buildBusinessGoalText({
        goal,
        productName: selectedProduct?.name ?? null,
        targetAudience,
        channels: selectedChannels,
        fullChain: selectedTemplate === "full_chain",
      }),
    [goal, selectedProduct, targetAudience, selectedChannels, selectedTemplate],
  );

  const canSubmit =
    goal.trim().length > 0 && goalDraft.length <= MAX_BUSINESS_GOAL_LENGTH && productId !== "" &&
    (selectedTemplate !== "full_chain" || channelValues.length > 0);

  function applyTemplate(id: GoalTemplateId): void {
    if (id === "custom") {
      const previous = GOAL_TEMPLATES.find((item) => item.id === selectedTemplate);
      if (previous?.goal === goal) setGoal("");
      setSelectedTemplate("custom");
      return;
    }
    setSelectedTemplate(id);
    const template = GOAL_TEMPLATES.find((item) => item.id === id);
    if (template) {
      setGoal(template.goal);
      setChannelValues([...template.channels]);
    }
  }

  /** 打开时重置到第一步：上次的目标与结果不该带到这一次 */
  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      return;
    }
    setGoal("");
    setSelectedTemplate("custom");
    setProductId(products[0]?.id ?? "");
    setTargetAudience("");
    setChannelValues([]);
    setStep("form");
    setPlanResult(null);
    setRunResult(null);
    setError(null);
    setExecuting(false);
    setPlanning(false);
    live.reset();
  }

  function toggleChannel(platform: string): void {
    setChannelValues((current) =>
      current.includes(platform)
        ? current.filter((value) => value !== platform)
        : [...current, platform],
    );
  }

  /** 第 2 步：让经营大脑制定计划（**只规划、不执行**） */
  async function handlePlan(): Promise<void> {
    if (!canSubmit || planning) {
      return;
    }
    setPlanning(true);
    setError(null);

    const result = await createBusinessPlanAction({
      goal: goal.trim(),
      productId,
      targetAudience: targetAudience.trim() || null,
      channels: channelValues,
      fullChain: selectedTemplate === "full_chain",
    });

    setPlanning(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPlanResult(result.data);
    setStep("planned");
  }

  /** 第 4 步：确认后启动。这里才是真正花钱的地方 */
  async function handleStart(): Promise<void> {
    if (!planResult || executing) {
      return;
    }
    setExecuting(true);
    setError(null);
    setStep("executing");
    setElapsedMs(0);

    /**
     * 立刻开始观察，**不等**发起请求返回。
     * 执行请求会阻塞到整轮结束，而观察请求是独立的 ——
     * 这正是「实时状态」在不引入队列的前提下唯一的真实来源。
     */
    live.startPolling();

    const result = await startBusinessWorkflowAction(planResult.workflowId);
    live.stopPolling();
    setExecuting(false);

    if (!result.ok) {
      setError(result.error);
    } else {
      setRunResult(result.data);
    }
    // 无论成败都重新取一次状态：成功要拿到带逐步报告的最终记录，失败也要看到最后的真相
    await live.refresh();
    setStep("result");
  }

  /** 重试：复用判定会自动跳过已成功的步骤，因此这里不必挑任务 */
  async function handleRetry(): Promise<void> {
    const workflowId = planResult?.workflowId;
    if (!workflowId || executing) {
      return;
    }
    setExecuting(true);
    setError(null);
    setStep("executing");
    setElapsedMs(0);
    setRunResult(null);
    live.startPolling();

    const result = await retryBusinessWorkflowAction(workflowId);
    live.stopPolling();
    setExecuting(false);

    if (!result.ok) {
      setError(result.error);
    } else {
      setRunResult(result.data);
    }
    await live.refresh();
    setStep("result");
  }

  /** 执行中的计时器：让商家知道已经等了多久（真实经过时间，不是进度估算） */
  React.useEffect(() => {
    if (step !== "executing") {
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 500);
    return () => window.clearInterval(timer);
  }, [step]);

  const liveProgress = live.progress;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          size={triggerSize}
          variant={triggerVariant}
          className={triggerClassName}
          aria-haspopup="dialog"
        >
          {canLaunch ? <Play /> : <LoaderCircle className="animate-spin" />}
          {canLaunch ? triggerLabel : "已有任务执行中"}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {step === "form" ? "制定经营目标" : null}
            {step === "planned" ? "执行计划" : null}
            {step === "executing" ? "协同执行中" : null}
            {step === "result" ? "本次准备结果" : null}
          </DialogTitle>
          <DialogDescription>
            {step === "form"
              ? "选一个场景或写下自己的目标，先看计划，再决定是否执行。"
              : null}
            {step === "planned"
              ? "确认后才会开始执行，你也可以返回修改。"
              : null}
            {step === "executing"
              ? "各岗位正在按计划顺序协同执行。"
              : null}
            {step === "result"
              ? "这一轮的真实执行结果，以及可以直接查看的产出。"
              : null}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3.5">
          {/* —— 并发保护提示（与服务端 RATE_LIMITED 同一个判据） —— */}
          {!canLaunch && step === "form" ? (
            <Notice tone="danger" icon={<TriangleAlert className="size-3.5" />}>
              当前已有经营任务正在执行，请等待完成。
              {activeGoal ? `正在执行的目标：${activeGoal}` : ""}
            </Notice>
          ) : null}

          {isMock ? (
            <Notice tone="warning" icon={<CircleAlert className="size-3.5" />}>
              当前为演示模式，结果用于展示操作流程。
            </Notice>
          ) : null}

          {error ? (
            <Notice tone="danger" icon={<X className="size-3.5" />}>
              <span className="font-medium">{error.message}</span>
              {error.retryable ? "（这一项可以重试）" : ""}
            </Notice>
          ) : null}

          {step === "form" ? (
            <>
              <FormStep
                products={products}
                selectedTemplate={selectedTemplate}
                onTemplateChange={applyTemplate}
                goal={goal}
                onGoalChange={setGoal}
                productId={productId}
                onProductChange={setProductId}
                targetAudience={targetAudience}
                onTargetAudienceChange={setTargetAudience}
                channelValues={channelValues}
                onToggleChannel={toggleChannel}
                preview={goalDraft.text}
                previewTooLong={goalDraft.length > MAX_BUSINESS_GOAL_LENGTH}
              />
              <p className="text-[11px] leading-5 text-muted-foreground">
                制定计划会调用模型；确认计划后才会启动岗位任务。
              </p>
            </>
          ) : null}

          {step === "planned" && planResult ? (
            <PlanStep plan={planResult} />
          ) : null}

          {step === "executing" ? (
            <ExecutingStep
              steps={live.steps}
              progress={liveProgress}
              elapsedMs={elapsedMs}
              goal={planResult?.plan.goal ?? ""}
              polling={live.polling}
              timedOut={live.timedOut}
            />
          ) : null}

          {step === "result" ? (
            <ResultStep
              status={live.state?.workflow.status ?? runResult?.status ?? "failed"}
              goal={planResult?.plan.goal ?? live.state?.workflow.goal ?? ""}
              steps={live.steps}
              durationText={runResult?.durationText ?? null}
              errorMessage={
                live.state?.workflow.errorMessage ?? runResult?.errorMessage ?? null
              }
              canRetry={live.state?.canRetry ?? false}
            />
          ) : null}
        </DialogBody>

        <DialogFooter>
          {step === "form" ? (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button
                onClick={() => void handlePlan()}
                disabled={!canSubmit || planning || !canLaunch}
                aria-busy={planning}
              >
                {planning ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    正在制定计划
                  </>
                ) : (
                  <>
                    <Sparkles />
                    制定计划
                  </>
                )}
              </Button>
            </>
          ) : null}

          {step === "planned" ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setPlanResult(null);
                  setStep("form");
                }}
                disabled={executing}
              >
                <ArrowLeft />
                返回修改
              </Button>
              <Button onClick={() => void handleStart()} disabled={executing}>
                <Play />
                确认并开始执行
              </Button>
            </>
          ) : null}

          {step === "executing" ? (
            <span className="text-[11px] text-muted-foreground">
              请勿关闭窗口。任务在服务端独立执行，关闭后重新打开仍可查看结果。
            </span>
          ) : null}

          {step === "result" ? (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                关闭
              </Button>
              {live.state?.canRetry ? (
                <Button
                  variant="outline"
                  onClick={() => void handleRetry()}
                  disabled={executing}
                >
                  重试未完成任务
                </Button>
              ) : null}
              <Button
                onClick={() => {
                  setPlanResult(null);
                  setRunResult(null);
                  setError(null);
                  live.reset();
                  setStep("form");
                }}
              >
                <Check />
                再安排一轮
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* 局部：提示条                                                        */
/* ------------------------------------------------------------------ */

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "warning" | "danger" | "neutral";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-5",
        tone === "danger" && "border-destructive/20 bg-destructive/10 text-destructive",
        tone === "warning" && "border-warning/25 bg-warning/12 text-warning",
        tone === "neutral" && "border-border bg-muted/50 text-muted-foreground",
      )}
      role={tone === "danger" ? "alert" : "status"}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 第 1 步：填写经营目标                                               */
/* ------------------------------------------------------------------ */

function FormStep({
  products,
  selectedTemplate,
  onTemplateChange,
  goal,
  onGoalChange,
  productId,
  onProductChange,
  targetAudience,
  onTargetAudienceChange,
  channelValues,
  onToggleChannel,
  preview,
  previewTooLong,
}: {
  products: readonly DashboardProductOption[];
  selectedTemplate: GoalTemplateId;
  onTemplateChange: (id: GoalTemplateId) => void;
  goal: string;
  onGoalChange: (value: string) => void;
  productId: string;
  onProductChange: (value: string) => void;
  targetAudience: string;
  onTargetAudienceChange: (value: string) => void;
  channelValues: string[];
  onToggleChannel: (platform: string) => void;
  preview: string;
  previewTooLong: boolean;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      <fieldset className="space-y-2">
        <legend className="text-[12px] font-medium">这次想做什么</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {GOAL_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => onTemplateChange(template.id)}
              aria-pressed={selectedTemplate === template.id}
              className={cn(
                "rounded-xl border px-2.5 py-2.5 text-left text-[12px] font-medium transition-colors",
                selectedTemplate === template.id
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-card text-foreground hover:border-primary/35",
              )}
            >
              {template.label}
            </button>
          ))}
        </div>
        {selectedTemplate !== "custom" ? (
          <button type="button" onClick={() => onTemplateChange("custom")}
            className="text-[11px] text-muted-foreground hover:text-foreground">
            改为自定义目标
          </button>
        ) : <p className="text-[11px] text-muted-foreground">也可以直接在下方输入自己的目标。</p>}
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] leading-5 font-medium">
          主推商品 <span className="text-destructive">*</span>
        </span>
        {products.length === 0 ? (
          <span className="text-[12px] leading-5 text-muted-foreground">
            商品中心还没有商品，先去添加一件再来制定计划。
          </span>
        ) : (
          <select
            value={productId}
            onChange={(event) => onProductChange(event.target.value)}
            className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
                {product.hasDna ? "（已有商品理解）" : "（尚无商品理解）"}
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] leading-5 font-medium">
          这次要完成什么 <span className="text-destructive">*</span>
        </span>
        <textarea
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
          rows={3}
          maxLength={MAX_BUSINESS_GOAL_LENGTH}
          placeholder="例如：为这件商品准备抖音推广素材，或预演顾客答疑"
          className="resize-none rounded-lg border border-border bg-card px-2.5 py-2 text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </label>

      {selectedTemplate === "full_chain" ? (
        <p className="rounded-lg bg-primary-soft px-3 py-2 text-[11px] leading-5 text-primary">
          计划必须包含六个岗位；已有商品与品牌成果会在执行时复用。客服和直播属于模拟预演，不连接真实平台。
        </p>
      ) : null}

      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] leading-5 font-medium">
          目标用户（可选）
        </span>
        <input
          value={targetAudience}
          onChange={(event) => onTargetAudienceChange(event.target.value)}
          maxLength={60}
          placeholder="例如：注重食材新鲜度的年轻家庭"
          className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </label>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-[12px] leading-5 font-medium">目标渠道</legend>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {selectedTemplate === "full_chain"
            ? "全链路至少选择一个内容渠道；每个渠道会安排一份素材。"
            : "需要制作素材时再选渠道；每个渠道会安排一份素材。"}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {BUSINESS_GOAL_CHANNELS.map((channel) => {
            const active = channelValues.includes(channel.platform);
            return (
              <button
                key={channel.platform}
                type="button"
                onClick={() => onToggleChannel(channel.platform)}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  active
                    ? "border-primary/20 bg-primary-soft text-primary"
                    : "border-border bg-card text-muted-foreground hover:bg-secondary/60",
                )}
              >
                {active ? <Check className="size-3" /> : null}
                {channel.label}
                <span className="text-[11px] opacity-70">{channel.formatLabel}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] leading-4 text-muted-foreground">
            目标预览
          </span>
          <span
            className={cn(
              "text-[11px] tabular-nums",
              previewTooLong ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {preview.length} / {MAX_BUSINESS_GOAL_LENGTH}
          </span>
        </div>
        <p className="mt-1 text-[12px] leading-5">
          {preview || "（还没有填写经营目标）"}
        </p>
        {previewTooLong ? (
          <p className="mt-1 text-[11px] leading-4 text-destructive">
            超出上限了。请精简目标描述，或减少勾选的渠道 —— 系统不会替你截断，
            因为被截掉的很可能正是「今晚」「年轻家庭」这类关键限定词。
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 第 3 步：计划确认                                                   */
/* ------------------------------------------------------------------ */

function PlanStep({ plan }: { plan: BusinessPlanResult }) {
  const reusable = new Set(plan.reusePreview.reusableTaskIds);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <span className="text-[11px] leading-4 text-muted-foreground">
          经营目标
        </span>
        <p className="mt-0.5 text-[13px] leading-5 font-medium">
          {plan.plan.goal}
        </p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          {toUserFacingPlanText(plan.plan.summary)}
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-2">
        <PlanMetric
          label="预计执行任务"
          value={`${plan.reusePreview.executableCount}`}
        />
        <PlanMetric
          label="可直接复用"
          value={`${plan.reusePreview.reusableCount}`}
          tone="neutral"
        />
        <PlanMetric
          label="预计生成内容"
          value={`${plan.reusePreview.expectedContentCount}`}
          tone="success"
        />
      </dl>

      {plan.reusePreview.reusableCount > 0 ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          已有资料会直接复用，避免重复处理。
        </p>
      ) : null}

      <div>
        <span className="text-[12px] leading-5 font-medium">执行步骤</span>
        <ol className="mt-1.5 flex flex-col">
          {plan.plan.tasks.map((task, index) => {
            const isReused = reusable.has(task.id);
            return (
              <li
                key={task.id}
                className="flex gap-3 border-b border-border/60 py-2 last:border-b-0"
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
                    isReused
                      ? "bg-muted text-muted-foreground"
                      : "bg-primary-soft text-primary",
                  )}
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] leading-5 font-medium">
                      {AGENT_NAME_LABEL[task.agent]}
                    </span>
                    <Badge variant={isReused ? "neutral" : "primary"}>
                      {isReused ? "复用已有结果" : "待执行"}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-[12px] leading-5">
                    {toUserFacingPlanText(task.title)}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    {toUserFacingPlanText(task.reason)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {plan.warnings.length > 0 ? (
        <Notice tone="warning" icon={<TriangleAlert className="size-3.5" />}>
          {plan.warnings.map(toUserFacingPlanText).join("；")}
        </Notice>
      ) : null}
    </div>
  );
}

function PlanMetric({
  label,
  value,
  tone = "primary",
}: {
  label: string;
  value: string;
  tone?: "primary" | "neutral" | "success";
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <dt className="text-[11px] leading-4 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-[16px] leading-6 font-semibold tabular-nums",
          tone === "primary" && "text-primary",
          tone === "neutral" && "text-muted-foreground",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 第 5 步：实时执行                                                   */
/* ------------------------------------------------------------------ */

function ExecutingStep({
  steps,
  progress,
  elapsedMs,
  goal,
  polling,
  timedOut,
}: {
  steps: readonly LiveStepView[];
  progress: { done: number; total: number; running: number };
  elapsedMs: number;
  goal: string;
  polling: boolean;
  timedOut: boolean;
}) {
  return (
    <div className="flex flex-col gap-3" aria-busy={polling} aria-live="polite">
      <div className="rounded-xl border border-border bg-muted/40 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <LoaderCircle className="size-4 animate-spin text-primary" />
          <span className="text-[13px] leading-5 font-semibold">
            AI 团队正在工作
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            已用时 {(elapsedMs / 1000).toFixed(1)}s
          </span>
        </div>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          {goal}
        </p>
        <div className="mt-2.5 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>步骤进度（真实步数，非估算）</span>
            <span className="tabular-nums">
              {progress.done} / {progress.total} 步
            </span>
          </div>
          <Progress
            value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0}
          />
        </div>
      </div>

      {timedOut ? (
        <Notice tone="warning" icon={<TriangleAlert className="size-3.5" />}>
          观察时间已达上限（3 分钟）而任务仍在执行。它可能还在服务端继续跑，
          也可能已中断 —— 关闭后重新打开即可看到最新状态，也可以在结果里重试。
        </Notice>
      ) : null}

      {steps.length > 0 ? (
        <ol className="flex flex-col">
          {steps.map((step, index) => (
            <WorkflowStepItem
              key={step.taskId}
              step={step}
              isLast={index === steps.length - 1}
            />
          ))}
        </ol>
      ) : (
        <p className="text-[12px] leading-5 text-muted-foreground">
          正在等待第一步的执行记录回传…
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 第 6 步：经营结果                                                   */
/* ------------------------------------------------------------------ */

function ResultStep({
  status,
  goal,
  steps,
  durationText,
  errorMessage,
  canRetry,
}: {
  status: WorkflowStatus;
  goal: string;
  steps: readonly LiveStepView[];
  durationText: string | null;
  errorMessage: string | null;
  canRetry: boolean;
}) {
  const progress = toLiveProgress(steps);
  const meta = WORKFLOW_STATUS_META[status];
  /**
   * 结果计数走与驾驶舱同一个归纳函数（`summarizeWorkflowOutcome`），
   * 只是这次没有落库摘要可依，因而由它按逐步报告计数。
   * 复用同一个函数而不是在组件里再写一遍 filter —— 两处口径一旦分叉，
   * 对话框说「新增 2 条」而驾驶舱说「新增 1 条」，商家只会两个都不信。
   */
  const outcome = summarizeWorkflowOutcome({
    summary: null,
    steps: steps.map((step) => ({ agent: step.agent, outcome: step.outcome })),
  });
  const succeeded = outcome.executed + outcome.reused;

  return (
    <div className="flex flex-col gap-3.5">
      <WorkflowResultSummary
        goal={goal}
        status={status}
        progress={progress}
        outcome={outcome}
        durationText={durationText}
        errorMessage={errorMessage}
      />

      {status === "partially_completed" ? (
        <Notice tone="warning" icon={<CircleAlert className="size-3.5" />}>
          这一轮属于「部分完成」：{succeeded} / {progress.total} 步成功，其余没有做成。
          已经产出的内容可以正常使用；也可以只重试没成的那几步 ——
          已成功的步骤不会重复执行。
        </Notice>
      ) : null}

      {status === "failed" && canRetry ? (
        <Notice tone="danger" icon={<TriangleAlert className="size-3.5" />}>
          这一轮没有产出可用的结果。可以点下面的「重试未完成任务」再跑一次；
          如果连续失败，多半是模型通道或商品资料的问题，而不是偶发。
        </Notice>
      ) : null}

      <WorkflowResultCards steps={steps} />

      <details className="rounded-lg border border-border bg-card px-3 py-2">
        <summary className="cursor-pointer text-[12px] leading-5 font-medium outline-none">
          查看逐步执行明细（{meta.label} · {progress.done} / {progress.total} 步）
        </summary>
        <ol className="mt-2 flex flex-col">
          {steps.map((step, index) => (
            <WorkflowStepItem
              key={step.taskId}
              step={step}
              isLast={index === steps.length - 1}
            />
          ))}
        </ol>
      </details>
    </div>
  );
}
