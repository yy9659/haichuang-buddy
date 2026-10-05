import type { Metadata } from "next";
import { CircleCheck, Clock3, FileText, Send, Sparkles } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { StatCard } from "@/components/common/stat-card";
import { ContentGenerateForm } from "@/components/content/content-generate-form";
import { ContentGenerationPanel } from "@/components/content/content-generation-panel";
import { CONTENT_GENERATION_STATUS_META } from "@/components/content/content-status";
import { ContentWorkspace } from "@/components/content/content-workspace";
import { Badge } from "@/components/ui/badge";
import type { RawSearchParams } from "@/lib/search-params";
import { unwrapOrThrow } from "@/lib/result";
import { DATA_SOURCE_LABEL } from "@/lib/status-meta";
import { parseContentSlotQuery } from "@/schemas/content";
import { getContentView } from "@/services";

export const metadata: Metadata = {
  title: "推广素材 · 海创Buddy",
};

interface ContentPageProps {
  /**
   * 当前选中的槽位（商品 / 平台 / 形态）由 URL 承载，因此本页按请求渲染。
   * 这样「某个商品在某平台的内容」变成一条可分享、可收藏的地址，
   * 而且槽位是否有效（商品存不存在、有没有 DNA）始终由服务端说了算。
   */
  searchParams: Promise<RawSearchParams>;
}

/**
 * AI 内容工厂：商品理解 + 品牌策略 → 多平台结构化营销内容。
 *
 * 页面本身不判断任何业务规则，只负责把服务层的四态渲染出来：
 * - `empty`      该槽位还没有内容 → 表单 + 生成按钮
 * - `generating` 服务端有运行中的任务 → 生成中卡片（带自动刷新）
 * - `completed`  已有内容 → 内容资产视图 + 生成记录 + 风险提示
 * - `failed`     最近一次生成失败 → 失败原因 + 重试
 *
 * 过程细节（生成记录 / 风险提示 / 模型通道 / 依据清单）统一交给
 * `ContentGenerationPanel`，本页不重复一遍。
 */
export default async function ContentPage({ searchParams }: ContentPageProps) {
  const view = unwrapOrThrow(
    await getContentView(parseContentSlotQuery(await searchParams)),
  );
  const { contents, sourceProducts, summary, dataSource, slot, slotState, basis } =
    view;

  const statusMeta = CONTENT_GENERATION_STATUS_META[slotState?.generation.status ?? "empty"];
  const provider = slotState?.generation.provider ?? null;

  /**
   * 已有内容的槽位 key 集合，供下拉框标出「（已有内容）」。
   * 在这里算而不是在客户端组件里算：内容是服务端数据，
   * 客户端只该拿到「能不能点」的结论，而不是自己重算一遍槽位规则。
   */
  const filledSlots = contents.map(
    (item) => `${item.productId}|${item.platform}|${item.format}`,
  );

  /** 模型通道不可用时的统一禁用原因（通道是环境问题，优先提示它） */
  const disabledReason =
    provider && !provider.usable
      ? (provider.reason ?? "模型通道不可用")
      : undefined;
  const awaitingReview = contents.filter((item) => item.status === "draft" || item.status === "reviewing").length;
  const approved = contents.filter((item) => item.status === "approved").length;

  return (
    <>
      <PageHeader
        title="推广素材"
        description="从商品资料生成素材，由你修改、确认并手动发布。"
        badge={
          <>
            <Badge variant={statusMeta.tone}>{statusMeta.label}</Badge>
            <Badge variant="soft">{DATA_SOURCE_LABEL[dataSource]}</Badge>
          </>
        }
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="素材总数"
          value={`${summary.total}`}
          unit="条"
          tone="primary"
          icon={<FileText />}
        />
        <StatCard
          label="待确认"
          value={`${awaitingReview}`}
          unit="条"
          tone="warning"
          icon={<Clock3 />}
        />
        <StatCard
          label="已确认"
          value={`${approved}`}
          unit="条"
          tone="success"
          icon={<CircleCheck />}
        />
        <StatCard
          label="手动标记已发布"
          value={`${summary.published}`}
          unit="条"
          tone="info"
          icon={<Send />}
        />
      </section>

      <SectionCard
        title="生成内容"
        description="选择商品、平台与内容形式"
        icon={<Sparkles className="size-4 text-primary" />}
      >
        <ContentGenerateForm
          sourceProducts={sourceProducts}
          slot={slot}
          slotState={slotState}
          basis={basis}
          filledSlots={filledSlots}
          {...(disabledReason ? { disabledReason } : {})}
        />
      </SectionCard>

      {/* 四态面板：empty / generating / completed / failed */}
      <ContentGenerationPanel view={view} />

      <SectionCard
        title="内容资产"
        id="content-assets"
        className="scroll-mt-20"
        description="查看和编辑已生成内容"
        icon={<FileText className="size-4 text-primary" />}
        action={
          contents.length === 0 ? null : (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              共 {contents.length} 条
            </span>
          )
        }
      >
        {contents.length === 0 ? (
          <EmptyState
            title="还没有任何内容"
            description="选择商品与平台，生成第一条内容。"
            icon={<FileText className="size-4" />}
          />
        ) : (
          <ContentWorkspace
            key={slot ? `${slot.productId}:${slot.platform}:${slot.format}` : "all"}
            contents={contents}
            sourceProducts={sourceProducts}
            isDemoData={dataSource === "mock"}
            selectedSlot={slot}
          />
        )}
      </SectionCard>
    </>
  );
}
