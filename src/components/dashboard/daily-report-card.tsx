import { ChartLine, Lightbulb, Sparkles, TriangleAlert } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
import { ANALYTICS_HEALTH_META } from "@/analytics/display";
import type { BusinessReport } from "@/types";

/**
 * AI 经营日报卡片（驾驶舱紧凑版）
 *
 * 数据来源是**真实落库的 `BusinessReport`**（S6-B 起）：
 * 以前这里渲染的是 `MOCK_DAILY_REPORT` 常量 —— 一份「看起来是 AI 生成的」
 * 固定文本。经营日报已改为真的跑一次 Analytics Agent，
 * 因此**从未生成过时它就是 null**，由页面显示「尚未生成」。
 *
 * 这里只做「摘要 + 三列结论标题」：完整的问题依据与可能原因放在
 * `/analytics`（那才是复盘现场），驾驶舱只负责让商家知道「今天要不要看」。
 */

export function DailyReportCard({ report }: { report: BusinessReport }) {
  const { report: content } = report;
  const health = ANALYTICS_HEALTH_META[content.health];

  const blocks = [
    {
      id: "highlights",
      title: "今日亮点",
      icon: ChartLine,
      tone: "text-primary",
      items: content.highlights.map((item) => item.title),
    },
    {
      id: "issues",
      title: "待处理问题",
      icon: TriangleAlert,
      tone: "text-warning",
      items: content.issues.map((item) => item.title),
    },
    {
      id: "actions",
      title: "优先行动",
      icon: Sparkles,
      tone: "text-emerald-400",
      items: content.actions.map(
        (action) => `${action.priority}. ${action.title}`,
      ),
    },
  ] as const;

  return (
    <SectionCard
      title="AI 工作复盘"
      description={`基于系统内工作记录；可能原因需要人工核实 · 更新于 ${report.createdAt}`}
      icon={<Lightbulb className="size-4 text-warning" />}
      moreHref="/analytics"
      action={<Badge variant={health.tone}>{health.label}</Badge>}
    >
      <div className="flex flex-col gap-3">
        <p className="line-clamp-3 text-[12px] leading-5 text-muted-foreground">
          {content.executiveSummary}
        </p>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {blocks.map((block) => {
            const Icon = block.icon;
            return (
              <div key={block.id} className="flex flex-col gap-2">
                <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                  <Icon className={`size-3.5 ${block.tone}`} />
                  {block.title}
                </span>
                {block.items.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {block.items.slice(0, 3).map((item) => (
                      <li
                        key={item}
                        className="flex gap-1.5 text-[12px] leading-5 text-muted-foreground"
                      >
                        <span className="mt-2 size-1 shrink-0 rounded-full bg-border" />
                        <span className="line-clamp-2">{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-muted-foreground">本次复盘未发现相关项。</p>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-[11px] text-muted-foreground">
          含「可能原因」的完整复盘见
          <span className="mx-1 font-medium text-foreground">经营分析</span>
          页；可能原因只是 AI 推测，需进一步核实。
        </p>
      </div>
    </SectionCard>
  );
}
