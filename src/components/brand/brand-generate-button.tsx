"use client";

/**
 * 「AI 生成品牌」按钮（客户端组件）
 *
 * 这是页面上**唯一**能触发 Brand Agent 的地方。
 * 它只 import Server Action，不 import 任何服务端模块（`@/services` / `@/ai` / `@/db`），
 * 因此模型 Key 与数据库连接永远不会进入浏览器 bundle。
 *
 * 状态语义（对应任务书 Task 6 的状态机）：
 * - `empty`      → 「AI 生成品牌」
 * - `generating` → 「生成中…」并禁用（含点击后的瞬时态，由 useTransition 提供）
 * - `completed`  → 「重新生成品牌」（图标换成 RefreshCw，语气从「新建」变成「覆盖」）
 * - `failed`     → 「重新生成品牌」（失败原因由服务端渲染在结果卡片里，这里是按钮本身）
 */

import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";

import { generateBrandProfile } from "@/actions/brand-agent";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import type { AppErrorShape } from "@/lib/result";
import type { BrandGenerationStatus } from "@/services/brand-agent.service";

interface BrandGenerateButtonProps {
  /** 主依据商品 id；为 null 表示还没有任何商品，按钮应禁用 */
  sourceProductId: string | null;
  sourceProducts?: Array<{ id: string; name: string }>;
  /** 是否已有品牌档案；决定文案是「生成」还是「重新生成」 */
  hasProfile: boolean;
  /** 服务端记录的生成状态 */
  generationStatus: BrandGenerationStatus;
  /** 模型通道不可用 / 缺少依据商品时的禁用原因 */
  disabledReason?: string;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "soft";
  className?: string;
  /** 展示错误的位置：header 只留按钮，inline 会附带一行错误文案 */
  errorDisplay?: "none" | "inline";
}

export function BrandGenerateButton({
  sourceProductId,
  sourceProducts = [],
  hasProfile,
  generationStatus,
  disabledReason,
  size = "default",
  variant = "default",
  className,
  errorDisplay = "none",
}: BrandGenerateButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<AppErrorShape | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState(sourceProductId ?? sourceProducts[0]?.id ?? "");

  // 服务端记录的「生成中」+ 本次点击产生的瞬时态，对用户来说是同一件事
  const running = isPending || generationStatus === "generating";
  const isRegeneration = hasProfile || generationStatus === "completed";
  const needsDialog = isRegeneration || sourceProducts.length > 1;
  const activeProductId = selectedProductId || sourceProductId || sourceProducts[0]?.id || null;

  const blocked = disabledReason ?? (activeProductId ? undefined : "还没有商品可作为品牌依据，请先添加商品");

  function handleClick(replaceExisting: boolean): void {
    if (!activeProductId) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await generateBrandProfile(activeProductId, replaceExisting);
      if (!result.ok) {
        setError(result.error);
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
      ? "AI 重新生成品牌"
      : "AI 生成品牌草稿";
  const icon = running ? (
    <Loader2 className="animate-spin" />
  ) : isRegeneration ? (
    <RefreshCw />
  ) : (
    <Sparkles />
  );

  const button = <Button
        type="button"
        size={size}
        variant={variant}
        className={className}
        onClick={needsDialog ? undefined : () => handleClick(false)}
        disabled={running || Boolean(blocked)}
        title={blocked ?? (isRegeneration ? "更新现有品牌档案" : "读取商品资料与品牌语气，生成品牌档案")}
        aria-busy={running}
      >
        {icon}
        {label}
      </Button>;

  return (
    <div className="flex flex-col items-start gap-1">
      {needsDialog ? <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogTrigger asChild>{button}</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isRegeneration ? "重新生成品牌档案？" : "选择品牌依据商品"}</DialogTitle>
            <DialogDescription>{isRegeneration
              ? "新的 AI 草稿会覆盖当前品牌档案，包括手动修改过的内容；生成后需重新审核确认。"
              : "选择最能代表你这次品牌定位的商品。商家资料和表达偏好也会一起作为依据。"}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {sourceProducts.length > 1 ? <label className="flex flex-col gap-1 text-[12px] font-medium">
              重点参考商品
              <Select value={activeProductId ?? ""} onChange={(event) => setSelectedProductId(event.target.value)}>
                {sourceProducts.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
              </Select>
            </label> : null}
            {isRegeneration ? <p className="mt-3 text-[12px] text-muted-foreground">当前版本不会自动留存历史副本；请先保存需要保留的文案。</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button type="button" disabled={!activeProductId} onClick={() => { setConfirmOpen(false); handleClick(isRegeneration); }}>{isRegeneration ? "确认覆盖并生成" : "生成品牌草稿"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog> : button}
      {errorDisplay === "inline" && blocked ? (
        <p className="max-w-sm text-[11px] leading-4 text-muted-foreground">{blocked}</p>
      ) : null}
      {errorDisplay === "inline" && error ? (
        <p role="alert" className="max-w-sm text-[11px] leading-5 text-destructive">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
