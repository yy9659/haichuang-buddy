import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CalendarClock,
  MapPin,
  Ruler,
  Snowflake,
  Sparkles,
  Timer,
  TrendingUp,
  Upload,
} from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { ProductThumb } from "@/components/common/product-thumb";
import { SectionCard } from "@/components/common/section-card";
import { ProductAttributes } from "@/components/products/product-attributes";
import { ProductDnaPanel } from "@/components/products/product-dna-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MOCK_PRODUCTS, MOCK_PRODUCT_DNA } from "@/lib/mock";
import { PRODUCT_ANALYSIS_META } from "@/lib/status-meta";
import { formatCompact, formatCurrency } from "@/lib/utils";

interface ProductDetailPageProps {
  params: Promise<{ id: string }>;
}

export function generateStaticParams() {
  return MOCK_PRODUCTS.map((product) => ({ id: product.id }));
}

export async function generateMetadata({
  params,
}: ProductDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const product = MOCK_PRODUCTS.find((item) => item.id === id);
  return {
    title: product
      ? `${product.name} · Product DNA · 海创Buddy`
      : "Product DNA · 海创Buddy",
  };
}

/** Product DNA 页面：商品基础资料 + 商品经理 Agent 的结构化输出 */
export default async function ProductDetailPage({
  params,
}: ProductDetailPageProps) {
  const { id } = await params;
  const product = MOCK_PRODUCTS.find((item) => item.id === id);

  if (!product) {
    notFound();
  }

  const dna = MOCK_PRODUCT_DNA[product.id];
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
        description={product.description}
        badge={<Badge variant={statusMeta.tone}>{statusMeta.label}</Badge>}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/products">
                <ArrowLeft />
                返回商品中心
              </Link>
            </Button>
            <Button variant="soft">
              <Upload />
              替换图片
            </Button>
            <Button>
              <Sparkles />
              {dna ? "重新分析" : "AI 分析商品"}
            </Button>
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
                className="aspect-4/3 w-full"
              />
              <div className="flex items-baseline gap-2">
                <span className="text-2xl leading-8 font-semibold text-primary tabular-nums">
                  {formatCurrency(product.price)}
                </span>
                <span className="text-[12px] text-muted-foreground">
                  / {product.unit}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="soft">{product.category}</Badge>
                <Badge variant="soft">{product.subCategory}</Badge>
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

          <SectionCard title="经营表现" description="近 7 天累计（Mock）">
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
          </SectionCard>
        </div>

        <div className="min-w-0">
          {dna ? (
            <ProductDnaPanel dna={dna} />
          ) : (
            <SectionCard
              title="Product DNA"
              description="商品经理 Agent 的结构化输出"
            >
              <EmptyState
                title="尚未生成 Product DNA"
                description="点击右上角「AI 分析商品」，商品经理 Agent 将读取图片与资料，输出结构化 DNA 供其他 AI 员工复用。"
                icon={<Sparkles className="size-4" />}
                action={
                  <Button size="sm" className="mt-1">
                    <Sparkles />
                    立即分析
                  </Button>
                }
              />
            </SectionCard>
          )}
        </div>
      </div>
    </>
  );
}
