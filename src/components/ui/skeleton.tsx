import type * as React from "react";

import { cn } from "@/lib/utils";

/** 加载占位块（骨架屏），用于 loading.tsx 与局部数据加载 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-pulse-soft rounded-md bg-muted", className)}
      {...props}
    />
  );
}
