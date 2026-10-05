/**
 * Content Asset —— Content Agent 的结构化输出契约（S3-2 / 技术文档 6.4、9.5、17.1）
 *
 * 输入是 Product DNA + Brand Profile，输出是**一条可直接投产的营销内容**。
 * 与 Product DNA / Brand Profile 同一套纪律：
 * 1. **所有 AI 输出必须经过本 Schema 校验**，失败由调用层回喂一次纠错，
 *    仍失败则返回 `SCHEMA_INVALID`，绝不把半成品写进数据库。
 * 2. **对格式宽容、对字段缺失严格**：列表允许模型写成 `"场景一；场景二"` 这种分隔符字符串；
 *    但关键字段缺失必须失败，从而触发纠错，而不是静默补空数组。
 * 3. **命名即模型契约**：字段名与提示词中要求模型返回的键名严格一致；
 *    与领域类型 / 数据库列名的改名集中在 `toNewContentInput()` **一处**。
 *
 * 关于字段集合（与任务书 Task 1 的对应关系）：
 * 任务书要求 platform / type / title / hook / body / scenes / tags / callToAction /
 * visualSuggestions / confidence 十个字段，本文件**全部照做**。
 * 另外补充两个字段，原因如下（不是随手加）：
 * - `voiceover`：内容工厂详情面板有「视频旁白」区块，短视频与口播类内容缺了它只能留空；
 * - `riskNotes`：一是合规扫描的结论要有落点随内容留痕，二是 **Mock 占位标记必须有地方落库**，
 *   否则「这条内容是不是真实模型产出的」在库里无法分辨。
 *
 * 字段名与领域类型的对应（改名只发生在 `toNewContentInput`）：
 * - AI 契约 `type`            → 领域 / 数据库 `format`
 * - AI 契约 `scenes`          → 领域 / 数据库 `shotList`
 * - AI 契约 `tags`            → 领域 / 数据库 `hashtags`
 * - AI 契约 `callToAction`    → 领域 / 数据库 `cta`
 * 保留 AI 契约用「内容运营领域的普通叫法」，是因为模型面对 `type` / `scenes` / `tags`
 * 这类常见概念时输出质量更稳定；数据库用项目既有列名（`format` / `shot_list` / `hashtags`）。
 */

import { z } from "zod";

import {
  confidenceSchema,
  dedupeStrings,
  textField,
  textListField,
} from "@/ai/schemas/field-rules";
import { CONTENT_FORMATS, CONTENT_PLATFORMS } from "@/lib/content-options";
import type { NewContentInput } from "@/repositories/types";
import type { ContentFormat, ContentPlatform } from "@/types";

/** Content Asset 的 AI 契约版本号。模型或提示词发生不兼容变更时必须递增 */
export const CONTENT_AI_VERSION = "v1.0";

/** 列表字段的条数上限，防止模型灌入超长内容 */
const MAX_LIST_ITEMS = 8;
/** 话题标签单条上限（标签本身要短，长了平台也不认） */
const MAX_TAG_LENGTH = 24;
/** 图文配图说明与视频分镜需要写清画面和动作，60 字不足以容纳一条完整场景 */
export const CONTENT_SCENE_MAX_LENGTH = 160;
/** 视觉建议 / 风险提示单条上限（仍保持简洁） */
const MAX_SUGGESTION_LENGTH = 60;
/** 正文上限：小红书长图文的上限量级 */
const MAX_BODY_LENGTH = 1200;

/**
 * 风险词条的字数上限。
 * 与 `riskNotes` 列表项的字段约束一致，供 Agent 拼装「短词条」时裁剪 ——
 * 词表里一次命中五六个产地名时，拼出来的那句话会超出字段上限。
 */
export const CONTENT_RISK_NOTE_MAX_LENGTH = MAX_SUGGESTION_LENGTH;

/**
 * Content Asset 的 AI 输出契约（字段名即提示词中要求模型返回的键名）。
 *
 * 注意 `platform` 与 `type` 也在契约里：模型需要知道自己在为哪个平台、哪种形态写内容，
 * 并要求它把这两个值一并回传（便于发现「答非所问」）。
 * 但**落库时不采信模型的复述** —— 一律以调用方请求为准，见 `alignContentDraftToRequest`。
 *
 * 两个枚举直接引用 `src/lib/content-options.ts` 的清单（与领域类型 `satisfies` 绑定），
 * 这样「AI 契约认哪些平台」与「界面下拉给哪些平台」「映射器接受哪些平台」永远是同一份。
 */
