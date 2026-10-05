"use client";

/**
 * 「生成经营日报」按钮（客户端组件）
 *
 * 与销售建议按钮共用 Analytics Agent。这里只 import Server Action，
 * 不 import 任何服务端模块（`@/services` / `@/ai` / `@/db`），
 * 因此模型 Key 与数据源凭证永远不会进入浏览器 bundle。
 *
 * 状态语义（与品牌 / 内容生成按钮同一套）：
 * - `empty`      → 「生成经营日报」
 * - `generating` → 「分析中…」并禁用（含点击后的瞬时态，由 useTransition 提供）
 * - `completed`  → 「重新生成日报」（语气从「新建」变成「覆盖」）
 * - `failed`     → 「重新生成日报」（失败原因由服务端渲染在日报区，这里是按钮本身）
 */

import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";

import { generateBusinessReportAction } from "@/actions/analytics";
import { Button } from "@/components/ui/button";
import { salesReviewErrorMessage } from "@/lib/sales-review-error";
import type { AppErrorShape } from "@/lib/result";
import type { AnalyticsReportStatus } from "@/services/analytics.service";

interface GenerateBusinessReportButtonProps {
  /** 服务端记录的日报生成状态 */
  status: AnalyticsReportStatus;
  /**
   * 日报仓储在当前数据源下不可用时的原因。
   *
   * 非空时按钮禁用并把原因放进 `title` —— 让用户看到「按钮在这儿，
   * 但这个数据源下点不了」，而不是让按钮凭空消失（那看起来像功能丢了）。
   */
  unavailableReason?: string | null;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "soft";
  className?: string;
  /** 展示错误的位置：header 只留按钮，inline 会附带一行错误文案 */
  errorDisplay?: "none" | "inline";
}

export function GenerateBusinessReportButton({
  status,
  unavailableReason = null,
  size = "default",
  variant = "default",
  className,
  errorDisplay = "inline",
}: GenerateBusinessReportButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<AppErrorShape | null>(null);

  // 服务端记录的「生成中」+ 本次点击产生的瞬时态，对用户来说是同一件事
  const running = isPending || status === "generating";
  const isRegeneration = status === "completed" || status === "failed";
  const unavailable = unavailableReason !== null;
  const defaultTitle = "根据商户导入销售与站内工作记录整理经营回顾";

  function handleClick(): void {
    if (unavailable) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await generateBusinessReportAction();
      if (!result.ok) {
        setError(result.error);
      }
      /**
       * 无论成败都刷新：失败时任务记录会写入失败原因、界面需要从「分析中」
       * 切到「最近一次复盘异常」，不刷新页面就永远停在旧状态。
       * Action 里的 revalidatePath 负责清缓存，这里的 refresh 让当前这屏重新取数。
       */
      router.refresh();
    });
  }

  const label = unavailable
    ? "当前数据源未启用"
    : running
      ? "分析中…"
      : isRegeneration
        ? "重新整理回顾"
        : "生成工作回顾";
  const icon = running ? (
    <Loader2 className="animate-spin" />
  ) : isRegeneration ? (
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
        disabled={running || unavailable}
        aria-busy={running}
        title={unavailableReason ?? defaultTitle}
      >
        {icon}
        {label}
      </Button>
      {errorDisplay === "inline" && error ? (
        <p role="alert" className="max-w-sm text-[11px] leading-5 text-destructive">
          {salesReviewErrorMessage(error)}
        </p>
      ) : null}
    </>
  );
}
