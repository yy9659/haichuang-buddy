/**
 * Brand Profile —— Brand Agent 的结构化输出契约（S3-1 / 技术文档 6.3、7、17.1）
 *
 * 输入是 Product DNA + Owner Profile，输出是一份**可被所有内容 Agent 复用的品牌档案**。
 * 与 Product DNA 同一套纪律：
 * 1. **所有 AI 输出必须经过本 Schema 校验**，失败由调用层回喂一次纠错，
 *    仍失败则返回 `SCHEMA_INVALID`，绝不把半成品写进数据库。
 * 2. **对格式宽容、对字段缺失严格**：列表允许模型写成 `"亲切、实在"` 这种分隔符字符串；
 *    但关键字段缺失必须失败，从而触发纠错，而不是静默补空数组。
 * 3. **命名即模型契约**：字段名与提示词中要求模型返回的键名严格一致；
 *    与领域类型 / 数据库列名的改名集中在 `toNewBrandProfileInput()` **一处**，
 *    这样以后改列名不会波及提示词。
 *
 * 关于字段集合（与任务书 Task 1 的对应关系）：
 * 任务书要求 brandPositioning / brandStory / brandValues / targetAudience /
 * brandKeywords / tone / visualDirection 七个字段，本文件**全部照做**。
 * 另外补充 3 个字段，原因如下（不是随手加）：
 * - `slogan`：品牌中心首屏必须展示品牌主张，缺了它页面只能留空；
 * - `ipConcept`：品牌故事卡片的固定组成，内容 Agent 依赖它做 IP 内容；
 * - `confidence`：与 Product DNA 保持一致，让界面能区分「模型有多大把握」。
 * 这三项都写进了系统提示词的硬性规则，并纳入必填校验，不存在「模型可以随便不返回」的情况。
 */

import { z } from "zod";

import {
  confidenceSchema,
  dedupeStrings,
  textField,
  textListField,
} from "@/ai/schemas/field-rules";
import type { NewBrandProfileInput } from "@/repositories/types";
import type { BrandProfile } from "@/types";

/** Brand Profile 的 AI 契约版本号。模型或提示词发生不兼容变更时必须递增 */
export const BRAND_PROFILE_AI_VERSION = "v1.0";

/** 单个列表字段的条数上限，防止模型灌入超长内容 */
const MAX_LIST_ITEMS = 8;
/** 单条词条的字数上限 */
const MAX_ITEM_LENGTH = 40;

/**
 * 关键字列表：至少 minItems 条、最多 MAX_LIST_ITEMS 条、单条不超过 MAX_ITEM_LENGTH 字。
 * 归一化与报错文案的规则见 `field-rules.ts`（三份 Agent Schema 共用同一份实现）。
 * `minItems = 0` 仅用于「没有内容是合法结论」的字段（风险提示）。
 */
function keywordList(label: string, minItems = 1) {
  return textListField(label, {
    maxItemLength: MAX_ITEM_LENGTH,
    maxItems: MAX_LIST_ITEMS,
    minItems,
  });
}

/**
 * Brand Profile 的 AI 输出契约（字段名即提示词中要求模型返回的键名）。
 *
 * 字段名的选择原则：**用品牌策略领域的普通话术**（positioning / tone / visualDirection），
 * 而不是复刻数据库列名（brand_personality / tone_of_voice / visual_keywords）——
 * 让模型面对的是它训练语料里常见的概念，输出质量更稳定。
 */
export const BrandProfileSchema = z.object({
  /** 品牌定位：一句话说清「为谁、提供什么、凭什么是你」 */
  brandPositioning: textField("品牌定位", 120),
  /** 品牌故事：从真实经历出发，不得虚构产地与产品事实 */
  brandStory: textField("品牌故事", 800),
  /** 品牌主张 / Slogan */
  slogan: textField("品牌主张", 60),
  /** IP 概念：以老板或产地为原型的内容 IP 设定 */
  ipConcept: textField("IP 概念", 300),
  /** 品牌价值观 */
  brandValues: keywordList("品牌价值"),
  /** 目标客户画像 */
  targetAudience: keywordList("目标客户"),
  /** 品牌关键词（对应领域字段 brandPersonality） */
  brandKeywords: keywordList("品牌关键词"),
  /** 表达语气（对应领域字段 toneOfVoice） */
  tone: keywordList("表达语气"),
  /** 视觉方向（对应领域字段 visualKeywords） */
  visualDirection: keywordList("视觉方向"),
  /**
   * 合规与事实风险提示。**允许为空数组**（「没发现风险」是合法结论，不逼模型编造），
   * 同时它是 Mock 占位标记的落点，因此必须随档案一起落库。
   */
  riskNotes: keywordList("风险提示", 0),
  /** 置信度 0 ~ 1 */
  confidence: confidenceSchema,
});

