import Link from "next/link";
import { ArrowRight, Boxes, Eye, MessageSquare, Sparkles } from "lucide-react";

import { ProductThumb } from "@/components/common/product-thumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PRODUCT_ANALYSIS_META } from "@/lib/status-meta";
import { cn, formatCompact, formatCurrency } from "@/lib/utils";
import type { Product } from "@/types";

/** 商品卡片 */
export function ProductCard({ product }: { product: Product }) {
  const meta = PRODUCT_ANALYSIS_META[product.analysisStatus];
  const lowStock = product.stock > 0 && product.stock < 50;
  const outOfStock = product.stock === 0;

  return (
    <Card className="flex h-full flex-col transition-all hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-float">
      <CardContent className="flex flex-1 flex-col gap-3 pt-4">
        <div className="flex gap-3">
          <ProductThumb
            name={product.name}
            category={product.category}
            className="size-16 shrink-0"
            showLabel={false}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/products/${product.id}`}
                className="truncate text-[14px] leading-5 font-semibold outline-none hover:text-primary"
              >
                {product.name}
              </Link>
              <Badge variant={meta.tone} className="shrink-0">
                {meta.label}
              </Badge>
            </div>
            <span className="truncate text-[11px] text-muted-foreground">
              {product.category} · {product.subCategory} · {product.specification}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {product.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-baseline justify-between gap-2">
          <span className="flex items-baseline gap-1">
            <span className="text-[17px] leading-6 font-semibold text-primary tabular-nums">
              {formatCurrency(product.price)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              / {product.unit}
            </span>
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[11px] font-medium tabular-nums",
              outOfStock
                ? "text-destructive"
                : lowStock
                  ? "text-warning"
                  : "text-muted-foreground",
            )}
          >
            <Boxes className="size-3" />
            {outOfStock ? "已售罄" : `库存 ${product.stock}`}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/60 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Eye className="size-3" />
            浏览
            <span className="font-medium text-foreground tabular-nums">
              {formatCompact(product.metrics.views)}
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <MessageSquare className="size-3" />
            咨询
            <span className="font-medium text-foreground tabular-nums">
              {formatCompact(product.metrics.inquiries)}
            </span>
          </span>
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/70 pt-3">
          <span className="truncate text-[11px] text-muted-foreground">
            更新于 {product.updatedAt}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]">
              <Sparkles className="size-3.5" />
              AI 分析
            </Button>
            <Button variant="soft" size="sm" className="h-7 px-2 text-[12px]" asChild>
              <Link href={`/products/${product.id}`}>
                查看 DNA
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
