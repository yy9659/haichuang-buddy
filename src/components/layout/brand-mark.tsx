import { Waves } from "lucide-react";

import { cn } from "@/lib/utils";

interface BrandMarkProps {
  /** 是否显示副标题「连江海产 · AI 一人公司」 */
  showSubtitle?: boolean;
  className?: string;
}

/** 品牌标识：海创Buddy */
export function BrandMark({ showSubtitle = true, className }: BrandMarkProps) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 text-white shadow-sm">
        <Waves className="size-4.5" strokeWidth={2} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[15px] leading-5 font-semibold tracking-tight">
          海创Buddy
        </span>
        {showSubtitle ? (
          <span className="truncate text-[11px] leading-4 text-muted-foreground">
            连江海产 · AI 一人公司
          </span>
        ) : null}
      </span>
    </div>
  );
}
