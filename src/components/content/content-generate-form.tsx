"use client";

/**
 * 内容生成表单（客户端组件）
 *
 * 任务书 Task 6 要求的三步流程在这里收口：
 *
 *   选择商品 → 选择平台（与内容形态）→ 生成
 *
 * 两个选择框**不是本地 state**，而是直接写回 URL（`router.replace`）：
 * - 槽位是否有效（商品存不存在、有没有 DNA、这个平台之前生成过没有）
 *   必须由服务端判断，页面自己存一份 state 只会与服务端产生两份真相；
 * - 换来的是「鲍鱼 × 小红书 × 图文笔记」这样一条可分享、可收藏的地址。
 *
 * 刻意用 `replace` 而不是 `push`：用户可能连着换五六个下拉，
 * 用 `push` 会往历史里塞五六个中间状态，点「返回」要按六次才能离开本页。
 *
 * 也刻意**不做 form + submit**：这里没有「填一半提交」的语义，
 * 选择即生效，生成是一个独立动作（按钮在自己的组件里，见 ContentGenerateButton）。
 */

import { usePathname, useRouter } from "next/navigation";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { ContentGenerateButton } from "@/components/content/content-generate-button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  CONTENT_ANGLES,
  CONTENT_ANGLE_META,
  CONTENT_FORMATS,
  CONTENT_PLATFORMS,
  DEFAULT_CONTENT_FORMAT,
  DEFAULT_CONTENT_PLATFORM,
} from "@/lib/content-options";
import type { ContentAngle } from "@/lib/content-options";
import { CONTENT_FORMAT_LABEL, CONTENT_PLATFORM_LABEL } from "@/lib/status-meta";
import type { ContentBasis } from "@/services/content";
import type {
  ContentSlotState,
  ContentSourceProduct,
} from "@/services/content-agent.service";
import type { ContentFormat, ContentPlatform, ContentSlot } from "@/types";

/** 槽位 → 字符串 key，用于判断「这个平台是否已经生成过内容」 */
function toSlotKey(
  productId: string,
  platform: ContentPlatform,
  format: ContentFormat,
): string {
  return `${productId}|${platform}|${format}`;
}

interface ContentGenerateFormProps {
  sourceProducts: ContentSourceProduct[];
  /** 当前槽位；为 null 表示一件商品都没有 */
  slot: ContentSlot | null;
  slotState: ContentSlotState | null;
  /** 当前槽位的生成依据；无商品时为 null */
  basis: ContentBasis | null;
  /** 已有内容的槽位 key 集合（商品|平台|形态），用于在下拉里标出「已有内容」 */
  filledSlots: string[];
  /** 模型通道不可用等禁用原因 */
  disabledReason?: string;
}

