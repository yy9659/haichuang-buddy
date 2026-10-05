"use client";

import { Clapperboard, Hash, Images, Mic } from "lucide-react";
import * as React from "react";

import { EmptyState } from "@/components/common/empty-state";
import { ContentEditor } from "@/components/content/content-editor";
import { ProductPosterPanel } from "@/components/content/product-poster-panel";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CONTENT_FORMAT_LABEL,
  CONTENT_PLATFORM_LABEL,
  CONTENT_STATUS_META,
} from "@/lib/status-meta";
import { cn } from "@/lib/utils";
import type { ContentDraftCopy, ContentItem, ContentSlot, ContentStatus, ProductPosterSource } from "@/types";
import type { ContentSourceProduct } from "@/services/content-agent.service";

type StatusFilter = ContentStatus | "all";

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "published", label: "已发布" },
  { id: "approved", label: "已确认" },
  { id: "reviewing", label: "待确认" },
  { id: "draft", label: "草稿" },
];

const CONTENT_GUIDE_LABELS = {
  "short-video": {
    title: "拍摄执行稿",
    description: "先看拍摄建议，再按分镜拍摄，旁白可直接用于配音。",
    icon: Clapperboard,
    visual: "拍摄建议",
    scenes: "分镜脚本",
    voiceover: "视频旁白",
  },
  article: {
    title: "图文制作建议",
    description: "发布文案在左侧，这里帮助你准备配图和安排图文顺序。",
    icon: Images,
    visual: "配图建议",
    scenes: "配图安排",
    voiceover: "一句话重点",
  },
  "poster-copy": {
    title: "海报创意参考",
    description: "这些建议供海报设计参考，最终效果以海报预览为准。",
    icon: Images,
    visual: "画面建议",
    scenes: "海报排版",
    voiceover: "一句话重点",
  },
  voiceover: {
    title: "口播拍摄稿",
    description: "按口播稿练习表达，结合画面搭配完成拍摄。",
    icon: Mic,
    visual: "拍摄建议",
    scenes: "画面搭配",
    voiceover: "口播稿",
  },
} satisfies Record<ContentItem["format"], {
  title: string;
  description: string;
  icon: typeof Clapperboard;
  visual: string;
  scenes: string;
  voiceover: string;
}>;

/** 内容列表 + 结构化输出详情（主从布局） */
export function ContentWorkspace({ contents, sourceProducts = [], isDemoData = false, selectedSlot }: {
  contents: ContentItem[];
  sourceProducts?: ContentSourceProduct[];
  isDemoData?: boolean;
  selectedSlot?: ContentSlot | null;
}) {
  const [filter, setFilter] = React.useState<StatusFilter>("all");
  const [activeId, setActiveId] = React.useState(
    contents.find((item) => item.productId === selectedSlot?.productId && item.platform === selectedSlot.platform && item.format === selectedSlot.format)?.id ?? contents[0]?.id ?? "",
  );

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
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,270px)_minmax(0,1fr)]">
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
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </div>

      <ContentDetail
        content={active}
        product={sourceProducts.find((product) => product.id === active?.productId)?.posterProduct}
        isDemoData={isDemoData}
      />
    </div>
  );
}

function ContentDetail({ content, product, isDemoData }: {
  content: ContentItem | null;
  product?: ProductPosterSource;
  isDemoData: boolean;
}) {
  if (!content) {
    return (
      <EmptyState
        title="请选择一条内容"
        description="左侧选择一条素材，即可查看、修改并确认。"
        className="h-full"
      />
    );
  }

  return <ContentDetailBody key={`${content.id}:${content.updatedAt ?? content.createdAt}:${content.status}`} content={content} product={product} isDemoData={isDemoData} />;
}

function ContentDetailBody({ content, product, isDemoData }: {
  content: ContentItem;
  product?: ProductPosterSource;
  isDemoData: boolean;
}) {
  const [draft, setDraft] = React.useState<ContentDraftCopy>({
    title: content.title, hook: content.hook, body: content.body, cta: content.cta,
  });
  const statusMeta = CONTENT_STATUS_META[content.status];

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-[15px] leading-6 font-semibold">
            {content.title}
          </h3>
          <span className="text-[11px] text-muted-foreground">
            关联商品：{content.productName} · 更新于 {content.updatedAt ?? content.createdAt}
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

      <div className={cn("grid grid-cols-1 items-start gap-5 lg:grid-cols-2", content.format === "poster-copy" && "xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]")}>
        <div className="flex min-w-0 flex-col gap-3">
          <ContentEditor content={content} onDraftChange={setDraft} />
          <Field label="话题标签">
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

        <div className="flex min-w-0 flex-col gap-3">
          {content.format === "poster-copy" ? (
            <>
              <ProductPosterPanel
                product={product}
                copy={draft}
                contentId={content.id}
                slot={{ productId: content.productId, platform: content.platform, format: content.format }}
                creativeHints={[...content.visualSuggestions, ...content.shotList]}
                isDemo={isDemoData || (content.riskNotes?.some((note) => note.includes("【Mock】")) ?? false)}
              />
              <details className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <summary className="cursor-pointer text-xs font-medium text-slate-300">原始创意建议 · 可选查看</summary>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">AI 海报设计会结合这些建议和你的要求调整画面，成品以海报预览为准。这里也可作为拍摄或补充素材时的参考。</p>
                <ContentGuide content={content} />
              </details>
            </>
          ) : <ContentGuide content={content} framed />}
        </div>
      </div>
    </div>
  );
}

function ContentGuide({ content, framed = false }: { content: ContentItem; framed?: boolean }) {
  const guideLabels = CONTENT_GUIDE_LABELS[content.format];
  const Icon = guideLabels.icon;
  return (
    <section aria-label={guideLabels.title} className={cn("flex min-w-0 flex-col gap-4", framed ? "rounded-2xl border border-cyan-400/20 bg-slate-950/15 p-4" : "mt-3")}>
      {framed ? (
        <div className="border-b border-white/10 pb-3">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-cyan-100"><Icon className="size-4 text-cyan-300" />{guideLabels.title}</h4>
          <p className="mt-1 text-xs leading-5 text-slate-400">{guideLabels.description}</p>
        </div>
      ) : null}
      <Field label={guideLabels.visual}>
        <ul className="flex flex-col gap-1.5">
          {content.visualSuggestions.map((item) => (
            <li key={item} className="flex gap-1.5">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-border" />
              {item}
            </li>
          ))}
        </ul>
      </Field>
      <Field label={content.format === "poster-copy" ? "其他排版思路" : guideLabels.scenes}>
        <ul className="flex flex-col gap-1.5">
          {content.shotList.map((shot) => (
            <li key={shot} className="rounded-xl border border-white/5 bg-muted/40 px-3 py-2 text-[12px] leading-6">
              {shot}
            </li>
          ))}
        </ul>
      </Field>
      <Field label={guideLabels.voiceover}>
        <p className="whitespace-pre-wrap rounded-xl border border-white/5 bg-muted/40 px-3 py-3 text-[12px] leading-6">
          {content.voiceover}
        </p>
      </Field>
    </section>
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
