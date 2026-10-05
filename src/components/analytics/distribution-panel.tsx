import { CircleHelp, Radio } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { CUSTOMER_INTENT_LABEL, LIVE_INTENT_META } from "@/lib/status-meta";
import { TONE_CLASSES } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { AnalyticsSnapshot, CustomerIntent, LiveIntent } from "@/types";

/**
 * 结构分布：未解决知识缺口 + 直播评论意图（任务书第二十三 / 二十四节）
 *
 * 这两份分布都由**程序聚合**（`computeKnowledgeGapBreakdown` /
 * `aggregateLiveHotTopics`），界面只做搬运与排序展示。
 *
 * 为什么把它们放在一起：它们回答同一个问题 ——「客户在问什么、我们答不上来什么」。
 * 缺口分布告诉商家「该补哪个知识」，直播意图分布告诉商家「今天大家最关心什么」。
 * 两者并排，商家一眼就能对上「缺口是否落在热点上」。
 */

function customerIntentLabel(intent: string): string {
  return CUSTOMER_INTENT_LABEL[intent as CustomerIntent] ?? intent;
}

function liveIntentLabel(intent: LiveIntent): string {
  return LIVE_INTENT_META[intent]?.label ?? intent;
}

function DistributionRow({
  label,
  count,
  ratio,
  tone = "primary",
}: {
  label: string;
  count: number;
  /** 0 ~ 1；没有分母时为 null */
  ratio: number | null;
  tone?: keyof typeof TONE_CLASSES;
}) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span className="truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {count}
          {ratio === null ? "" : ` · ${Math.round(ratio * 100)}%`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", TONE_CLASSES[tone].solid)}
          style={{
            width: ratio === null ? "0%" : `${Math.max(4, ratio * 100)}%`,
          }}
        />
      </div>
    </li>
  );
}

export function DistributionPanel({
  snapshot,
  liveUnavailableReason = null,
}: {
  snapshot: AnalyticsSnapshot;
  /**
   * 直播区块在当前数据源下不可用时的原因。
   *
   * 非空时右侧卡片改说「这个模块还没启用」—— 因为降级后的 `topIntents` 是空数组，
   * 而空数组在界面上的默认文案是「跑一场直播后这里会出现真实分布」，
   * 那会让商家去找「怎么跑一场直播」，而问题根本不在那里。
   */
  liveUnavailableReason?: string | null;
}) {
  const gaps = snapshot.customerService.openGapByIntent;
  const gapTotal = gaps.reduce((sum, item) => sum + item.count, 0);
  const intents = snapshot.live.topIntents;

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <SectionCard
        title="哪些问题还缺资料"
        description="按站内模拟答疑中暂时答不上来的问题分类，方便你决定先补什么。"
        icon={<CircleHelp className="size-4 text-warning" />}
      >
        {gaps.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {gaps.map((item) => (
              <DistributionRow
                key={item.intent}
                label={customerIntentLabel(item.intent)}
                count={item.count}
                ratio={gapTotal > 0 ? item.count / gapTotal : null}
                tone="warning"
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-4 text-center text-[12px] text-muted-foreground">
            目前没有待补的答疑资料。
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="直播彩排里问了什么"
        description="只统计你在彩排时手动录入并分类的问题。"
        icon={<Radio className="size-4 text-primary" />}
      >
        {liveUnavailableReason !== null ? (
          <p className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-4 text-center text-[12px] leading-5 text-muted-foreground">
            {liveUnavailableReason}，目前看不到彩排问题记录。
          </p>
        ) : intents.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {intents.map((topic) => (
              <DistributionRow
                key={topic.intent}
                label={liveIntentLabel(topic.intent)}
                count={topic.count}
                ratio={topic.share}
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-4 text-center text-[12px] text-muted-foreground">
            还没有分类过的彩排问题。完成一次彩排后可在这里查看。
          </p>
        )}
      </SectionCard>
    </div>
  );
}
