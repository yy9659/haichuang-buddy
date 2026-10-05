import { Package } from "lucide-react";
import Link from "next/link";

import { ProductThumb } from "@/components/common/product-thumb";
import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PRODUCT_ANALYSIS_META } from "@/lib/status-meta";
import { cn, formatCompact, formatCurrency } from "@/lib/utils";
import type { Product } from "@/types";

interface ProductSpotlightProps {
  /** 主打商品 */
  product: Product;
  /** 其余商品数量 */
  totalCount: number;
}

/** 驾驶舱 · 我的商品速览 */
export function ProductSpotlight({
  product,
  totalCount,
}: ProductSpotlightProps) {
  const meta = PRODUCT_ANALYSIS_META[product.analysisStatus];

  return (
    <SectionCard
      title="我的商品"
      description={`共 ${totalCount} 个商品在售`}
      icon={<Package className="size-4 text-primary" />}
      moreHref="/products"
      action={
        <Button variant="soft" size="sm" asChild>
          <Link href="/products">管理商品</Link>
        </Button>
      }
    >
      <div className="flex gap-3">
        <ProductThumb
          name={product.name}
          category={product.category}
          imageUrl={product.imageUrl}
          className="size-20 shrink-0"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="truncate text-[14px] leading-5 font-semibold">
              {product.name}
            </span>
            <Badge variant={meta.tone} className="shrink-0">
              {meta.label}
            </Badge>
          </div>
          <p className="line-clamp-2 text-[12px] leading-5 text-muted-foreground">
            {product.description}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{product.origin}</Badge>
            <Badge variant="secondary">{product.specification}</Badge>
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-[17px] leading-6 font-semibold text-primary tabular-nums">
              {formatCurrency(product.price)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              / {product.unit}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/70 pt-3">
        {[
          { id: "views", label: "浏览量", value: product.metrics.views },
          { id: "inquiries", label: "咨询量", value: product.metrics.inquiries },
          {
            id: "conversions",
            label: "成交量",
            value: product.metrics.conversions,
          },
        ].map((item) => (
          <div key={item.id} className="flex flex-col gap-0.5">
            <span className="text-[15px] leading-6 font-semibold tabular-nums">
              {formatCompact(item.value)}
            </span>
            <span
              className={cn("text-[11px] leading-4 text-muted-foreground")}
            >
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