export function ContentGenerateForm({
  sourceProducts,
  slot,
  slotState,
  basis,
  filledSlots,
  disabledReason,
}: ContentGenerateFormProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [angle, setAngle] = useState<ContentAngle>("selling-point");

  const productId = slot?.productId ?? "";
  const platform = slot?.platform ?? DEFAULT_CONTENT_PLATFORM;
  const format = slot?.format ?? DEFAULT_CONTENT_FORMAT;
  const noProducts = sourceProducts.length === 0;

  /** 保存一份选择结果并让服务端按新槽位重新取数 */
  function navigateTo(next: {
    productId?: string;
    platform?: ContentPlatform;
    format?: ContentFormat;
  }): void {
    const params = new URLSearchParams({
      productId: next.productId ?? productId,
      platform: next.platform ?? platform,
      format: next.format ?? format,
    });
    router.replace(`${pathname}?${params.toString()}`);
  }

  const selected = sourceProducts.find((item) => item.id === productId) ?? null;
  const hasDna = basis?.hasDna ?? false;
  const hasBrand = basis?.hasBrandProfile ?? false;
  const grounded = hasDna || hasBrand;
  const generationBlockedReason = disabledReason ??
    (!noProducts && !grounded ? "先分析这件商品，或建立品牌档案，再生成推广内容" : undefined);
  const filled = new Set(filledSlots);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="content-product">① 选择商品</Label>
          <Select
            id="content-product"
            value={productId}
            disabled={noProducts}
            onChange={(event) => navigateTo({ productId: event.target.value })}
          >
            {noProducts ? <option value="">暂无商品</option> : null}
            {sourceProducts.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
                {product.hasDna ? "（已有商品理解）" : "（未分析）"}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="content-platform">② 选择平台</Label>
          <Select
            id="content-platform"
            value={platform}
            disabled={noProducts}
            onChange={(event) =>
              navigateTo({ platform: event.target.value as ContentPlatform })
            }
          >
            {CONTENT_PLATFORMS.map((item) => (
              <option key={item} value={item}>
                {CONTENT_PLATFORM_LABEL[item]}
                {filled.has(toSlotKey(productId, item, format)) ? "（已有内容）" : ""}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="content-format">内容形态</Label>
          <Select
            id="content-format"
            value={format}
            disabled={noProducts}
            onChange={(event) =>
              navigateTo({ format: event.target.value as ContentFormat })
            }
          >
            {CONTENT_FORMATS.map((item) => (
              <option key={item} value={item}>
                {CONTENT_FORMAT_LABEL[item]}
              </option>
            ))}
          </Select>
        </div>

      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">③ 这次想突出什么？</p>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" role="group" aria-label="选择推广重点">
          {CONTENT_ANGLES.map((item) => (
            <button
              key={item}
              type="button"
              disabled={noProducts}
              aria-pressed={angle === item}
              onClick={() => setAngle(item)}
              className={`rounded-xl border px-3 py-3 text-left transition-colors disabled:opacity-50 ${angle === item ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-100" : "border-white/10 bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]"}`}
            >
              <span className="block text-sm font-semibold">{CONTENT_ANGLE_META[item].label}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{CONTENT_ANGLE_META[item].hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ContentGenerateButton
          slot={slot}
          hasContent={slotState?.content !== null && slotState?.content !== undefined}
          generationStatus={slotState?.generation.status ?? "empty"}
          angle={angle}
          className="min-w-40"
          errorDisplay="inline"
          {...(generationBlockedReason ? { disabledReason: generationBlockedReason } : {})}
        />
        <p className="text-xs text-muted-foreground">先生成草稿，再核对商品事实并发布。</p>
      </div>

      <Separator />

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold text-muted-foreground">
          本次生成的依据
        </span>
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          <BasisItem ok={hasDna}>
            {hasDna ? "已读取商品理解" : "该商品尚未完成分析"}
          </BasisItem>
          <BasisItem ok={hasBrand}>
            {hasBrand ? "已读取品牌档案" : "尚未生成品牌档案"}
          </BasisItem>
          <BasisItem ok={basis?.hasOwnerTwin ?? false}>
            {basis?.hasOwnerTwin ? "已读取老板数字分身语气" : "未建立老板数字分身"}
          </BasisItem>
        </ul>
        <p className="text-[11px] leading-5 text-muted-foreground">
          {noProducts
            ? "还没有任何商品可作为内容依据。请先到商品中心添加商品，再回到这里生成内容。"
            : grounded
              ? `将基于「${selected?.name ?? "当前商品"}」的已有资料生成 ${
                  CONTENT_PLATFORM_LABEL[platform]
                } 的${CONTENT_FORMAT_LABEL[format]}；模型只允许复述已知事实，不得虚构产地、认证、销量等。`
              : "依据不足：该商品尚无商品理解、也没有品牌档案。当前生成会被直接拒绝（不会伪造内容），建议先到商品详情页执行「AI 分析商品」。"}
        </p>
      </div>
    </div>
  );
}

function BasisItem({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1 text-[11px] leading-5 text-muted-foreground">
      {ok ? (
        <CircleCheck className="size-3 shrink-0 text-success" />
      ) : (
        <TriangleAlert className="size-3 shrink-0 text-warning" />
      )}
      {children}
    </li>
  );
}
