import type { Metadata } from "next";

import { PageHeader } from "@/components/common/page-header";
import { TagSection } from "@/components/common/tag-section";
import {
  BrandIdentityCard,
  BrandValueGrid,
} from "@/components/brand/brand-identity-card";
import { BrandGenerationPanel } from "@/components/brand/brand-generation-panel";
import { BrandGenerateButton } from "@/components/brand/brand-generate-button";
import { BrandDraftControls, BusinessSettingsCard, OwnerSettingsCard } from "@/components/brand/brand-settings";
import { BRAND_STATUS_META } from "@/components/brand/brand-status";
import { BrandStoryCard } from "@/components/brand/owner-twin-card";
import { Badge } from "@/components/ui/badge";
import { unwrapOrThrow } from "@/lib/result";
import { getBrandView } from "@/services";

export const metadata: Metadata = {
  title: "品牌中心 · 海创Buddy",
};

/**
 * 品牌中心：品牌定位 + 品牌资产 + 品牌故事 + 老板数字分身。
 *
 * 数据全部来自服务层（`getBrandView()`），不再直接读 Mock 常量：
 * 品牌档案是 Brand Agent 的产出，可能**尚未生成**（empty）、正在生成（generating）、
 * 生成失败（failed）或已生成（completed）。四种状态都由这里分支渲染，
 * 过程细节（生成记录 / 风险提示 / 模型通道）交给 `BrandGenerationPanel`。
 */
export default async function BrandPage() {
  const view = unwrapOrThrow(await getBrandView());
  const { business, owner, brand, generation, sourceProduct, sourceProducts } = view;

  const statusMeta = BRAND_STATUS_META[generation.status];
  return (
    <>
      <PageHeader
        title="品牌中心"
        description="先完善商家事实与说话方式，再决定品牌如何表达。"
        badge={
          <Badge variant={brand ? (brand.approved ? "success" : "neutral") : statusMeta.tone}>
            {brand
              ? `${brand.aiVersion === "manual-v1" ? "人工档案" : "AI 草稿"} · ${brand.approved ? "已确认" : "待确认"}`
              : statusMeta.label}
          </Badge>
        }
        actions={<BrandGenerateButton
          sourceProductId={sourceProduct?.id ?? null}
          sourceProducts={sourceProducts}
          hasProfile={brand !== null}
          generationStatus={generation.status}
          disabledReason={generation.provider.usable ? undefined : generation.provider.reason ?? "模型通道不可用"}
          errorDisplay="inline"
        />}
      />

      <section className="grid gap-3 xl:grid-cols-2">
        <BusinessSettingsCard business={business} />
        <OwnerSettingsCard owner={owner} />
      </section>

      <BrandDraftControls brand={brand} />

      {brand ? (
        <>
          <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
            <BrandIdentityCard brand={brand} />
            <BrandValueGrid brand={brand} />
          </div>

          <div className="grid gap-3">
            <BrandStoryCard brand={brand} />
          </div>

          {/* 生成记录 + 风险提示（失败重试提示也在这里） */}
          <BrandGenerationPanel view={view} />

          <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-card">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
              <span>
                品牌档案更新时间：{brand.updatedAt}
              </span>
              <span>· 当前品牌：{business?.name ?? "—"}（{business?.location ?? "—"}）</span>
              <span>
                · 确认状态：
                {brand.approved ? "商家已确认" : "待商家确认（确认前不得对外使用）"}
              </span>
            </div>
            <TagSection
              title="品牌依据"
              items={
                brand.aiVersion === "manual-v1"
                  ? ["当前档案由商家手动整理，可随时继续修改"]
                  : generation.latestTask
                  ? [
                      `主依据商品：${generation.latestTask.sourceProductName ?? "—"}`,
                      `参与推导商品：${generation.latestTask.sourceProductCount} 个`,
                      `资料已完善：${generation.latestTask.analyzedProductCount} 个`,
                      owner?.tone.length ? "已读取表达偏好" : "尚未设置表达偏好",
                    ]
                  : ["本次为历史档案，无生成记录"]
              }
              showCount={false}
            />
          </div>
        </>
      ) : (
        /* empty / generating / failed —— 三种没有档案的状态统一交给面板分支 */
        <BrandGenerationPanel view={view} />
      )}
    </>
  );
}
