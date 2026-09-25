import type * as React from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type TagVariant = "default" | "warning" | "success" | "primary";

const VARIANT_CLASS: Record<TagVariant, string> = {
  default: "border-border bg-muted/70 text-foreground",
  primary: "border-primary/15 bg-primary-soft text-primary",
  warning: "border-warning/25 bg-warning/12 text-warning",
  success: "border-success/20 bg-success/10 text-success",
};

interface TagSectionProps {
  title: string;
  items: string[];
  variant?: TagVariant;
  /** 是否展示条目数量 */
  showCount?: boolean;
  className?: string;
}

/** 通用标签区块（Product DNA / 品牌词条 / 知识标签复用） */
export function TagSection({
  title,
  items,
  variant = "default",
  showCount = true,
  className,
}: TagSectionProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span className="text-[12px] font-semibold text-muted-foreground">
        {title}
        {showCount ? (
          <span className="ml-1.5 font-normal text-muted-foreground/70 tabular-nums">
            {items.length}
          </span>
        ) : null}
      </span>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li
            key={item}
            className={cn(
              "rounded-lg border px-2.5 py-1 text-[12px] leading-5",
              VARIANT_CLASS[variant],
            )}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface TagSectionCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

/** 带标题的区块卡片 */
export function TagSectionCard({
  title,
  description,
  children,
  className,
}: TagSectionCardProps) {
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold">{title}</span>
          {description ? (
            <span className="text-[11px] leading-4 text-muted-foreground">
              {description}
            </span>
          ) : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}
