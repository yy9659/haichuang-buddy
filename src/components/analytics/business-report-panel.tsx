import {
  ArrowRight,
  Clock,
  History,
  Lightbulb,
  ListChecks,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
import {
  ANALYTICS_HEALTH_META,
  ANALYTICS_ISSUE_SEVERITY_META,
} from "@/analytics/display";
import { GenerateBusinessReportButton } from "@/components/analytics/generate-report-button";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { sanitizeUserFacingText } from "@/lib/user-facing-text";
import { savedReportFailureMessage } from "@/lib/sales-review-error";
import type { BusinessReport } from "@/types";
import type { AnalyticsReportState } from "@/services/analytics.service";

/**
 * 区块 C + D：AI 经营日报 / 问题与行动（**真实 Analytics Agent 产出**）
 *
 * 三条呈现纪律（任务书第十五 / 十六 / 三十一节）：
 *
 * 1. **数字来自快照，文字来自模型。** 日报里的每个数字都必须能在指标明细里
 *    找到同名项；模型的自由度在「解释与建议」，不在「报数」。
 * 2. **可能原因不能写成结论。** `possibleCauses` 一律挂在「AI 分析 · 可能原因」
 *    标签下，与「判定依据（程序口径）」视觉上分开 —— 因果需要额外证据，
 *    快照只提供相关性。
 * 3. **失败不隐藏。** 有新失败时，旧日报照常展示，但顶部要如实说明
 *    「下面是上一次成功的结果」。
 */

export function BusinessReportSection({
  latestReport,
  state,
}: {
  latestReport: BusinessReport | null;
  state: AnalyticsReportState;
}) {
  if (!latestReport) {
    return <EmptyReportCard state={state} />;
  }

  const { report } = latestReport;
  const health = ANALYTICS_HEALTH_META[report.health];
  const firstAction = report.actions[0];
  const actionHref = firstAction ? ({ product: "/products", brand: "/brand", content: "/content", live: "/live", customer_service: "/customer-service", knowledge: "/customer-service", workflow: "/dashboard" }[firstAction.actionType]) : "/dashboard";

  return (
    <SectionCard
      title="AI 帮你回顾准备工作"
      description={`${report.salesReview ? "销售建议已整理在上方，这里回顾商品、推广和答疑准备" : "根据海创Buddy里的工作记录整理"} · 更新于 ${latestReport.createdAt}`}
      icon={<Lightbulb className="size-4 text-warning" />}
      action={
        <div className="flex items-center gap-2">
          <Badge variant={health.tone}>{health.label}</Badge>
          <GenerateBusinessReportButton status={state.status} size="sm" variant="soft" />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {state.lastRunFailed ? (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <p className="text-[12px] leading-5 text-muted-foreground">
              最近一次整理
              <span className="mx-0.5 font-medium text-foreground">失败</span>
              了
              {state.latestTask?.errorMessage
                ? `（${savedReportFailureMessage(state.latestTask.errorMessage)}）`
                : ""}
              。下面是
              <span className="mx-0.5 font-medium text-foreground">上一次成功</span>
              的结果，尚未被覆盖。
            </p>
          </div>
        ) : null}

        {(report.salesReview?.isMock ?? state.provider.isMock) ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              当前为演示模式，这份回顾用于展示分析流程。
          </p>
        ) : null}

        {/* 经营摘要 */}
        <div className="rounded-lg border border-border bg-card p-3">
          <span className="text-sm font-semibold">这段时间做了什么</span>
          <p className="mt-1.5 text-[13px] leading-6 text-muted-foreground">
            {sanitizeUserFacingText(report.executiveSummary)}
          </p>
        </div>

        {firstAction ? <div className="rounded-xl border border-primary/20 bg-primary-soft p-4"><div className="flex items-center gap-2 text-xs font-medium text-cyan-200"><ListChecks className="size-4" />准备工作先做这件事</div><h3 className="mt-2 text-sm font-semibold text-slate-100">{sanitizeUserFacingText(firstAction.title)}</h3><p className="mt-1 text-xs leading-6 text-slate-300">{sanitizeUserFacingText(firstAction.recommendedAction)}</p><Link href={actionHref} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-cyan-200 hover:text-white">去处理<ArrowRight className="size-3.5" /></Link></div> : null}

        <details className="rounded-xl border border-border bg-muted/40 p-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-300">看看做得好的地方和待留意的事</summary>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">

        {/* 亮点 */}
        {report.highlights.length > 0 ? (
          <Block
            icon={<Sparkles className="size-3.5 text-violet-400" />}
            title="做得好的地方"
          >
            <ul className="flex flex-col gap-2">
              {report.highlights.map((item) => (
                <li
                  key={item.title}
                  className="rounded-lg border border-border bg-card p-2.5"
                >
                  <span className="text-sm font-medium">{sanitizeUserFacingText(item.title)}</span>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {sanitizeUserFacingText(item.evidence)}
                  </p>
                </li>
              ))}
            </ul>
          </Block>
        ) : null}

        {/* 问题与可能原因（区块 D 的核心） */}
        {report.issues.length > 0 ? (
          <Block
            icon={<TriangleAlert className="size-3.5 text-warning" />}
            title="需要留意的事"
            hint="这些提醒来自站内记录，请结合实际情况判断"
          >
            <ul className="flex flex-col gap-2">
              {report.issues.map((issue) => {
                const severity = ANALYTICS_ISSUE_SEVERITY_META[issue.severity];
                return (
                  <li
                    key={issue.title}
                    className="rounded-lg border border-border bg-card p-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={severity.tone}>{issue.severity === "high" ? "建议先处理" : issue.severity === "medium" ? "可以关注" : "供你参考"}</Badge>
                      <span className="text-sm font-medium">{sanitizeUserFacingText(issue.title)}</span>
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                      {sanitizeUserFacingText(issue.evidence)}
                    </p>
                    {issue.possibleCauses.length > 0 ? (
                      <div className="mt-2 rounded-md border border-dashed border-border bg-muted/40 p-2">
                        <span className="text-xs font-semibold text-muted-foreground">
                          可能是什么原因？AI 推测，请你核实
                        </span>
                        <ul className="mt-1 flex flex-col gap-1">
                          {issue.possibleCauses.map((cause) => (
                            <li
                              key={cause}
                              className="flex gap-1.5 text-xs leading-5 text-muted-foreground"
                            >
                              <span className="mt-2 size-1 shrink-0 rounded-full bg-border" />
                              {sanitizeUserFacingText(cause)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Block>
        ) : null}

          </div>
        </details>

        {/* 优先行动 */}
        {report.actions.length > 1 ? (
          <Block
            icon={<ListChecks className="size-3.5 text-cyan-300" />}
            title="时间允许的话，还可以做"
          >
            <ol className="flex flex-col gap-2">
              {report.actions.slice(1).map((action) => (
                <li
                  key={action.title}
                  className="flex gap-2.5 rounded-lg border border-border bg-card p-2.5"
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                      action.priority === 1
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {action.priority}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{sanitizeUserFacingText(action.title)}</span>
                    </div>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      {sanitizeUserFacingText(action.reason)}
                    </p>
                    <p className="mt-1 flex items-start gap-1 text-xs leading-5 text-foreground">
                      <ArrowRight className="mt-1 size-3 shrink-0 text-muted-foreground" />
                      {sanitizeUserFacingText(action.recommendedAction)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Block>
        ) : null}

        {/* 明日重点 */}
        {report.tomorrowFocus.length > 0 ? (
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <span className="text-sm font-semibold">下次先做什么</span>
            <ul className="mt-1.5 flex flex-col gap-1">
              {report.tomorrowFocus.map((item) => (
                <li
                  key={item}
                  className="flex gap-1.5 text-[12px] leading-5 text-muted-foreground"
                >
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-border" />
                  {sanitizeUserFacingText(item)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

function Block({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
          {icon}
          {title}
        </span>
        {hint ? (
          <span className="text-[11px] text-muted-foreground">{hint}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** 没有日报时的四种状态（empty / generating / failed，以及 lastRunFailed 之外的情况） */
function EmptyReportCard({ state }: { state: AnalyticsReportState }) {
  const message =
    state.status === "generating"
      ? "正在整理系统工作记录，请稍候刷新。"
      : state.status === "failed"
        ? `上一次整理失败${
            state.latestTask?.errorMessage ? `：${savedReportFailureMessage(state.latestTask.errorMessage)}` : ""
          }。可以重新生成。`
        : "还没有工作回顾。点击「生成工作回顾」，看看已经做了什么、接下来可以做什么。";

  return (
    <SectionCard
      title="AI 帮你整理的工作回顾"
      description="只根据海创Buddy里的工作记录整理，不代表店铺销售业绩。"
      icon={<Lightbulb className="size-4 text-warning" />}
      action={<GenerateBusinessReportButton status={state.status} size="sm" />}
    >
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-10 text-center">
        <Clock className="size-5 text-muted-foreground" />
        <p className="max-w-md text-[12px] leading-5 text-muted-foreground">
          {message}
        </p>
        {state.provider.isMock ? (
          <p className="text-[11px] leading-5 text-muted-foreground">
            当前为演示模式，这份回顾用于展示分析流程。
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}

/**
 * 历史日报（任务书第十八节：最新 + 最近几条）。
 *
 * **不提供「点进去看详情」**：本地 Demo 只做「最新一份是主角、历史供对照」，
 * 多一层详情路由只会增加与「最新」不一致的表面积。
 */
export function BusinessReportHistory({
  reports,
  latestId,
}: {
  reports: readonly BusinessReport[];
  latestId: string | null;
}) {
  // 只展示最新之外的那几条（最新一份已在上面完整展示）
  const history = reports.filter((report) => report.id !== latestId).slice(0, 5);

  return (
    <SectionCard
      title="以往的经营回顾"
      description="保留当时的销售依据与工作建议，方便对照。"
      icon={<History className="size-4 text-primary" />}
      moreHref="/analytics"
      action={<Badge variant="soft">最近 {history.length} 条</Badge>}
    >
      {history.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {history.map((item) => {
            const health = ANALYTICS_HEALTH_META[item.report.health];
            return (
              <li
                key={item.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-2.5"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-[11px] text-muted-foreground">
                    {item.createdAt}
                  </span>
                  <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
                    {sanitizeUserFacingText(item.report.salesReview?.summary ?? item.report.executiveSummary)}
                  </p>
                  {item.report.salesReview ? <details className="mt-2 text-xs"><summary className="cursor-pointer text-cyan-200">查看当时的销售建议{item.snapshot.sales?.mode === "demo" ? "（演示记录）" : ""}</summary><ul className="mt-2 space-y-2">{item.report.salesReview.actions.map(action => <li key={action.priority}><strong className="text-slate-200">{action.priority}. {action.title}</strong><p className="mt-1 leading-5 text-slate-400">{action.steps}</p></li>)}</ul><p className="mt-2 text-[11px] leading-5 text-slate-400">{item.snapshot.sales?.facts.find(fact => fact.id === "revenue")?.display} · {item.report.salesReview.isMock ? "演示模型建议" : "AI 建议"}，仅对应当时保存的记录。</p></details> : null}
                </div>
                <Badge variant={health.tone}>{health.label}</Badge>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-4 text-center text-[12px] text-muted-foreground">
          还没有更早的工作回顾。
        </p>
      )}
    </SectionCard>
  );
}
