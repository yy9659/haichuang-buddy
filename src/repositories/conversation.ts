/**
 * 客服会话的共享派生规则（S5）
 *
 * 与 `./agent-task.ts` 同一个理由：Mock 与数据库两套实现**必须给出完全一致的语义**。
 * 会话上有两个字段是派生的，而且都不落库（落库就要在每次追加消息后手动维护，
 * 漏一次列表就显示错）：
 *
 * 1. `unreadCount` —— 「待商家处理」的条数，规则见 `nextUnreadCount`；
 * 2. `lastMessage` / `messageCount` / `updatedAtText` —— 由实现层读取时补全。
 *
 * 时间字段的读取侧规则不在这里：`updatedAtText` 用 `formatRelativeTime`，
 * 那是通用格式化工具，不必再包一层。
 */

import { buildMessagePreview } from "@/lib/knowledge-text";
import type { ChatRole } from "@/types";

export { buildMessagePreview };

/**
 * 计算追加一条消息后的「待商家处理」条数。
 *
 * 语义：**消费者在等一个答复**。因此
 * - 消费者发言 → +1（新增一条待处理）；
 * - AI 回答且不需要转人工 → -1（这条待处理被 AI 消化掉了，最低到 0）；
 * - AI 回答但需要转人工 → 不变（问题还在，只是换人处理）；
 * - 系统消息 → 不变（它不是一次往来）。
 *
 * 为什么不用「未读」而用「待处理」：这里根本没有已读回执，
 * 编一个「已读」状态只会让商家以为自己在处理一个不存在的队列。
 * 界面上那个数字角标回答的是「还有几条需要人管」，这与本规则一致。
 */
export function nextUnreadCount(params: {
  current: number;
  role: ChatRole;
  needsHuman: boolean;
}): number {
  const current = Number.isFinite(params.current) ? Math.max(0, params.current) : 0;
  if (params.role === "customer") {
    return current + 1;
  }
  if (params.role === "agent" && !params.needsHuman) {
    return Math.max(0, current - 1);
  }
  return current;
}

/**
 * 会话列表右栏的状态文案所需的字段：`messageCount` 与 `lastMessage`。
 * 这里只做「最后一条」的取用与截断，排序由实现层保证。
 */
export function deriveConversationPreview(
  messages: readonly { role: ChatRole; content: string }[],
): { lastMessage: string; messageCount: number } {
  const last = messages[messages.length - 1];
  return {
    lastMessage: last ? buildMessagePreview(last.content) : "",
    messageCount: messages.length,
  };
}
