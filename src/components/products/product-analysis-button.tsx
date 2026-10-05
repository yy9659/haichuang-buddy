"use client";

/**
 * 「AI 分析商品」按钮（客户端组件）
 *
 * 这是页面上**唯一**能触发 Product Agent 的地方。
 * 它只 import Server Action，不 import 任何服务端模块（`@/services` / `@/ai` / `@/db`），
 * 因此模型 Key 与数据库连接永远不会进入浏览器 bundle。
 *
 * 状态语义（对应任务书 Task 4 的状态机）：
 * - `pending`   → 「AI 分析商品」
 * - `analyzing` → 「分析中…」并禁用（含点击后的瞬时态，由 useTransition 提供）
 * - `analyzed`  → 「重新分析」（图标换成 RefreshCw，语气从「新建」变成「覆盖」）
 * - `failed`    → 「重新分析」（失败原因由服务端渲染在结果卡片里，这里是按钮本身）
 */

import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";

import { startProductAnalysis } from "@/actions/product-agent";
import { Button } from "@/components/ui/button";
import type { AppErrorShape } from "@/lib/result";
import type { ProductAnalysisStatus } from "@/types";

interface ProductAnalysisButtonProps {
  productId: string;
  analysisStatus: ProductAnalysisStatus;
  /** 是否已有 Product DNA；决定按钮文案是「分析」还是「重新分析」 */
  hasDna: boolean;
  /** 模型通道不可用时的禁用原因（例如配了 dashscope 但没填 Key） */
  disabledReason?: string;
  size?: "sm" | "default";
  /** 用于空状态里那个更大的按钮 */
  variant?: "default" | "outline" | "soft";
  className?: string;
  /** 展示错误的位置：header 只留按钮，inline 会附带一行错误文案 */
  errorDisplay?: "none" | "inline";
}

export function ProductAnalysisButton({
  productId,
  analysisStatus,
  hasDna,
  disabledReason,
  size = "default",
  variant = "default",
  className,
  errorDisplay = "none",
}: ProductAnalysisButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<AppErrorShape | null>(null);

  // 服务端记录的「分析中」+ 本次点击产生的瞬时态，对用户来说是同一件事
  const running = isPending || analysisStatus === "analyzing";
  const isReanalysis = hasDna || analysisStatus === "analyzed" || analysisStatus === "failed";

  function handleClick(): void {
    setError(null);
    startTransition(async () => {
      const result = await startProductAnalysis(productId);
      if (!result.ok) {
        setError(result.error);
      }
      /**
       * 无论成败都刷新：失败时商品状态会变成 failed、任务记录会写入失败原因，
       * 不刷新页面就永远停在旧状态。Action 里的 revalidatePath 负责清缓存，
       * 这里的 refresh 负责让当前这一屏重新取数。
       */
      router.refresh();
    });
  }

  const label = running ? "分析中…" : isReanalysis ? "重新分析" : "AI 分析商品";
  const icon = running ? (
    <Loader2 className="animate-spin" />
  ) : isReanalysis ? (
    <RefreshCw />
  ) : (
    <Sparkles />
  );

  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        className={className}
        onClick={handleClick}
        disabled={running || Boolean(disabledReason)}
        title={disabledReason ?? (isReanalysis ? "更新现有商品分析" : undefined)}
        aria-busy={running}
      >
        {icon}
        {label}
      </Button>
      {errorDisplay === "inline" && error ? (
        <p
          role="alert"
          className="max-w-sm text-[11px] leading-5 text-destructive"
        >
          {error.message}
        </p>
      ) : null}
    </>
  );
}
