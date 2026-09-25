import { CircleCheck, Mic, PlayCircle, Timer } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LiveSession, TeleprompterSegment } from "@/types";

const SEGMENT_TYPE_LABEL: Record<TeleprompterSegment["type"], string> = {
  opening: "开场",
  "selling-point": "卖点",
  objection: "异议处理",
  cta: "收单",
};

interface HostTeleprompterProps {
  session: LiveSession;
  segments: TeleprompterSegment[];
}

/** 中栏：直播画面占位 + 主播提词器 */
export function HostTeleprompter({ session, segments }: HostTeleprompterProps) {
  const current = segments.find((segment) => segment.status === "current");
  const upcoming = segments.filter((segment) => segment.status === "upcoming");

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 直播画面占位（本轮无真实推流） */}
      <div className="relative aspect-16/9 w-full overflow-hidden rounded-xl border border-border bg-gradient-to-br from-slate-800 via-slate-700 to-slate-900 shadow-card">
        <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(80%_60%_at_20%_10%,white,transparent_60%)]" />
        <div className="absolute top-3 left-3 flex items-center gap-2">
          <Badge variant="danger" className="gap-1.5">
            <span className="size-1.5 animate-pulse-soft rounded-full bg-current" />
            直播中
          </Badge>
          <span className="rounded-md bg-black/30 px-2 py-0.5 text-[11px] text-white tabular-nums backdrop-blur-sm">
            {session.durationText}
          </span>
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-black/60 to-transparent p-4">
          <div className="flex flex-col gap-0.5 text-white">
            <span className="text-[11px] text-white/70">当前讲解商品</span>
            <span className="text-[15px] font-semibold">
              {session.productName}
            </span>
          </div>
          <span className="rounded-md bg-white/15 px-2 py-1 text-[11px] text-white backdrop-blur-sm">
            直播画面占位 · 本轮不接推流
          </span>
        </div>
      </div>

      {/* 当前话术 */}
      <div className="rounded-xl border border-primary/25 bg-primary-soft/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Mic className="size-3.5 text-primary" />
          <span className="text-[12px] font-semibold text-primary">
            当前话术 · {current ? SEGMENT_TYPE_LABEL[current.type] : "待开始"}
          </span>
          {current ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary/80">
              <Timer className="size-3" />
              {current.durationText}
            </span>
          ) : null}
        </div>
        <p className="mt-2 text-[14px] leading-6 font-medium">
          {current?.content ?? "点击「开始直播」，AI 直播导演将推送实时话术。"}
        </p>
      </div>

      {/* 完整提词器 */}
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card shadow-card">
        <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
            <PlayCircle className="size-3.5 text-primary" />
            提词器 · 完整脚本
          </span>
          <Badge variant="secondary">{segments.length} 段</Badge>
        </div>

        <ol className="flex flex-col gap-2 p-3">
          {segments.map((segment) => {
            const isCurrent = segment.status === "current";
            const isDone = segment.status === "done";
            return (
              <li
                key={segment.id}
                className={cn(
                  "rounded-lg border px-3 py-2.5 transition-colors",
                  isCurrent
                    ? "border-primary/40 bg-primary-soft/50"
                    : "border-border bg-muted/40",
                )}
              >
                <div className="flex items-center gap-2">
                  {isDone ? (
                    <CircleCheck className="size-3.5 shrink-0 text-success" />
                  ) : null}
                  <span className="text-[12px] font-semibold">
                    {segment.title}
                  </span>
                  <Badge variant="secondary" className="ml-auto shrink-0">
                    {SEGMENT_TYPE_LABEL[segment.type]}
                  </Badge>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {segment.durationText}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                  {segment.content}
                </p>
              </li>
            );
          })}
        </ol>

        <div className="border-t border-border/70 px-3 py-2.5">
          <span className="text-[11px] text-muted-foreground">
            下一段内容
          </span>
          <p className="mt-0.5 truncate text-[12px] font-medium">
            {upcoming[0]?.title ?? "已到最后一段"}
          </p>
        </div>
      </div>
    </div>
  );
}
