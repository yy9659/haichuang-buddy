/**
 * Product DNA —— Product Agent 的结构化输出契约（技术文档 9.2 / 17.1）
 *
 * 设计原则（与「AI 输出一律不可信」的开发纪律一致）：
 * 1. **所有 AI 输出必须经过本 Schema 校验**，校验失败由调用层回喂一次纠错，
 *    仍失败则返回 `SCHEMA_INVALID`，绝不把半成品写进数据库。
 * 2. **对格式宽容、对字段缺失严格**：
 *    - 宽容：列表允许模型写成 `"卖点一；卖点二"` 这种分隔符字符串，confidence 允许 `"85%"`。
 *    - 严格：关键字段缺失或为空数组时**必须失败**，从而触发纠错重试，
 *      而不是静默补一个空数组让脏结果蒙混过关。
 * 3. **命名与本文件即模型契约**：这里刻意使用下划线无关的英文小驼峰，
 *    与领域类型 / 数据库列名的对应关系集中在 `toNewProductDnaInput()` 一处转换，
 *    这样即便以后数据库改列名，也不会波及提示词与模型契约。
 */

import { z } from "zod";

import {
  confidenceSchema,
  dedupeStrings,
  textField,
  textListField,
} from "@/ai/schemas/field-rules";
import { formatDateTime } from "@/lib/datetime";
import type { NewProductDnaInput } from "@/repositories/types";
import type { ProductDNA } from "@/types";

/** Product DNA 的 AI 契约版本号。模型或提示词发生不兼容变更时必须递增 */
export const PRODUCT_DNA_AI_VERSION = "v1.0";

/** 单个列表字段的条数上限，防止模型灌入超长内容 */
const MAX_LIST_ITEMS = 8;
/** 单条文案的字数上限 */
const MAX_ITEM_LENGTH = 160;

/**
 * 列表字段：至少 minItems 条、最多 MAX_LIST_ITEMS 条、单条不超过 MAX_ITEM_LENGTH 字。
 * 归一化与报错文案的规则见 `field-rules.ts`（三份 Agent Schema 共用同一份实现）。
 * `minItems = 0` 仅用于「没有内容是合法结论」的字段（风险提示）。
 */
function textList(label: string, minItems = 1) {
  return textListField(label, {
    maxItemLength: MAX_ITEM_LENGTH,
    maxItems: MAX_LIST_ITEMS,
    minItems,
  });
}

/** Product DNA 的 AI 输出契约（字段名即提示词中要求模型返回的键名） */
export const ProductDNASchema = z.object({
  /** 商品分类，如「海产品」 */
  category: textField("商品分类", 30),
  /** 子类目，如「鲍鱼」 */
  subcategory: textField("子类目", 40),
  /** 视觉特征：图片里能看到的颜色、形态、包装等 */
  visualFeatures: textList("视觉特征"),
  /** 核心特征：产品本身的客观属性 */
  coreFeatures: textList("核心特征"),
  /** 核心卖点 */
  sellingPoints: textList("核心卖点"),
  /** 目标用户画像 */
  targetUsers: textList("目标用户"),
  /** 消费场景 */
  scenarios: textList("消费场景"),
  /** 用户痛点 */
  painPoints: textList("用户痛点"),
  /** 营销角度（内容选题方向） */
  marketingAngles: textList("营销角度"),
  /** 风险提示：合规、夸大宣传、储运风险等；允许为空数组 */
  riskNotes: textList("风险提示", 0),
  /** 置信度 0 ~ 1 */
  confidence: confidenceSchema,
});

/** 模型输出的原始结构（仅 AI 能给出的字段，不含落库元数据） */
export type ProductDNADraft = z.infer<typeof ProductDNASchema>;

/** 字段 → 中文标签，用于纠错提示与界面展示 */
export const PRODUCT_DNA_FIELD_LABELS: Readonly<
  Record<keyof ProductDNADraft, string>
> = {
  category: "商品分类",
  subcategory: "子类目",
  visualFeatures: "视觉特征",
  coreFeatures: "核心特征",
  sellingPoints: "核心卖点",
  targetUsers: "目标用户",
  scenarios: "消费场景",
  painPoints: "用户痛点",
  marketingAngles: "营销角度",
  riskNotes: "风险提示",
  confidence: "置信度",
};

/**
 * 校验通过后的第二步清理：去重、限长。
 * 放在 Schema 之外，是因为「去重」属于业务归一而不是格式校验，
 * 不应影响 Schema 判定结果（否则同一份输出会因去重前后校验不一致而抖动）。
 */
export function normalizeProductDnaDraft(
  draft: ProductDNADraft,
): ProductDNADraft {
  const cleanList = (items: readonly string[]): string[] =>
    dedupeStrings(items).map((item) => item.slice(0, MAX_ITEM_LENGTH));

  return {
    category: draft.category.trim(),
    subcategory: draft.subcategory.trim(),
    visualFeatures: cleanList(draft.visualFeatures),
    coreFeatures: cleanList(draft.coreFeatures),
    sellingPoints: cleanList(draft.sellingPoints),
    targetUsers: cleanList(draft.targetUsers),
    scenarios: cleanList(draft.scenarios),
    painPoints: cleanList(draft.painPoints),
    marketingAngles: cleanList(draft.marketingAngles),
    riskNotes: cleanList(draft.riskNotes),
    confidence: draft.confidence,
  };
}

/**
 * AI 契约 → 仓储输入。
 * 这里是**唯一**的字段改名点：
 * `subcategory → subCategory`、`scenarios → consumptionScenarios`、`painPoints → userPainPoints`。
 */
export function toNewProductDnaInput(
  draft: ProductDNADraft,
  productId: string,
): NewProductDnaInput {
  return {
    productId,
    category: draft.category,
    subCategory: draft.subcategory,
    visualFeatures: [...draft.visualFeatures],
    coreFeatures: [...draft.coreFeatures],
    sellingPoints: [...draft.sellingPoints],
    targetUsers: [...draft.targetUsers],
    consumptionScenarios: [...draft.scenarios],
    userPainPoints: [...draft.painPoints],
    marketingAngles: [...draft.marketingAngles],
    riskNotes: [...draft.riskNotes],
    aiVersion: PRODUCT_DNA_AI_VERSION,
    confidence: draft.confidence,
    /** AI 产出默认未确认，必须由商家确认后才对外使用（文档 5.4 人拥有最终决策权） */
    approved: false,
  };
}

/**
 * AI 契约 → 领域类型 `ProductDNA`。
 * 补齐 AI 无法产生的元数据字段。
 */
export function toProductDna(
  draft: ProductDNADraft,
  productId: string,
  generatedAt: string = formatDateTime(new Date()),
): ProductDNA {
  const input = toNewProductDnaInput(draft, productId);
  return {
    productId: input.productId,
    category: input.category,
    subCategory: input.subCategory,
    visualFeatures: input.visualFeatures,
    coreFeatures: input.coreFeatures,
    sellingPoints: input.sellingPoints,
    targetUsers: input.targetUsers,
    consumptionScenarios: input.consumptionScenarios,
    userPainPoints: input.userPainPoints,
    marketingAngles: input.marketingAngles,
    riskNotes: input.riskNotes,
    aiVersion: input.aiVersion,
    confidence: input.confidence,
    generatedAt,
    approved: input.approved,
  };
}
