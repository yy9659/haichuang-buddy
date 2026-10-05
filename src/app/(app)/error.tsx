"use client";

import { RouteError } from "@/components/common/route-error";

/** 业务页面异常兜底：保留侧边栏与顶部栏 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} inset />;
}
