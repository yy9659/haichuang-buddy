"use client";

/**
 * 客服会话的提问输入框（客户端组件）
 *
 * 这是消费者侧唯一的输入口，也是**唯一**会触发 RAG 检索的地方。
 *
 * 三条与任务书对应的小规定：
 *
 * 1. **发送期间禁用**（第三十五节）。不做数据库级幂等 —— 见交付说明；
 *    但按钮在请求飞行期间一定是 disabled 的，正常点击不会产生重复消息。
 * 2. **真实进度，不编百分比**（第三十四节）。检索 + 生成是一段无法观测内部进度的
 *    服务端调用，所以只显示「AI 客服正在检索知识…」。显示一个从 25% 走到 95%
 *    的假进度条，是在用动画掩盖「我不知道还要多久」这件事 ——
 *    用户等 8 秒后会认为它卡住了，而假进度条恰好让他前 6 秒都在安心等待。
 * 3. **失败时不删用户的话**（第十二节）。服务返回 `ok` + `failure` 表示
 *    「消息已保存，AI 这次没答上来」，因此这里**清空输入框 + 显示可重试提示**；
 *    只有 `!ok`（会话已关闭、内容为空）才保留输入内容等待用户处理。
 */

import { useRouter } from "next/navigation";
import { CircleAlert, Loader2, SendHorizonal } from "lucide-react";
import * as React from "react";

import { sendCustomerMessageAction } from "@/actions/customer-service";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AppErrorShape } from "@/lib/result";
import { MAX_CUSTOMER_QUESTION_LENGTH } from "@/types";

interface ChatComposerProps {
  conversationId: string;
  /** 会话已结束时禁用输入 */
  disabled?: boolean;
  disabledReason?: string;
}

export function ChatComposer({
  conversationId,
  disabled = false,
  disabledReason,
}: ChatComposerProps) {
  const router = useRouter();
  const [value, setValue] = React.useState("");
  const [isPending, startTransition] = React.useTransition();
  /** 硬错误：消息**没有**落库（会话已关闭、内容为空、数据库不可用） */
  const [rejected, setRejected] = React.useState<AppErrorShape | null>(null);
  /** 软失败：消息**已经**落库，只是 AI 没能回答 */
  const [aiFailure, setAiFailure] = React.useState<AppErrorShape | null>(null);

  const trimmed = value.trim();
  const tooLong = trimmed.length > MAX_CUSTOMER_QUESTION_LENGTH;
  const canSend = !disabled && !isPending && trimmed.length > 0 && !tooLong;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSend) {
      return;
    }

    const content = trimmed;
    const target = conversationId;
    setRejected(null);
    setAiFailure(null);

    startTransition(async () => {
      const result = await sendCustomerMessageAction({
        conversationId: target,
        content,
      });

      if (!result.ok) {
        // 一个字节都没写进库 —— 保留输入内容，让用户能直接重试或另存
        setRejected(result.error);
        router.refresh();
        return;
      }

      // 消费者消息已落库：清空输入框，避免用户以为没发出去而重复发送
      setValue("");
      if (result.data.failure) {
        setAiFailure(result.data.failure);
      }
      router.refresh();
    });
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
      {disabled ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
          <CircleAlert className="mt-0.5 size-3 shrink-0" />
          {disabledReason ?? "当前会话不可发送消息。"}
        </p>
      ) : null}

      {rejected ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-destructive/20 bg-destructive/8 px-2.5 py-2 text-[11px] leading-4 text-destructive"
        >
          <CircleAlert className="mt-0.5 size-3 shrink-0" />
          <span>{rejected.message}</span>
        </p>
      ) : null}

      {aiFailure ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-warning/25 bg-warning/12 px-2.5 py-2 text-[11px] leading-4 text-warning"
        >
          <CircleAlert className="mt-0.5 size-3 shrink-0" />
          <span>
            消息已送达，但 AI 客服暂时无法回答（{aiFailure.message}）。
            可稍后重新提问，或点击「转人工」。
            {aiFailure.retryable ? " 这是一次可重试的故障。" : ""}
          </span>
        </p>
      ) : null}

      <Textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          /**
           * Enter 发送、Shift+Enter 换行 —— 客服输入框的通用习惯。
           * 用 `isComposing` 排除中文输入法选词时的那次 Enter，
           * 否则每选一个词都会把半句话发出去。
           */
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        disabled={disabled || isPending}
        rows={2}
        maxLength={MAX_CUSTOMER_QUESTION_LENGTH * 2}
        placeholder={
          disabled
            ? "会话已结束，无法继续发送"
            : "输入消费者提问，例如「鲍鱼怎么保存？」（Enter 发送，Shift+Enter 换行）"
        }
        aria-label="消费者提问"
        className="min-h-[64px] resize-none"
      />

      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {isPending ? (
            <span className="inline-flex items-center gap-1.5 text-primary">
              <Loader2 className="size-3 animate-spin" />
              AI 客服正在检索知识…
            </span>
          ) : (
            `${trimmed.length} / ${MAX_CUSTOMER_QUESTION_LENGTH} 字`
          )}
        </span>

        {tooLong ? (
          <span className="text-[10px] text-destructive">
            内容过长，请精简后再发送
          </span>
        ) : null}

        <Button
          type="submit"
          size="sm"
          className="ml-auto"
          disabled={!canSend}
          aria-busy={isPending}
        >
          {isPending ? <Loader2 className="animate-spin" /> : <SendHorizonal />}
          {isPending ? "检索中…" : "发送并回答"}
        </Button>
      </div>
    </form>
  );
}
