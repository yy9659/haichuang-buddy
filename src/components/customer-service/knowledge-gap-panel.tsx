"use client";

/**
 * 知识缺口面板（客户端组件 · 任务书第二十三 / 二十四 / 二十五节）
 *
 * 这是整个 RAG 闭环的**收口处**：
 *
 *   客服答不上来 → 自动记一条缺口（聚合计数）→ 商家在这里补一份知识
 *   → 索引成功 → 缺口标记已解决 → 再问同一个问题就能答上来
 *
 * 三处刻意的措辞（任务书第二十五节）：
 *
 * 1. 成功提示说「**知识库已更新**，后续回答将优先检索该内容」，
 *    不说「AI 已经学会了」—— 后者暗示 AI 产生了记忆，而事实是
 *    检索库里多了一份材料。措辞上的这点差别，决定了商家对系统的预期是否正确。
 * 2. 知识建立成功但缺口状态更新失败时，如实说「知识已建立，但缺口状态更新失败，
 *    可稍后重新标记解决」。**不显示成功** —— 那条缺口仍然是 open，
 *    商家以为关掉了就不会再看它了（Task 79 的 `knowledge_gap_resolve_failed`）。
 * 3. 索引失败时缺口保持 open，界面上不出现任何「已解决」的字样。
 *
 * 面板只展示**未解决**的缺口（`open`）。已解决与已忽略的留在数据里供追溯，
 * 但堆在面板上只会让真正需要处理的那些被淹没。
 */

import { useRouter } from "next/navigation";
import { BookPlus, Loader2, TriangleAlert } from "lucide-react";
import * as React from "react";

import { resolveKnowledgeGapWithDocumentAction } from "@/actions/customer-service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { AppErrorShape } from "@/lib/result";
import { CUSTOMER_INTENT_LABEL, KNOWLEDGE_TYPE_LABEL } from "@/lib/status-meta";
import {
  isCustomerIntent,
  KNOWLEDGE_DOCUMENT_TYPES,
  type KnowledgeDocumentType,
  type KnowledgeGapRecord,
} from "@/types";

interface KnowledgeGapPanelProps {
  gaps: KnowledgeGapRecord[];
}

/**
 * 缺口意图 → 建议的知识类型。
 *
 * 只是**默认值**，商家可以改。给它的理由是：物流问题默认落到「物流政策」，
 * 比让商家每次都从 8 个类型里挑一次要顺手，而且能减少
 * 「把物流说明挂成『商品说明』」这类会削弱检索精度的误分类。
 */
const SUGGESTED_TYPE_BY_INTENT: Partial<Record<string, KnowledgeDocumentType>> = {
  logistics: "logistics",
  after_sales: "after_sales",
  storage: "storage",
  cooking: "cooking",
  product: "product",
  price: "faq",
};

