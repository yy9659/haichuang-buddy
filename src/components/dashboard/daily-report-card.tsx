import { ChartLine, Lightbulb, Sparkles, TrendingUp } from "lucide-react";

import { ScoreRing } from "@/components/common/score-ring";
import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
import type { DailyReport } from "@/types";

const BLOCKS = [
  {
    id: "highlights",
    title: "今日表现",
    icon: ChartLine,
    tone: "text-primary",
  },
  {
    id: "insights",
    title: "核心发现",
    icon: Sparkles,
    tone: "text-violet-600",
  },
  {
    id: "tomorrowActions",
    title: "下一步建议",
    icon: TrendingUp,
    tone: "text-emerald-600",
  },
] as const;

/** AI 经营日报卡片 */
export function DailyReportCard({ report }: { report: DailyReport }) {
  const blocks = BLOCKS.map((block) => ({
    ...block,
    items: report[block.id],
  }));

  return (
    <SectionCard
      title="AI 经营日报"
      description={`基于程序计算的经营指标，由经营分析师 Agent 解释归因 · 更新于 ${report.date}`}
      icon={<Lightbulb className="size-4 text-warning" />}
      moreHref="/analytics"
      action={<Badge variant="soft">评分 {report.score}</Badge>}
    >
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="flex shrink-0 flex-col items-center gap-2 border-border/70 lg:w-40 lg:border-r lg:pr-4">
          <ScoreRing value={report.score} caption={report.scoreLabel} />
          <p className="max-w-40 text-center text-[11px] leading-4 text-muted-foreground">
            综合转化、内容与客服三类指标加权
          </p>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-3">
          {blocks.map((block) => {
            const Icon = block.icon;
            return (
              <div key={block.id} className="flex flex-col gap-2">
                <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                  <Icon className={`size-3.5 ${block.tone}`} />
                  {block.title}
                </span>
                <ul className="flex flex-col gap-1.5">
                  {block.items.slice(0, 3).map((item) => (
                    <li
                      key={item}
                      className="flex gap-1.5 text-[12px] leading-5 text-muted-foreground"
                    >
                      <span className="mt-2 size-1 shrink-0 rounded-full bg-border" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </SectionCard>
  );
}