/** 模型输出的原始结构（仅 AI 能给出的字段，不含落库元数据） */
export type BrandProfileDraft = z.infer<typeof BrandProfileSchema>;

/** 字段 → 中文标签，用于纠错提示与界面展示 */
export const BRAND_PROFILE_FIELD_LABELS: Readonly<
  Record<keyof BrandProfileDraft, string>
> = {
  brandPositioning: "品牌定位",
  brandStory: "品牌故事",
  slogan: "品牌主张",
  ipConcept: "IP 概念",
  brandValues: "品牌价值",
  targetAudience: "目标客户",
  brandKeywords: "品牌关键词",
  tone: "表达语气",
  visualDirection: "视觉方向",
  riskNotes: "风险提示",
  confidence: "置信度",
};

/**
 * 校验通过后的第二步清理：去重、限长。
 * 放在 Schema 之外，是因为「去重」属于业务归一而不是格式校验，
 * 不应影响 Schema 判定结果（否则同一份输出会因去重前后校验不一致而抖动）。
 */
export function normalizeBrandProfileDraft(
  draft: BrandProfileDraft,
): BrandProfileDraft {
  const cleanList = (items: readonly string[]): string[] =>
    dedupeStrings(items).map((item) => item.slice(0, MAX_ITEM_LENGTH));

  return {
    brandPositioning: draft.brandPositioning.trim(),
    brandStory: draft.brandStory.trim(),
    slogan: draft.slogan.trim(),
    ipConcept: draft.ipConcept.trim(),
    brandValues: cleanList(draft.brandValues),
    targetAudience: cleanList(draft.targetAudience),
    brandKeywords: cleanList(draft.brandKeywords),
    tone: cleanList(draft.tone),
    visualDirection: cleanList(draft.visualDirection),
    riskNotes: cleanList(draft.riskNotes),
    confidence: draft.confidence,
  };
}

/**
 * AI 契约 → 仓储输入。
 * 这里是**唯一**的字段改名点：
 * `brandPositioning → positioning`、`brandKeywords → brandPersonality`、
 * `tone → toneOfVoice`、`visualDirection → visualKeywords`。
 */
export function toNewBrandProfileInput(
  draft: BrandProfileDraft,
  options: { businessId?: string; sourceProductId?: string | null } = {},
): NewBrandProfileInput {
  return {
    ...(options.businessId ? { businessId: options.businessId } : {}),
    positioning: draft.brandPositioning,
    brandStory: draft.brandStory,
    slogan: draft.slogan,
    ipConcept: draft.ipConcept,
    brandValues: [...draft.brandValues],
    targetAudience: [...draft.targetAudience],
    brandPersonality: [...draft.brandKeywords],
    toneOfVoice: [...draft.tone],
    visualKeywords: [...draft.visualDirection],
    riskNotes: [...draft.riskNotes],
    sourceProductId: options.sourceProductId ?? null,
    aiVersion: BRAND_PROFILE_AI_VERSION,
    confidence: draft.confidence,
    /** AI 产出默认未确认，必须由商家确认后才对外使用（文档 5.4 人拥有最终决策权） */
    approved: false,
  };
}

/**
 * AI 契约 → 领域类型 `BrandProfile` 的**展示快照**。
 *
 * 为什么需要它：服务层在落库前要先把「将要写入的档案」组成界面可展示的对象
 * （用于乐观展示、日志与测试断言），而 `completeness` 是派生量，
 * 因此这里显式接收仓储用的同一份计算结果 —— 算法仍只有一个实现
 * （`computeBrandCompleteness`），本函数只做字段搬运。
 */
export function toBrandProfile(
  draft: BrandProfileDraft,
  meta: { updatedAt: string; completeness: number },
): BrandProfile {
  return {
    positioning: draft.brandPositioning,
    brandStory: draft.brandStory,
    slogan: draft.slogan,
    ipConcept: draft.ipConcept,
    brandValues: [...draft.brandValues],
    targetAudience: [...draft.targetAudience],
    brandPersonality: [...draft.brandKeywords],
    toneOfVoice: [...draft.tone],
    visualKeywords: [...draft.visualDirection],
    riskNotes: [...draft.riskNotes],
    aiVersion: BRAND_PROFILE_AI_VERSION,
    confidence: draft.confidence,
    approved: false,
    updatedAt: meta.updatedAt,
    completeness: meta.completeness,
  };
}
