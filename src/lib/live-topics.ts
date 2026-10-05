/**
 * 直播热点聚合（S6 · 任务书第二十八节）
 *
 * 纯函数 + 程序计算，**绝不让模型算百分比**：
 * 「储存咨询 8 条占 40%」这种数字一旦交给模型，就会出现
 * 「8 / 20 = 45%」这类看起来对、算不对的结论，而界面把它当成事实展示。
 * 计数与占比是确定性工作，交给确定性代码。
 *
 * 只统计**已被 AI 分类**的评论（`intent !== null`）：种子历史评论没有被分析过，
 * 把它们算进占比会让「热点」看起来比实际更满，且类别是凭空猜的。
 * 它们的条数仍然体现在 `realMetrics.commentCount` 里（那是真实评论数）。
 */

import type { LiveComment, LiveHotTopic, LiveIntent } from "@/types";

/** 每个热点保留的示例条数上限 */
export const MAX_HOT_TOPIC_EXAMPLES = 3;

/**
 * 按意图聚合当前会话的评论。
 *
 * 排序：条数降序 → 意图出现顺序（保证同分时结果稳定，便于快照与测试）。
 * 空输入返回空数组（不是返回全 0 的一堆占位）。
 */
export function aggregateLiveHotTopics(
  comments: readonly LiveComment[],
): LiveHotTopic[] {
  const analyzed = comments.filter(
    (comment): comment is LiveComment & { intent: LiveIntent } =>
      comment.intent !== null,
  );

  if (analyzed.length === 0) {
    return [];
  }

  /** 保持首次出现顺序，用于同分时的稳定排序 */
  const order: LiveIntent[] = [];
  const buckets = new Map<LiveIntent, LiveComment[]>();

  for (const comment of analyzed) {
    const intent = comment.intent;
    let bucket = buckets.get(intent);
    if (!bucket) {
      bucket = [];
      buckets.set(intent, bucket);
      order.push(intent);
    }
    bucket.push(comment);
  }

  const total = analyzed.length;

  return order
    .map((intent) => {
      const items = buckets.get(intent) ?? [];
      return {
        intent,
        count: items.length,
        share: items.length / total,
        // 最近的几条示例（评论按时间正序，取末尾几条再翻回时间倒序）
        recentExamples: items
          .slice(-MAX_HOT_TOPIC_EXAMPLES)
          .reverse()
          .map((comment) => comment.content),
      } satisfies LiveHotTopic;
    })
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return order.indexOf(left.intent) - order.indexOf(right.intent);
    });
}
