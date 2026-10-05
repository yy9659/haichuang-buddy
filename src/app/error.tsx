"use client";

import { RouteError } from "@/components/common/route-error";

/** 根级异常兜底：连布局都渲染失败时使用 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <RouteError error={error} reset={reset} />
    </div>
  );
}
