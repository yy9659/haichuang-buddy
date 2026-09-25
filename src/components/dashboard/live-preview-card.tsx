import { Heart, MessageSquare, Radio, Users } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/utils";
import type { LiveComment, LiveSession, LiveStats } from "@/types";

interface LivePreviewCardProps {
  session: LiveSession;
  stats: LiveStats;
  comments: LiveComment[];
}

/** 驾驶舱 · 直播助手速览 */
export function LivePreviewCard({
  session,
  stats,
  comments,
}: LivePreviewCardProps) {
  return (
    <SectionCard
      title="直播助手"
      icon={<Radio className="size-4 text-rose-500" />}
      description={session.title}
      moreHref="/live"
      action={
        <Badge variant="danger" className="gap-1.5">
          <span className="size-1.5 animate-pulse-soft rounded-full bg-current" />
          直播中 {session.durationText}
        </Badge>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { id: "online", label: "在线人数", value: stats.onlineCount, icon: Users },
          { id: "likes", label: "点赞", value: stats.likes, icon: Heart },
          {
            id: "comments",
            label: "评论",
            value: stats.comments,
            icon: MessageSquare,
          },
          {
            id: "questions",
            label: "提问",
            value: stats.questions,
            icon: Radio,
          },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.id}
              className="flex flex-col gap-0.5 rounded-lg bg-muted/60 px-2.5 py-2"
            >
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Icon className="size-3" />
                {item.label}
              </span>
              <span className="text-[15px] leading-6 font-semibold tabular-nums">
                {formatNumber(item.value)}
              </span>
            </div>
          );
        })}
      </div>

      <ul className="mt-3 flex flex-col gap-2 border-t border-border/70 pt-3">
        {comments.slice(0, 4).map((comment) => (
          <li key={comment.id} className="flex items-start gap-2 text-[12px]">
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-100 to-blue-200 text-[10px] font-medium text-blue-700">
              {comment.user.slice(0, 1)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[11px] text-muted-foreground">
                {comment.user}
              </span>
              <span className="truncate leading-5">{comment.content}</span>
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
              {comment.createdAtText}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
