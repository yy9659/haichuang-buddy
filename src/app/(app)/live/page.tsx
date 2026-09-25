import type { Metadata } from "next";
import { Radio, Sparkles } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { HostTeleprompter } from "@/components/live/host-teleprompter";
import { LiveDirectorPanel } from "@/components/live/live-director-panel";
import { LiveStatsPanel } from "@/components/live/live-stats-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MOCK_LIVE_COMMENTS,
  MOCK_LIVE_SESSION,
  MOCK_LIVE_STATS,
  MOCK_LIVE_SUGGESTIONS,
  MOCK_TELEPROMPTER,
} from "@/lib/mock";

export const metadata: Metadata = {
  title: "AI直播间 · 海创Buddy",
};

/** AI 直播间：左（直播数据 + 评论）/ 中（主播提词器）/ 右（AI 直播导演） */
export default function LivePage() {
  return (
    <>
      <PageHeader
        title="AI 直播间"
        description="AI 直播导演实时分析评论、检测热点问题，并为主播生成即时建议与异议处理话术。"
        badge={
          <Badge variant="danger" className="gap-1.5">
            <span className="size-1.5 animate-pulse-soft rounded-full bg-current" />
            直播中 {MOCK_LIVE_SESSION.durationText}
          </Badge>
        }
        actions={
          <>
            <Button variant="outline">
              <Radio />
              切换商品
            </Button>
            <Button>
              <Sparkles />
              更新直播策略
            </Button>
          </>
        }
      />

      <section className="grid gap-3 xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)_minmax(0,340px)]">
        <LiveStatsPanel
          stats={MOCK_LIVE_STATS}
          comments={MOCK_LIVE_COMMENTS}
        />
        <HostTeleprompter
          session={MOCK_LIVE_SESSION}
          segments={MOCK_TELEPROMPTER}
        />
        <LiveDirectorPanel suggestions={MOCK_LIVE_SUGGESTIONS} />
      </section>
    </>
  );
}
