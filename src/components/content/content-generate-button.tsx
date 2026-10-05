"use client";

/**
 * 「AI 生成内容」按钮（客户端组件）
 *
 * 这是整个内容工厂里**唯一**能触发 Content Agent 的地方。
 * 它只 import Server Action，不 import 任何服务端模块（`@/services` / `@/ai` / `@/db`），
 * 因此模型 Key 与数据库连接永远不会进入浏览器 bundle。
 *
 * 按钮文案随**生成状态**变化（对应任务书 Task 6 的四态）：
 * - `empty`      → 「AI 生成内容」（这个槽位还没有东西）
 * - `generating` → 「生成中…」并禁用（含点击后的瞬时态，由 useTransition 提供）
 * - `completed`  → 「重新生成内容」（图标换成 RefreshCw，语气从「新建」变成「覆盖」）
 * - `failed`     → 「重新生成内容」（失败原因由调用方渲染，这里只负责按钮本身）
 */

import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";

import { generateContent } from "@/actions/content-agent";
import { Button } from "@/components/ui/button";
import type { ContentAngle } from "@/lib/content-options";
import type { AppErrorShape } from "@/lib/result";
import type { ContentGenerationStatus } from "@/services/content-agent.service";
import type { ContentSlot } from "@/types";

interface ContentGenerateButtonProps {
  /** 目标槽位；为 null 表示还没有任何商品，按钮应禁用 */
  slot: ContentSlot | null;
  /** 该槽位是否已有内容；决定文案是「生成」还是「重新生成」 */
  hasContent: boolean;
  /** 服务端记录的生成状态 */
  generationStatus: ContentGenerationStatus;
  angle?: ContentAngle;
  /** 模型通道不可用 / 缺少商品 / 缺少依据时的禁用原因 */
  disabledReason?: string;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "soft";
  className?: string;
  /** 展示错误的位置：面板里用 inline，放在卡片内的按钮旁边 */
  errorDisplay?: "none" | "inline";
}

export function ContentGenerateButton({
  slot,
  hasContent,
  generationStatus,
  angle = "selling-point",
  disabledReason,
  size = "default",
  variant = "default",
  className,
  errorDisplay = "none",
}: ContentGenerateButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [failure, setFailure] = useState<{
    key: string;
    error: AppErrorShape;
  } | null>(null);

  // 服务端记录的「生成中」+ 本次点击产生的瞬时态，对用户来说是同一件事
  const running = isPending || generationStatus === "generating";
  const isRegeneration = hasContent || generationStatus === "completed";

  /**
   * 错误与**槽位绑定**：记下出错时是哪个槽位，只有当前槽位仍是它才展示。
   * 这样用户切换商品 / 平台后旧错误自动消失，无需在 effect 里清状态
   * （React 19 的 lint 规则禁止在 effect 里同步 setState）。
   */
  const slotKey = slot ? `${slot.productId}|${slot.platform}|${slot.format}` : "";
  const error = failure && failure.key === slotKey ? failure.error : null;

  const blocked =
    disabledReason ?? (slot ? undefined : "还没有商品可作为内容依据，请先添加商品");

  function handleClick(): void {
    if (!slot) {
      return;
    }
    if (isRegeneration && !window.confirm("重新生成会覆盖当前这份内容。请先下载或复制需要保留的版本，确定继续吗？")) {
      return;
    }
    const key = slotKey;
    const target = slot;
    setFailure(null);
    startTransition(async () => {
      const result = await generateContent(
        target.productId,
        target.platform,
        target.format,
        angle,
      );
      if (!result.ok) {
        setFailure({ key, error: result.error });
      }
      /**
       * 无论成败都刷新：失败时任务记录会写入失败原因、界面需要从「生成中」切到「失败」，
       * 不刷新页面就永远停在旧状态。Action 里的 revalidatePath 负责清缓存，
       * 这里的 refresh 负责让当前这一屏重新取数。
       */
      router.refresh();
    });
  }

  const label = running
    ? "生成中…"
    : isRegeneration
      ? "重新生成内容"
      : "AI 生成内容";
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
        disabled={running || Boolean(blocked)}
        title={
          blocked ??
          (isRegeneration
            ? "覆盖该平台已有的内容"
            : "读取商品资料与品牌档案，按平台特点生成内容")
        }
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
