import { RefreshCw, TriangleAlert } from "lucide-react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import type { AppErrorShape } from "@/lib/result";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  title?: string;
  description?: string;
  /** 直接传错误信封时自动取 message 与可重试标记 */
  error?: AppErrorShape;
  onRetry?: () => void;
  retryLabel?: string;
  icon?: React.ReactNode;
  className?: string;
}

/**
 * 区块级错误占位。
 *
 * 与 `RouteError` 的分工：RouteError 兜整页崩溃（错误边界），
 * 这里兜「某个操作 / 某个区块失败」——例如表单提交失败、局部数据加载失败，
 * 页面其余部分仍然可用。对应技术文档第 21 章「错误与降级策略」。
 */
export function ErrorState({
  title,
  description,
  error,
  onRetry,
  retryLabel = "重试",
  icon,
  className,
}: ErrorStateProps) {
  const canRetry = Boolean(onRetry) && (error?.retryable ?? true);

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2.5",
        className,
      )}
    >
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-destructive/12 text-destructive">
        {icon ?? <TriangleAlert className="size-3.5" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-[13px] leading-5 font-medium text-destructive">
          {title ?? error?.message ?? "操作失败"}
        </p>
        {description ? (
          <p className="text-[11px] leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
        {canRetry ? (
          <div className="mt-0.5">
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw />
              {retryLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
