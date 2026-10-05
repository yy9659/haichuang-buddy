"use client";

/**
 * 会话操作条（客户端组件）：转人工 / 结束会话
 *
 * 两个动作的语义必须分清（任务书第三十六节）：
 * - **转人工**：AI 仍然可以继续回答这个会话。它只是把状态推进到
 *   `needs_human`，让页面持续显示「存在需要人工确认的问题」。
 *   因此它**不会**禁用输入框 —— 直接禁掉等于把「要不要人工介手」这个
 *   运营决定，变成了「AI 不许再说话」这个技术决定。
 * - **结束会话**：终态。输入框随之禁用（第一版不支持重新打开）。
 *
 * 结束会话带一次确认：这个动作不可逆，而它就在输入框旁边，很容易误点。
 */

import { useRouter } from "next/navigation";
import { CircleCheck, Headset, Loader2, XCircle } from "lucide-react";
import * as React from "react";

import {
  closeConversationAction,
  handoffConversationAction,
} from "@/actions/customer-service";
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
import type { AppErrorShape, Result } from "@/lib/result";
import type { CustomerConversation } from "@/types";

interface ConversationToolbarProps {
  conversation: CustomerConversation;
}

export function ConversationToolbar({ conversation }: ConversationToolbarProps) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [error, setError] = React.useState<AppErrorShape | null>(null);

  const closed = conversation.status === "closed";
  const handoff = conversation.status === "human";

  function run(action: () => Promise<Result<unknown>>): void {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
      }
      setConfirmOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      {error ? (
        <span role="alert" className="text-[10px] text-destructive">
          {error.message}
        </span>
      ) : null}

      <Button
        type="button"
        size="sm"
        variant={handoff ? "secondary" : "outline"}
        disabled={isPending || closed || handoff}
        onClick={() => run(() => handoffConversationAction(conversation.id))}
        title={
          handoff
            ? "该会话已标记为需要人工确认"
            : "标记为需要人工确认；AI 仍可继续回答"
        }
      >
        {isPending ? <Loader2 className="animate-spin" /> : <Headset />}
        {handoff ? "已待人工" : "转人工"}
      </Button>

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending || closed}
        onClick={() => setConfirmOpen(true)}
        title="结束本次会话，结束后不再接收该会话的新消息"
      >
        <XCircle />
        结束会话
      </Button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>结束会话</DialogTitle>
            <DialogDescription>
              将结束与「{conversation.customerName}」的这次会话。
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-[12px] leading-5 text-muted-foreground">
              结束后该会话不再接收新消息（第一版不支持重新打开）。
              <span className="mt-1.5 block">
                会话记录、消息与引用依据都会被保留，随时可以回看。
              </span>
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={isPending}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={isPending}
              onClick={() => run(() => closeConversationAction(conversation.id))}
            >
              {isPending ? <Loader2 className="animate-spin" /> : <CircleCheck />}
              确认结束
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
