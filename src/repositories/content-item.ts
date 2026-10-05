/**
 * 内容条目的共享纯规则（S3-2）
 *
 * 为什么要单独一个文件（与 `brand-profile.ts` / `agent-task.ts` 同一理由）：
 * Mock 与数据库两套仓储必须表现**完全一致**，否则「切数据源不改页面」这条约定会被破坏。
 * 凡是「不依赖存储介质」的常量、判定与字段合并一律放这里，
 * 让两套实现都调用同一份代码，而不是各写一遍、慢慢漂移。
 *
 * 注意这里没有「完整度」这类派生量 —— 内容条目不像品牌档案那样能用一个数字概括，
 * 硬造一个「完整度」只会让界面多一个没人看得懂的数字。内容的元信息就是它的字段本身。
 */

import type { ContentItem, ContentMetrics, ContentSlot } from "@/types";

import type { NewContentInput, UpdateContentInput } from "./types";

/**
 * 新生成内容的经营数据基线。
 *
 * 一律为 **0**，且刻意不伪造：内容刚生成还没排期发布，凭空写一个播放量
 * 就是「用假数据让界面好看」。真实数据要等发布回流（S6 Analytics）。
 */
export const EMPTY_CONTENT_METRICS: Readonly<ContentMetrics> = {
  views: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  engagementRate: 0,
};

/** 槽位 → 稳定的字符串键（Mock 实现用 Map 存储时需要） */
export function toContentSlotKey(slot: ContentSlot): string {
  return `${slot.productId}::${slot.platform}::${slot.format}`;
}

/** 判断一条内容是否落在给定槽位上 */
export function matchesContentSlot(item: ContentItem, slot: ContentSlot): boolean {
  return (
    item.productId === slot.productId &&
    item.platform === slot.platform &&
    item.format === slot.format
  );
}

/**
 * 新建入参 → 领域类型。
 * id / 时间戳 / metrics 由存储层决定，因此显式接收元信息而不是在这里生成。
 */
export function toContentItem(
  input: NewContentInput,
  meta: { id: string; createdAt: string; updatedAt: string },
): ContentItem {
  return {
    id: meta.id,
    productId: input.productId,
    productName: input.productName,
    title: input.title,
    hook: input.hook,
    body: input.body,
    cta: input.cta,
    hashtags: [...input.hashtags],
    visualSuggestions: [...input.visualSuggestions],
    shotList: [...input.shotList],
    voiceover: input.voiceover,
    platform: input.platform,
    format: input.format,
    status: input.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    aiVersion: input.aiVersion,
    confidence: input.confidence,
    riskNotes: [...input.riskNotes],
    metrics: { ...EMPTY_CONTENT_METRICS },
  };
}

/**
 * 打补丁：只覆盖显式传入的字段，其余保持不变。
 *
 * 两条不变量：
 * - **槽位（productId / platform / format）与 createdAt 永不被 patch 改写** ——
 *   槽位是内容的身份，创建时间是历史事实；
 * - 列表字段一律**拷贝**，避免调用方后续改动原数组时意外改到「已保存的内容」。
 *
 * `metrics` 刻意不在可 patch 字段里：经营数据来自平台回流，不是让人手填的。
 */
export function applyContentPatch(
  current: ContentItem,
  patch: UpdateContentInput,
  meta: { updatedAt: string },
): ContentItem {
  return {
    ...current,
    productName: patch.productName ?? current.productName,
    title: patch.title ?? current.title,
    hook: patch.hook ?? current.hook,
    body: patch.body ?? current.body,
    cta: patch.cta ?? current.cta,
    hashtags: patch.hashtags ? [...patch.hashtags] : [...current.hashtags],
    visualSuggestions: patch.visualSuggestions
      ? [...patch.visualSuggestions]
      : [...current.visualSuggestions],
    shotList: patch.shotList ? [...patch.shotList] : [...current.shotList],
    voiceover: patch.voiceover ?? current.voiceover,
    status: patch.status ?? current.status,
    riskNotes: patch.riskNotes ? [...patch.riskNotes] : [...(current.riskNotes ?? [])],
    aiVersion: patch.aiVersion ?? current.aiVersion,
    confidence: patch.confidence ?? current.confidence,
    updatedAt: meta.updatedAt,
  };
}
