import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CalendarClock,
  MapPin,
  Ruler,
  Snowflake,
  Timer,
  TrendingUp,
} from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { ProductThumb } from "@/components/common/product-thumb";
import { SectionCard } from "@/components/common/section-card";
import { ProductAnalysisButton } from "@/components/products/product-analysis-button";
import { ProductAnalysisPanel } from "@/components/products/product-analysis-panel";
import { ProductAttributes } from "@/components/products/product-attributes";
import { ProductDeleteDialog } from "@/components/products/product-delete-dialog";
import { ProductEditDialog } from "@/components/products/product-form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { unwrapOrThrow } from "@/lib/result";
import { PRODUCT_ANALYSIS_META } from "@/lib/status-meta";
import { formatCompact, formatCurrency } from "@/lib/utils";
import { getProductDetailView, listProductIds } from "@/services";

interface ProductDetailPageProps {
  params: Promise<{ id: string }>;
}

/**
 * 预渲染已有商品详情页；未列出的 id 按需渲染（新商品、mock 新增商品都能直接访问）。
 *
 * 这里的 try/catch 是刻意的：`DATA_SOURCE=db` 时构建机上可能没有可用数据库连接，
 * 此时不应让 `pnpm build` 失败 —— 拿不到 id 就退化成「全部按需渲染」。
 */
export async function generateStaticParams() {
  const ids = await listProductIds();
  return ids.ok ? ids.data.map((id) => ({ id })) : [];
}

export async function generateMetadata({
  params,
}: ProductDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const result = await getProductDetailView(id);
  const product = result.ok ? result.data?.product : undefined;
  return {
    title: product
      ? `${product.name} · 商品理解 · 海创Buddy`
      : "商品理解 · 海创Buddy",
  };
}

export default async function ProductDetailPage({
  params,
}: ProductDetailPageProps) {
  const { id } = await params;
  const view = unwrapOrThrow(await getProductDetailView(id));

  if (!view) {
    notFound();
  }

  const { product, dna, imageUploadEnabled, analysis } = view;
  const statusMeta = PRODUCT_ANALYSIS_META[product.analysisStatus];

  const attributes = [
    { id: "origin", label: "产地", value: product.origin, icon: MapPin },
    {
      id: "spec",
      label: "规格",
      value: product.specification,
      icon: Ruler,
    },
    {
      id: "storage",
      label: "储存方式",
      value: product.storageMethod,
      icon: Snowflake,
    },
    { id: "shelf", label: "保质期", value: product.shelfLife, icon: Timer },
    {
      id: "stock",
      label: "库存",
      value: `${product.stock} ${product.unit}`,
      icon: TrendingUp,
    },
    {
      id: "updated",
      label: "更新时间",
      value: product.updatedAt,
      icon: CalendarClock,
    },
  ];

  return (
    <>
      <PageHeader
        title={product.name}
        description={product.description || "暂无商品描述"}
        badge={<Badge variant={statusMeta.tone}>{statusMeta.label}</Badge>}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/products">
                <ArrowLeft />
                返回商品中心
              </Link>
            </Button>
            <ProductEditDialog
              product={product}
              imageUploadEnabled={imageUploadEnabled}
            />
            <ProductDeleteDialog
              product={product}
              redirectToList
              triggerVariant="outline"
              className="text-destructive"
            />
            {/* 唯一触发 Product Agent 的入口；实际调用走 Server Action，页面不接触 Agent */}
            <ProductAnalysisButton
              productId={product.id}
              analysisStatus={product.analysisStatus}
              hasDna={Boolean(dna)}
              {...(analysis.provider.usable
                ? {}
                : { disabledReason: analysis.provider.reason ?? "模型通道不可用" })}
            />
          </>
        }
      />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,320px)_1fr]">
        <div className="flex flex-col gap-3">
          <SectionCard title="商品资料" description="商品经理 Agent 的输入">
            <div className="flex flex-col gap-3">
              <ProductThumb
                name={product.name}
                category={product.category}
                imageUrl={product.imageUrl}
                className="aspect-4/3 w-full"
              />
              <div className="flex items-baseline gap-2">
                <span className="text-2xl leading-8 font-semibold text-primary tabular-nums">
                  {formatCurrency(product.price)}
                </span>
                <span className="text-[12px] text-muted-foreground">
                  / {product.unit || "份"}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="soft">{product.category}</Badge>
                {product.subCategory ? (
                  <Badge variant="soft">{product.subCategory}</Badge>
                ) : null}
                {product.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="mt-3 border-t border-border/70">
              <ProductAttributes items={attributes} />
            </div>
          </SectionCard>

          <SectionCard title="经营表现" description="近 7 天累计">
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: "views", label: "浏览量", value: product.metrics.views },
                {
                  id: "inquiries",
                  label: "咨询量",
                  value: product.metrics.inquiries,
                },
                {
                  id: "conversions",
                  label: "成交量",
                  value: product.metrics.conversions,
                },
              ].map((item) => (
                <div key={item.id} className="flex flex-col gap-0.5">
                  <span className="text-[17px] leading-6 font-semibold tabular-nums">
                    {formatCompact(item.value)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 border-t border-border/70 pt-2.5 text-[11px] leading-5 text-muted-foreground">
              经营数据由直播与客服模块汇总，本阶段新建商品从 0 开始累计。
            </p>
          </SectionCard>
        </div>

        <div className="min-w-0">
          <ProductAnalysisPanel product={product} dna={dna} analysis={analysis} />
        </div>
      </div>
    </>
  );
}
