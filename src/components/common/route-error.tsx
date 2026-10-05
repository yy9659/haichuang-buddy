"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface RouteErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** 是否处于带侧边栏的页面内（决定上下留白） */
  inset?: boolean;
}

/**
 * 路由错误兜底 UI。
 * 由 app/error.tsx 与 app/(app)/error.tsx 共用，保证任何页面异常都有明确中文提示与重试入口。
 */
export function RouteError({ error, reset, inset = false }: RouteErrorProps) {
  React.useEffect(() => {
    // 开发期保留控制台输出，便于定位；生产环境接入日志上报
    console.error("[RouteError]", error);
  }, [error]);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card px-6 text-center shadow-card",
        inset ? "min-h-[60vh]" : "min-h-screen",
      )}
    >
      <span className="flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[15px] font-semibold">页面加载失败</p>
        <p className="max-w-md text-[12px] leading-5 text-muted-foreground">
          {error.message || "服务暂时不可用，请稍后重试。"}
        </p>
        {error.digest ? (
          <p className="text-[11px] text-muted-foreground/80">
            错误编号：{error.digest}
          </p>
        ) : null}
      </div>
      <Button variant="outline" size="sm" onClick={reset}>
        <RefreshCw />
        重新加载
      </Button>
    </div>
  );
}
