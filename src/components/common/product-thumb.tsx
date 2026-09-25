import { Fish, Layers, Package, Salad, Waves } from "lucide-react";

import { cn } from "@/lib/utils";
import type { IconComponent, ProductCategory } from "@/types";

const CATEGORY_VISUAL: Record<
  ProductCategory,
  { icon: IconComponent; className: string }
> = {
  海产品: {
    icon: Fish,
    className: "from-sky-100 via-cyan-50 to-blue-100 text-blue-600",
  },
  干货: {
    icon: Layers,
    className: "from-amber-100 via-orange-50 to-amber-100 text-amber-600",
  },
  预制菜: {
    icon: Salad,
    className: "from-emerald-100 via-teal-50 to-emerald-100 text-emerald-600",
  },
  礼盒: {
    icon: Package,
    className: "from-rose-100 via-pink-50 to-rose-100 text-rose-500",
  },
};

interface ProductThumbProps {
  name: string;
  category: ProductCategory;
  className?: string;
  /** 是否显示右下角水印文字 */
  showLabel?: boolean;
}

/**
 * 商品缩略图占位。
 * 本轮不使用真实图片资源，统一渲染带类目语义的占位视觉。
 */
export function ProductThumb({
  name,
  category,
  className,
  showLabel = true,
}: ProductThumbProps) {
  const visual = CATEGORY_VISUAL[category] ?? {
    icon: Waves,
    className: "from-sky-100 to-blue-100 text-blue-600",
  };
  const Icon = visual.icon;

  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br",
        visual.className,
        className,
      )}
    >
      <div className="absolute inset-0 opacity-[0.18] [background-image:radial-gradient(circle_at_20%_20%,white_1px,transparent_1px),radial-gradient(circle_at_70%_60%,white_1px,transparent_1px)] [background-size:18px_18px]" />
      <Icon className="relative size-6 opacity-80" strokeWidth={1.5} />
      {showLabel ? (
        <span className="absolute bottom-1 left-1 max-w-[calc(100%-0.5rem)] truncate text-[10px] leading-4 font-medium opacity-80">
          {name}
        </span>
      ) : null}
    </div>
  );
}