export const ContentAssetSchema = z.object({
  /** 发布平台 */
  platform: z.enum(CONTENT_PLATFORMS),
  /** 内容形态（对应领域字段 format） */
  type: z.enum(CONTENT_FORMATS),
  /** 标题：要么是笔记标题，要么是短视频封面文案 */
  title: textField("标题", 60),
  /** 开场钩子：前 3 秒 / 首屏必须抓住人的那一句 */
  hook: textField("开场钩子", 120),
  /** 正文：完整可发布的内容主体，保留换行 */
  body: textField("正文", MAX_BODY_LENGTH),
  /** 镜头 / 场景脚本（对应领域字段 shotList） */
  scenes: textListField("镜头场景", {
    maxItemLength: CONTENT_SCENE_MAX_LENGTH,
    maxItems: MAX_LIST_ITEMS,
  }),
  /** 话题标签（对应领域字段 hashtags） */
  tags: textListField("话题标签", {
    maxItemLength: MAX_TAG_LENGTH,
    maxItems: MAX_LIST_ITEMS,
  }),
  /** 行动引导 CTA（对应领域字段 cta） */
  callToAction: textField("行动引导", 80),
  /** 视觉建议：画面怎么拍、怎么排版 */
  visualSuggestions: textListField("视觉建议", {
    maxItemLength: MAX_SUGGESTION_LENGTH,
    maxItems: MAX_LIST_ITEMS,
  }),
  /** 口播旁白：短视频 / 口播类内容照着念的那段话 */
  voiceover: textField("口播旁白", 300),
  /**
   * 合规与事实风险提示。**允许为空数组**（「没发现风险」是合法结论，不逼模型编造），
   * 同时它是 Mock 占位标记的落点，因此必须随内容一起落库。
   *
   * null 也归一为空数组：模型被要求「没有就返回空数组」，但实际常写成 null ——
   * 这是「把空写成 null」的格式习惯，不是缺字段，按契约精神在格式层消化掉
   * （空数组与 null 在本字段的语义完全等价）。**缺键（undefined）仍然严格失败**：
   * 键都没返回说明模型没按结构作答，该走纠错，不该静默补空。
   */
  riskNotes: z
    .preprocess(
      (value) => (value === null ? [] : value),
      textListField("风险提示", {
        maxItemLength: MAX_SUGGESTION_LENGTH,
        maxItems: MAX_LIST_ITEMS,
        minItems: 0,
      }),
    ),
  /** 置信度 0 ~ 1 */
  confidence: confidenceSchema,
});

/** 模型输出的原始结构（仅 AI 能给出的字段，不含落库元数据） */
export type ContentAssetDraft = z.infer<typeof ContentAssetSchema>;

/** 字段 → 中文标签，用于纠错提示与界面展示 */
export const CONTENT_FIELD_LABELS: Readonly<
  Record<keyof ContentAssetDraft, string>
> = {
  platform: "发布平台",
  type: "内容形态",
  title: "标题",
  hook: "开场钩子",
  body: "正文",
  scenes: "镜头场景",
  tags: "话题标签",
  callToAction: "行动引导",
  visualSuggestions: "视觉建议",
  voiceover: "口播旁白",
  riskNotes: "风险提示",
  confidence: "置信度",
};

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 话题标签统一成 `#标签` 形式。
 *
 * 为什么必须做：模型有时返回 `#连江鲍鱼`，有时返回 `连江鲍鱼`，有时返回 `##连江鲍鱼`。
 * 三种写法在界面上看起来是三个不同的标签，实际是同一条 —— 不统一就等于脏数据。
 * 顺带去掉标签内部的空白（`#家庭 海鲜` → `#家庭海鲜`），因为平台的话题标签不允许空格。
 */
export function normalizeContentTag(tag: string): string {
  const stripped = tag
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "");
  return stripped ? `#${stripped}` : "";
}

/**
 * 校验通过后的第二步清理：去重、统一标签、限长。
 * 放在 Schema 之外，是因为「去重 / 补 #」属于业务归一而不是格式校验，
 * 不应影响 Schema 判定结果（否则同一份输出会因归一前后校验不一致而抖动）。
 */
