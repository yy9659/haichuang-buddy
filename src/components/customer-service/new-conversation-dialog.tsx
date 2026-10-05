"use client";

/**
 * 新建模拟消费者会话（客户端组件 · 任务书第十九 / 三十八节）
 *
 * 第一版不接真实微信 / 抖音，因此这里就是**唯一的消费者入口**。
 * 提供几个预置的模拟消费者（可改名字、可加标签），也可以手填。
 *
 * 一个刻意的取舍：**不预置开场白**。
 * 新建出来的会话是空的，第一句必须由用户输入、必须真的走一遍
 * 检索 + 生成 + 引用校验。如果这里顺手写一条「您好，请问有什么可以帮您」，
 * 演示时页面上就有字了 —— 而「RAG 到底通了没有」会因此变得看不出来。
 */

import { useRouter } from "next/navigation";
import { Loader2, MessageSquarePlus, Plus } from "lucide-react";
import * as React from "react";

import { createConversationAction } from "@/actions/customer-service";
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
import type { AppErrorShape } from "@/lib/result";

/** 预置的模拟消费者（任务书第十九节的三位 + 一位老客） */
const PRESET_CONSUMERS = [
  { name: "王女士", label: "抖音 · 新客" },
  { name: "陈先生", label: "视频号 · 老客" },
  { name: "林小姐", label: "微信 · 新客" },
  { name: "郑先生", label: "门店 · 老客" },
] as const;

interface NewConversationDialogProps {
  productOptions: Array<{ id: string; name: string }>;
}

export function NewConversationDialog({ productOptions }: NewConversationDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<AppErrorShape | null>(null);

  const [presetIndex, setPresetIndex] = React.useState("");
  const [name, setName] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [productId, setProductId] = React.useState("");

  function reset(): void {
    setPresetIndex("");
    setName("");
    setLabel("");
    setProductId("");
    setError(null);
  }

  function applyPreset(index: string): void {
    setPresetIndex(index);
    const preset = PRESET_CONSUMERS[Number(index)];
    if (preset) {
      setName(preset.name);
      setLabel(preset.label);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const customerName = name.trim();
    if (customerName.length === 0) {
      setError({
        code: "VALIDATION_FAILED",
        message: "请填写客户名称",
        retryable: false,
      });
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await createConversationAction({
        customerName,
        ...(label.trim() ? { customerLabel: label.trim() } : {}),
        productId: productId || null,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setOpen(false);
      reset();
      /**
       * 直接跳到新会话。
       *
       * 用 `push` 而不是 `refresh`：新会话在列表顶部，得让用户看到它被选中，
       * 否则「点了新建什么都没发生」的错觉会让人再点一次，于是多出一个空会话。
       */
      router.push(`/customer-service?conv=${encodeURIComponent(result.data.id)}`);
      router.refresh();
    });
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <MessageSquarePlus />
        新建模拟会话
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            reset();
          }
        }}
      >
        <DialogContent className="max-w-md">
          <form onSubmit={handleSubmit} className="flex flex-col">
            <DialogHeader>
              <DialogTitle>新建模拟会话</DialogTitle>
              <DialogDescription>
                第一版不接真实平台消息，用模拟消费者验证完整链路。
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="conv-preset">① 选择模拟消费者</Label>
                <Select
                  id="conv-preset"
                  value={presetIndex}
                  onChange={(event) => applyPreset(event.target.value)}
                >
                  <option value="">自定义（手动填写）</option>
                  {PRESET_CONSUMERS.map((consumer, index) => (
                    <option key={consumer.name} value={String(index)}>
                      {consumer.name}（{consumer.label}）
                    </option>
                  ))}
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="conv-name">② 客户名称</Label>
                <Input
                  id="conv-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：王女士"
                  maxLength={32}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="conv-label">客户标签（可选）</Label>
                <Input
                  id="conv-label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="例如：抖音 · 新客"
                  maxLength={32}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="conv-product">关联商品（可选）</Label>
                <Select
                  id="conv-product"
                  value={productId}
                  onChange={(event) => setProductId(event.target.value)}
                >
                  <option value="">不指定（全店级咨询，如物流 / 售后）</option>
                  {productOptions.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                    </option>
                  ))}
                </Select>
                <p className="text-[10px] leading-4 text-muted-foreground">
                  指定商品后，检索会优先在该商品的知识范围内进行。
                </p>
              </div>

              {error ? (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/20 bg-destructive/8 px-2.5 py-2 text-[11px] leading-4 text-destructive"
                >
                  {error.message}
                </p>
              ) : null}
            </DialogBody>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={isPending}
              >
                取消
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? <Loader2 className="animate-spin" /> : <Plus />}
                创建会话
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
