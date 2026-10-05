"use client";

import { RouteError } from "@/components/common/route-error";

/**
 * /products 段级错误兜底。
 * 商品列表加载失败（数据库不可用、迁移未执行等）时给出重试入口，
 * 而不是让整个 Dashboard 崩溃。
 */
export default function ProductsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} inset />;
}
