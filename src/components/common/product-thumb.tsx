import Image from "next/image";
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
  /** 有真实图片时优先渲染图片；为空则回退到类目语义占位视觉 */
  imageUrl?: string | null;
  className?: string;
  /** 是否显示右下角水印文字 */
  showLabel?: boolean;
}

/**
 * 商品缩略图。
 *
 * 两种情况：
 * - 已上传图片（本地图片地址或 Supabase Storage 公共 URL）→ 渲染真实图片；
 * - 未上传（如 Mock 数据源、或新建商品还没配图）→ 渲染带类目语义的占位视觉，
 *   保证列表在没有任何图片时依然有信息层级，而不是一片空白。
 */
export function ProductThumb({
  name,
  category,
  imageUrl,
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
        "relative flex items-center justify-center overflow-hidden rounded-lg",
        imageUrl ? "bg-muted" : cn("bg-gradient-to-br", visual.className),
        className,
      )}
    >
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt={name}
          fill
          sizes="(min-width: 1280px) 320px, (min-width: 768px) 33vw, 100vw"
          className="object-cover"
        />
      ) : (
        <>
          <div className="absolute inset-0 opacity-[0.18] [background-image:radial-gradient(circle_at_20%_20%,white_1px,transparent_1px),radial-gradient(circle_at_70%_60%,white_1px,transparent_1px)] [background-size:18px_18px]" />
          <Icon className="relative size-6 opacity-80" strokeWidth={1.5} />
        </>
      )}
      {showLabel ? (
        <span
          className={cn(
            "absolute bottom-1 left-1 max-w-[calc(100%-0.5rem)] truncate text-[10px] leading-4 font-medium",
            imageUrl
              ? "rounded bg-foreground/55 px-1 text-background"
              : "opacity-80",
          )}
        >
          {name}
        </span>
      ) : null}
    </div>
  );
}
