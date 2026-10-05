/**
 * 直播热点聚合单测（S6 · 任务书第二十八节）
 *
 * 这组用例盯住两件事：
 * 1. **计数与占比由程序算**，且占比恒等于 count / 已分析总数（绝不由模型给数字）；
 * 2. **只统计已被 AI 分类的评论** —— 种子历史评论 intent 为 null，
 *    把它们算进占比会让热点看起来比实际更满。
 */

import { describe, expect, it } from "vitest";

import { MAX_HOT_TOPIC_EXAMPLES, aggregateLiveHotTopics } from "@/lib/live-topics";
import type { LiveComment, LiveIntent } from "@/types";

let seq = 0;

function comment(
  content: string,
  intent: LiveIntent | null,
  priority: LiveComment["priority"] = null,
): LiveComment {
  seq += 1;
  return {
    id: `c_${seq}`,
    sessionId: "live_001",
    authorName: `观众${seq}`,
    content,
    intent,
    priority,
    handled: intent !== null,
    createdAtText: "19:30",
  };
}

describe("aggregateLiveHotTopics", () => {
  it("空输入返回空数组（不是一堆 0 占位）", () => {
    expect(aggregateLiveHotTopics([])).toEqual([]);
  });

  it("只有未经 AI 分析的评论时返回空数组", () => {
    const comments = [comment("怎么保存？", null), comment("明天能到吗", null)];
    expect(aggregateLiveHotTopics(comments)).toEqual([]);
  });

  it("占比由程序计算，且恒等于 count / 已分析总数", () => {
    const comments = [
      comment("怎么保存", "storage_question"),
      comment("能放几天", "storage_question"),
      comment("明天能到吗", "logistics_question"),
      comment("有点贵", "objection"),
      // 未分析：不计入分母
      comment("在吗", null),
    ];

    const topics = aggregateLiveHotTopics(comments);
    const total = 4;

    for (const topic of topics) {
      expect(topic.share).toBeCloseTo(topic.count / total, 10);
    }
    const sum = topics.reduce((acc, topic) => acc + topic.count, 0);
    expect(sum).toBe(total);
  });

  it("按条数降序排列；同分时保持首次出现顺序（结果稳定）", () => {
    const comments = [
      comment("a1", "objection"),
      comment("b1", "logistics_question"),
      comment("a2", "objection"),
      comment("c1", "praise"),
      comment("b2", "logistics_question"),
    ];

    const topics = aggregateLiveHotTopics(comments);
    expect(topics.map((topic) => topic.intent)).toEqual([
      "objection",
      "logistics_question",
      "praise",
    ]);
    expect(topics[0]?.count).toBe(2);
    expect(topics[2]?.count).toBe(1);
  });

  it("示例最多三条，且取最近的评论（时间倒序）", () => {
    const comments = Array.from({ length: 5 }, (_, index) =>
      comment(`问题 ${index + 1}`, "storage_question"),
    );

    const [topic] = aggregateLiveHotTopics(comments);
    expect(topic?.count).toBe(5);
    expect(topic?.recentExamples).toHaveLength(MAX_HOT_TOPIC_EXAMPLES);
    // 最近的三条（问题 5 / 4 / 3），且最新的排在最前
    expect(topic?.recentExamples).toEqual(["问题 5", "问题 4", "问题 3"]);
  });

  it("单一意图独占总比时 share 为 1", () => {
    const topics = aggregateLiveHotTopics([
      comment("怎么买", "purchase_intent"),
      comment("有货吗", "purchase_intent"),
    ]);
    expect(topics).toHaveLength(1);
    expect(topics[0]?.share).toBe(1);
  });
});
