import Image from "next/image";

import { cn } from "@/lib/utils";

interface BrandMarkProps {
  /** 是否显示副标题 */
  showSubtitle?: boolean;
  /** 视频背景上的浅色字标，及登录面板中的大尺寸品牌。 */
  onDark?: boolean;
  large?: boolean;
  className?: string;
}

/** 品牌标识：海创Buddy */
export function BrandMark({
  showSubtitle = true,
  onDark = false,
  large = false,
  className,
}: BrandMarkProps) {
  return (
    <div className={cn("flex items-center", large ? "gap-3" : "gap-2", className)}>
      <Image
        src="/assets/haichuang-logo.png"
        alt=""
        width={1312}
        height={1199}
        className={cn("h-auto shrink-0 object-contain", large ? "w-14" : "w-9")}
        priority
      />
      <span className="flex min-w-0 flex-col">
        <Image
          src="/assets/haichuang-wordmark.png"
          alt="海创Buddy"
          width={2172}
          height={724}
          className={cn(
            "h-auto object-contain",
            large ? "w-[210px] max-w-full" : "w-[130px] max-w-full",
            onDark && "brightness-0 invert",
          )}
          priority
        />
        {showSubtitle ? (
          <span className={cn("truncate text-[11px] leading-4 text-muted-foreground", onDark && "text-white/75")}>
            连江海产经营伙伴
          </span>
        ) : null}
      </span>
    </div>
  );
}
