/**
 * 品牌档案的共享纯规则
 *
 * 为什么要单独一个文件（与 `agent-task.ts` 同一理由）：
 * Mock 与数据库两套仓储必须表现**完全一致**，否则「切数据源不改页面」这条约定会被破坏。
 * 凡是「不依赖存储介质」的计算（完整度、字段合并、必填兜底）一律放这里，
 * 让两套实现都调用同一份代码，而不是各写一遍、慢慢漂移。
 */

import type { BrandProfile } from "@/types";

import type { NewBrandProfileInput, UpdateBrandProfileInput } from "./types";

/* ------------------------------------------------------------------ */
/* 完整度                                                              */
/* ------------------------------------------------------------------ */

/**
 * 各字段「算作丰满」的参考尺度。
 * 达到该尺度即得满分，超过不额外加分（避免模型堆字刷高完整度）。
 */
const COMPLETENESS_TARGETS = {
  positioning: 24,
  brandStory: 160,
  slogan: 12,
  ipConcept: 60,
  list: 4,
} as const;

/** 把「实际 / 目标」夹取到 0 ~ 1 */
function ratio(actual: number, target: number): number {
  if (target <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, actual / target));
}

/**
 * 品牌完整度（0 ~ 1）—— **纯函数，由档案内容本身推导**。
 *
 * 语义：档案里各字段被填得有多丰满。它**不是**「可信度」（那是 confidence），
 * 也不是「有没有生成」（那是 BrandGenerationState）。
 *
 * 注意：即便 Schema 已强制各字段非空，本函数仍然有意义 ——
 * Schema 保证的是「有内容」，本函数衡量的是「内容够不够用」：
 * 一句 6 个字的品牌故事与一段 200 字的故事，完整度不应相同。
 */
export function computeBrandCompleteness(profile: {
  positioning: string;
  brandStory: string;
  slogan: string;
  ipConcept: string;
  brandValues: readonly string[];
  targetAudience: readonly string[];
  brandPersonality: readonly string[];
  toneOfVoice: readonly string[];
  visualKeywords: readonly string[];
}): number {
  const scores = [
    ratio(profile.positioning.trim().length, COMPLETENESS_TARGETS.positioning),
    ratio(profile.brandStory.trim().length, COMPLETENESS_TARGETS.brandStory),
    ratio(profile.slogan.trim().length, COMPLETENESS_TARGETS.slogan),
    ratio(profile.ipConcept.trim().length, COMPLETENESS_TARGETS.ipConcept),
    ratio(profile.brandValues.length, COMPLETENESS_TARGETS.list),
    ratio(profile.targetAudience.length, COMPLETENESS_TARGETS.list),
    ratio(profile.brandPersonality.length, COMPLETENESS_TARGETS.list),
    ratio(profile.toneOfVoice.length, COMPLETENESS_TARGETS.list),
    ratio(profile.visualKeywords.length, COMPLETENESS_TARGETS.list),
  ];

  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  // 保留两位小数，避免界面上出现 0.7333333333 这种数字
  return Math.round(average * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* 字段合并                                                            */
/* ------------------------------------------------------------------ */

/**
 * 新建入参 → 领域类型。
 * `completeness` 不由调用方提供，一律现算 —— 它是派生量，不允许外部写死。
 */
export function toBrandProfile(
  input: NewBrandProfileInput,
  meta: { updatedAt: string },
): BrandProfile {
  return {
    positioning: input.positioning,
    brandStory: input.brandStory,
    slogan: input.slogan,
    ipConcept: input.ipConcept,
    brandValues: [...input.brandValues],
    targetAudience: [...input.targetAudience],
    brandPersonality: [...input.brandPersonality],
    toneOfVoice: [...input.toneOfVoice],
    visualKeywords: [...input.visualKeywords],
    riskNotes: [...input.riskNotes],
    aiVersion: input.aiVersion,
    confidence: input.confidence,
    approved: input.approved,
    updatedAt: meta.updatedAt,
    completeness: computeBrandCompleteness(input),
  };
}

/**
 * 打补丁：只覆盖显式传入的字段，其余保持不变。
 * 列表字段一律**拷贝**，避免调用方后续改动原数组时意外改到「已保存的档案」。
 */
export function applyBrandProfilePatch(
  current: BrandProfile,
  patch: UpdateBrandProfileInput,
  meta: { updatedAt: string },
): BrandProfile {
  const next: BrandProfile = {
    positioning: patch.positioning ?? current.positioning,
    brandStory: patch.brandStory ?? current.brandStory,
    slogan: patch.slogan ?? current.slogan,
    ipConcept: patch.ipConcept ?? current.ipConcept,
    brandValues: patch.brandValues ? [...patch.brandValues] : [...current.brandValues],
    targetAudience: patch.targetAudience
      ? [...patch.targetAudience]
      : [...current.targetAudience],
    brandPersonality: patch.brandPersonality
      ? [...patch.brandPersonality]
      : [...current.brandPersonality],
    toneOfVoice: patch.toneOfVoice ? [...patch.toneOfVoice] : [...current.toneOfVoice],
    visualKeywords: patch.visualKeywords
      ? [...patch.visualKeywords]
      : [...current.visualKeywords],
    riskNotes: patch.riskNotes ? [...patch.riskNotes] : [...current.riskNotes],
    aiVersion: patch.aiVersion ?? current.aiVersion,
    confidence: patch.confidence ?? current.confidence,
    approved: patch.approved ?? current.approved,
    updatedAt: meta.updatedAt,
    completeness: 0,
  };

  next.completeness = computeBrandCompleteness(next);
  return next;
}
