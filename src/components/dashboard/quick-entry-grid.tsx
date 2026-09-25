import Link from "next/link";
import {
  ChartLine,
  FileText,
  Headphones,
  Megaphone,
  Package,
  Palette,
} from "lucide-react";

import type { IconComponent } from "@/types";

interface QuickEntry {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: IconComponent;
}

const ENTRIES: QuickEntry[] = [
  {
    id: "entry_product",
    title: "商品理解",
    description: "多模态分析",
    href: "/products",
    icon: Package,
  },
  {
    id: "entry_brand",
    title: "品牌策划",
    description: "定位与故事",
    href: "/brand",
    icon: Palette,
  },
  {
    id: "entry_content",
    title: "内容营销",
    description: "图文 / 视频 / 文案",
    href: "/content",
    icon: FileText,
  },
  {
    id: "entry_live",
    title: "直播辅助",
    description: "策略与话术",
    href: "/live",
    icon: Megaphone,
  },
  {
    id: "entry_cs",
    title: "智能客服",
    description: "知识库问答",
    href: "/customer-service",
    icon: Headphones,
  },
  {
    id: "entry_analytics",
    title: "经营复盘",
    description: "优化建议",
    href: "/analytics",
    icon: ChartLine,
  },
];

/** 驾驶舱能力快捷入口 */
export function QuickEntryGrid() {
  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {ENTRIES.map((entry) => {
        const Icon = entry.icon;
        return (
          <Link
            key={entry.id}
            href={entry.href}
            className="group flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 shadow-card transition-all hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-float"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
              <Icon className="size-4" strokeWidth={1.9} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] leading-5 font-medium">
                {entry.title}
              </span>
              <span className="truncate text-[11px] leading-4 text-muted-foreground">
                {entry.description}
              </span>
            </span>
          </Link>
        );
      })}
    </section>
  );
}
