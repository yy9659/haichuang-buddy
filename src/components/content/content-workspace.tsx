"use client";

import { Eye, Hash, MessageSquare, Share2, ThumbsUp } from "lucide-react";
import * as React from "react";

import { EmptyState } from "@/components/common/empty-state";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CONTENT_FORMAT_LABEL,
  CONTENT_PLATFORM_LABEL,
  CONTENT_STATUS_META,
} from "@/lib/status-meta";
import { cn, formatCompact } from "@/lib/utils";
import type { ContentItem, ContentStatus } from "@/types";

type StatusFilter = ContentStatus | "all";

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "published", label: "已发布" },
  { id: "approved", label: "已确认" },
  { id: "reviewing", label: "待确认" },
  { id: "draft", label: "草稿" },
  { id: "failed", label: "生成失败" },
];

/** 内容列表 + 结构化输出详情（主从布局） */
export function ContentWorkspace({ contents }: { contents: ContentItem[] }) {
  const [filter, setFilter] = React.useState<StatusFilter>("all");
  const [activeId, setActiveId] = React.useState(contents[0]?.id ?? "");

  const filtered = React.useMemo(
    () =>
      filter === "all"
        ? contents
        : contents.filter((item) => item.status === filter),
    [contents, filter],
  );

  const active =
    filtered.find((item) => item.id === activeId) ?? filtered[0] ?? null;

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,380px)_1fr]">
      <div className="flex flex-col gap-3">
        <Tabs value={filter} onValueChange={(value) => setFilter(value as StatusFilter)}>
          <TabsList className="flex-wrap">
            {FILTERS.map((item) => (
              <TabsTrigger key={item.id} value={item.id} className="flex-none px-2.5">
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {filtered.length === 0 ? (
          <EmptyState
            title="暂无该状态的内容"
            description="切换筛选条件查看其他内容。"
          />
        ) : (
          <ScrollArea className="xl:h-[calc(100vh-320px)]" viewportClassName="pr-1">
            <ul className="flex flex-col gap-2">
              {filtered.map((item) => {
                const statusMeta = CONTENT_STATUS_META[item.status];
                const isActive = active?.id === item.id;

                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(item.id)}
                      className={cn(
                        "w-full rounded-xl border bg-card px-3 py-2.5 text-left shadow-card transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                        isActive
                          ? "border-primary/40 ring-1 ring-primary/20"
                          : "border-border hover:border-primary/25",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="line-clamp-2 text-[13px] leading-5 font-medium">
                          {item.title}
                        </span>
                        <Badge variant={statusMeta.tone} className="shrink-0">
                          {statusMeta.label}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                        {item.hook}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Badge variant="soft">
                          {CONTENT_PLATFORM_LABEL[item.platform]}
                        </Badge>
                        <Badge variant="secondary">
                          {CONTENT_FORMAT_LABEL[item.format]}
                        </Badge>
                        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
                          <Eye className="size-3" />
                          {formatCompact(item.metrics.views)}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </div>

      <ContentDetail content={active} />
    </div>
  );
}

function ContentDetail({ content }: { content: ContentItem | null }) {
  if (!content) {
    return (
      <EmptyState
        title="请选择一条内容"
        description="左侧列表中选择内容，即可查看结构化输出与表现数据。"
        className="h-full"
      />
    );
  }

  const statusMeta = CONTENT_STATUS_META[content.status];

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[15px] leading-6 font-semibold">
            {content.title}
          </h3>
          <span className="text-[11px] text-muted-foreground">
            关联商品：{content.productName} · 生成于 {content.createdAt}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="soft">{CONTENT_PLATFORM_LABEL[content.platform]}</Badge>
          <Badge variant="secondary">
            {CONTENT_FORMAT_LABEL[content.format]}
          </Badge>
          <Badge variant={statusMeta.tone}>{statusMeta.label}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border-y border-border/70 py-3 sm:grid-cols-4">
        {[
          { id: "views", label: "播放量", value: formatCompact(content.metrics.views), icon: Eye },
          { id: "likes", label: "点赞", value: formatCompact(content.metrics.likes), icon: ThumbsUp },
          { id: "comments", label: "评论", value: formatCompact(content.metrics.comments), icon: MessageSquare },
          { id: "shares", label: "转发", value: formatCompact(content.metrics.shares), icon: Share2 },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.id} className="flex flex-col gap-0.5">
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Icon className="size-3" />
                {item.label}
              </span>
              <span className="text-[15px] leading-6 font-semibold tabular-nums">
                {item.value}
              </span>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Field label="Hook（前 3 秒）">{content.hook}</Field>
          <Field label="正文">
            <span className="whitespace-pre-line">{content.body}</span>
          </Field>
          <Field label="CTA">{content.cta}</Field>
          <Field label="Hashtag">
            <span className="flex flex-wrap gap-1.5">
              {content.hashtags.map((tag) => (
                <Badge key={tag} variant="soft">
                  <Hash className="size-3" />
                  {tag.replace(/^#/, "")}
                </Badge>
              ))}
            </span>
          </Field>
        </div>

        <div className="flex flex-col gap-3">
          <Field label="镜头建议">
            <ul className="flex flex-col gap-1.5">
              {content.visualSuggestions.map((item) => (
                <li key={item} className="flex gap-1.5">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-border" />
                  {item}
                </li>
              ))}
            </ul>
          </Field>
          <Field label="分镜脚本（shotList）">
            <ul className="flex flex-col gap-1.5">
              {content.shotList.map((shot) => (
                <li
                  key={shot}
                  className="rounded-md bg-muted/60 px-2 py-1 text-[12px] leading-5"
                >
                  {shot}
                </li>
              ))}
            </ul>
          </Field>
          <Field label="视频旁白">
            <p className="rounded-md bg-muted/60 px-2.5 py-2 text-[12px] leading-5">
              {content.voiceover}
            </p>
          </Field>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold text-muted-foreground">
        {label}
      </span>
      <div className="text-[12px] leading-6">{children}</div>
    </div>
  );
}
