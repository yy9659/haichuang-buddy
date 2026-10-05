"use client";

/**
 * 直播间开关（客户端组件）
 *
 * 职责单一：**开始 / 结束一场模拟直播**。真实推流不在本轮范围内，
 * 按钮上的措辞也如实写「模拟直播」，不假装接了直播平台。
 *
 * 三条与任务书对应的小规定：
 *
 * 1. **请求飞行期间禁用**（第三十五节）。连点两次「开始直播」会建出两场
 *    并行场次 —— 与客服「重复发送」是同一类问题，这里同样在客户端先兜住。
 * 2. **切换商品创建新场次**。当前场次的商品不被改写，旧建议与新商品不会串在一起。
 * 3. **失败不吞**（第十二节）。`!ok` 时把服务端返回的中文提示原样显示。
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert, Loader2, Radio, Square } from "lucide-react";
import * as React from "react";

import { endLiveSessionAction, startLiveSessionAction } from "@/actions/live";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { LiveProductOption } from "@/services/live";
import type { AppErrorShape } from "@/lib/result";
import type { LiveSession } from "@/types";

interface LiveSessionControlsProps {
  session: LiveSession | null;
  products: LiveProductOption[];
}

export function LiveSessionControls({ session, products }: LiveSessionControlsProps) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<AppErrorShape | null>(null);
  const [productId, setProductId] = React.useState(
    session?.productId ?? products[0]?.id ?? "",
  );

  const selectedProductId = products.some((product) => product.id === productId)
    ? productId
    : products.find((product) => product.id === session?.productId)?.id ?? products[0]?.id ?? "";
  const active = session?.status === "live";
  const switching = active && selectedProductId !== session.productId;
  const canStart = !isPending && selectedProductId.length > 0 && (!active || switching);

  function handleStart(): void {
    if (!canStart) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await startLiveSessionAction({ productId: selectedProductId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleEnd(): void {
    if (!session || isPending) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await endLiveSessionAction(session.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      {error ? (
        <span
          role="alert"
          className="inline-flex items-center gap-1 rounded-lg border border-destructive/20 bg-destructive/8 px-2 py-1 text-[11px] text-destructive"
        >
          <CircleAlert className="size-3" />
          {error.message}
        </span>
      ) : null}

      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        彩排商品
        <Select
          value={selectedProductId}
          onChange={(event) => setProductId(event.target.value)}
          disabled={isPending || products.length === 0}
          aria-label="选择彩排商品"
          className="w-[210px]"
        >
          {products.length === 0 ? (
            <option value="">暂无可用商品</option>
          ) : (
            products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}{product.hasDna ? "（已分析）" : ""}
              </option>
            ))
          )}
        </Select>
      </label>
      {products.length === 0 ? <Link href="/products" className="text-[12px] font-medium text-primary hover:underline">
        先添加商品
      </Link> : null}
      {(!active || switching) && products.length > 0 ? <Button onClick={handleStart} disabled={!canStart}>
        {isPending ? <Loader2 className="animate-spin" /> : <Radio />}
        {switching ? "切换并开始新彩排" : session ? "重新开始彩排" : "开始直播彩排"}
      </Button> : null}
      {active ? <Button variant="outline" onClick={handleEnd} disabled={isPending}>
        {isPending ? <Loader2 className="animate-spin" /> : <Square />}
        结束彩排
      </Button> : null}
    </div>
  );
}