export function KnowledgeGapPanel({ gaps }: KnowledgeGapPanelProps) {
  const router = useRouter();
  const [active, setActive] = React.useState<KnowledgeGapRecord | null>(null);
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<AppErrorShape | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<KnowledgeDocumentType>("faq");
  const [content, setContent] = React.useState("");

  const openGaps = gaps.filter((gap) => gap.status === "open");

  function openDialog(gap: KnowledgeGapRecord): void {
    const suggested = SUGGESTED_TYPE_BY_INTENT[gap.intent] ?? "faq";
    setName(`《${gap.question}》补充说明`);
    setType(suggested);
    setContent("");
    setError(null);
    setNotice(null);
    setActive(gap);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const gap = active;
    if (!gap) {
      return;
    }

    const trimmedName = name.trim();
    const trimmedContent = content.trim();
    if (trimmedName.length === 0) {
      setError({ code: "VALIDATION_FAILED", message: "请填写知识名称", retryable: false });
      return;
    }
    if (trimmedContent.length === 0) {
      setError({ code: "VALIDATION_FAILED", message: "请填写知识正文", retryable: false });
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await resolveKnowledgeGapWithDocumentAction({
        gapId: gap.id,
        name: trimmedName,
        type,
        content: trimmedContent,
        // 缺口上带着商品归属时沿用，补出来的知识才会挂在同一个商品上
        productId: gap.productId,
      });

      if (!result.ok) {
        // 索引 / 建库失败：缺口仍是 open，界面不出现任何成功的字眼
        setError(result.error);
        return;
      }

      setActive(null);

      /**
       * 缺口状态标记失败（但知识已建成）—— 如实说明，**不报成功**。
       * 注意此时是 `ok`：知识确实已经索引成功，只是状态没跟上。
       */
      if (result.data.warningCodes.includes("knowledge_gap_resolve_failed")) {
        setNotice(
          "知识已建立并完成索引，但该知识缺口的状态更新失败，可稍后重新标记解决。",
        );
      } else {
        setNotice("知识已补充并完成索引。该知识缺口已标记为已解决。");
      }

      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-warning/25 bg-warning/12 p-3.5">
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-3.5 text-warning" />
        <span className="text-[12px] font-semibold text-warning">知识缺口提醒</span>
        <Badge variant="warning" className="ml-auto">
          {openGaps.length} 项
        </Badge>
      </div>

      {notice ? (
        <p className="mt-2 rounded-lg border border-success/20 bg-success/10 px-2.5 py-1.5 text-[11px] leading-4 text-success">
          {notice}
        </p>
      ) : null}

      {openGaps.length === 0 ? (
        <p className="mt-2.5 text-[11px] leading-4 text-warning/80">
          当前没有被问住的问题。AI 答不上来的提问会自动聚合到这里。
        </p>
      ) : (
        <ul className="mt-2.5 flex flex-col gap-2.5">
          {openGaps.map((gap) => (
            <li key={gap.id} className="flex flex-col gap-1">
              <span className="text-[12px] leading-5 font-medium text-warning">
                {gap.question}
              </span>
              <span className="flex flex-wrap items-center gap-1 text-[10px] text-warning/80">
                <span>被询问 {gap.occurrenceCount} 次</span>
                <span>·</span>
                <span>
                  {isCustomerIntent(gap.intent)
                    ? CUSTOMER_INTENT_LABEL[gap.intent]
                    : "其他问题"}
                </span>
                <span>·</span>
                <span>最近 {gap.lastSeenAt}</span>
              </span>
              {gap.reason.length > 0 ? (
                <span className="text-[10px] leading-4 text-warning/80">
                  {gap.reason}
                </span>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-0.5 self-start"
                onClick={() => openDialog(gap)}
              >
                <BookPlus />
                补充知识
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={active !== null}
        onOpenChange={(next) => {
          if (!next) {
            setActive(null);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>补充知识 · 解决知识缺口</DialogTitle>
              <DialogDescription>
                针对「{active?.question}」建立一份知识。
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="flex min-h-0 flex-col gap-3 overflow-y-auto">
              <div className="rounded-lg border border-border bg-muted/50 px-2.5 py-2">
                <p className="text-[11px] leading-4 text-muted-foreground">
                  消费者已经问过 {active?.occurrenceCount ?? 0} 次。补的内容会立刻进入知识库，
                  下一次同样的问题就会被检索到。
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="gap-name">知识名称</Label>
                <Input
                  id="gap-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：连江海创物流说明"
                  maxLength={64}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="gap-type">知识类型</Label>
                <Select
                  id="gap-type"
                  value={type}
                  onChange={(event) =>
                    setType(event.target.value as KnowledgeDocumentType)
                  }
                >
                  {KNOWLEDGE_DOCUMENT_TYPES.map((item) => (
                    <option key={item} value={item}>
                      {KNOWLEDGE_TYPE_LABEL[item]}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="gap-content">知识正文</Label>
                <Textarea
                  id="gap-content"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  rows={7}
                  className="min-h-[140px]"
                  placeholder="例如：每天 16:00 前的订单当日发出，福建省内次日达，省外 2–3 天。冷链全程 0–4℃。"
                />
                <p className="text-[10px] leading-4 text-muted-foreground">
                  写清楚具体的数字与范围。AI 只会照这里写的回答，不会替商家做任何承诺。
                </p>
              </div>

              {error ? (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/20 bg-destructive/8 px-2.5 py-2 text-[11px] leading-4 text-destructive"
                >
                  {error.message}
                  {error.detail ? `（${error.detail}）` : ""}
                </p>
              ) : null}
            </DialogBody>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setActive(null)}
                disabled={isPending}
              >
                取消
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? <Loader2 className="animate-spin" /> : <BookPlus />}
                补知识并解决缺口
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