export function normalizeContentDraft(
  draft: ContentAssetDraft,
): ContentAssetDraft {
  const cleanList = (items: readonly string[], maxLength: number): string[] =>
    dedupeStrings(items).map((item) => item.slice(0, maxLength));

  const tags = dedupeStrings(
    (draft.tags ?? []).map(normalizeContentTag).filter((tag) => tag.length > 0),
  ).map((tag) => tag.slice(0, MAX_TAG_LENGTH));

  return {
    platform: draft.platform,
    type: draft.type,
    title: draft.title.trim(),
    hook: draft.hook.trim(),
    body: draft.body.trim(),
    scenes: cleanList(draft.scenes, CONTENT_SCENE_MAX_LENGTH),
    tags,
    callToAction: draft.callToAction.trim(),
    visualSuggestions: cleanList(draft.visualSuggestions, MAX_SUGGESTION_LENGTH),
    voiceover: draft.voiceover.trim(),
    riskNotes: cleanList(draft.riskNotes, MAX_SUGGESTION_LENGTH),
    confidence: draft.confidence,
  };
}

/* ------------------------------------------------------------------ */
/* 事实对齐                                                            */
/* ------------------------------------------------------------------ */

/** 本次生成请求的槽位：为哪个商品、在哪个平台、出哪种形态的内容 */
export interface ContentRequestSlot {
  platform: ContentPlatform;
  format: ContentFormat;
}

/**
 * 把产出对齐到请求的槽位。
 *
 * 为什么平台的取值必须以请求为准，而不是采信模型的复述：
 * 「在哪个平台发」是用户明确选择的**请求参数**，不是模型的推断结论。
 * 模型的任务是产出一份**符合该平台调性**的内容；它若把 platform 写成别的值，
 * 说明它没有按要求作答，而不是「平台应该改成它写的那个」。
 *
 * 但也不能静默丢弃这个信号 —— 把它记进 notes，让商家在界面上看得到。
 */
export function alignContentDraftToRequest(
  draft: ContentAssetDraft,
  slot: ContentRequestSlot,
): { draft: ContentAssetDraft; notes: string[] } {
  const notes: string[] = [];

  if (draft.platform !== slot.platform) {
    notes.push(
      `模型回传的平台是「${draft.platform}」，与请求的「${slot.platform}」不一致，已按请求值落库，请核对内容调性是否匹配。`,
    );
  }
  if (draft.type !== slot.format) {
    notes.push(
      `模型回传的内容形态是「${draft.type}」，与请求的「${slot.format}」不一致，已按请求值落库，请核对内容体裁是否匹配。`,
    );
  }

  return {
    draft: { ...draft, platform: slot.platform, type: slot.format },
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* 映射                                                                */
/* ------------------------------------------------------------------ */

/**
 * AI 契约 → 仓储输入。
 * 这里是**唯一**的字段改名点：
 * `type → format`、`scenes → shotList`、`tags → hashtags`、`callToAction → cta`。
 */
export function toNewContentInput(
  draft: ContentAssetDraft,
  options: {
    productId: string;
    /** 商品名快照：内容要能脱离商品独立展示（商品改名不应改写历史内容上的署名） */
    productName: string;
    businessId?: string;
  },
): NewContentInput {
  return {
    ...(options.businessId ? { businessId: options.businessId } : {}),
    productId: options.productId,
    productName: options.productName,
    platform: draft.platform,
    format: draft.type,
    title: draft.title,
    hook: draft.hook,
    body: draft.body,
    cta: draft.callToAction,
    hashtags: [...draft.tags],
    visualSuggestions: [...draft.visualSuggestions],
    shotList: [...draft.scenes],
    voiceover: draft.voiceover,
    /**
     * AI 产出默认 `draft`（草稿）：必须由商家确认后才能排期发布。
     * 与 Product DNA / Brand Profile 的 `approved: false` 是同一条纪律 ——
     * 人拥有最终决策权（技术文档 5.4）。
     */
    status: "draft",
    riskNotes: [...draft.riskNotes],
    aiVersion: CONTENT_AI_VERSION,
    confidence: draft.confidence,
  };
}
