/**
 * AI 直播导演的结构化契约（S6 · 任务书第七节）
 *
 * 产出的是**给主播的建议**，不是给消费者的话。因此这份 Schema 既要约束形状，
 * 也要约束几条**业务一致性**（与客服 Schema 同一思路），把「模型的偷懒 / 越界」
 * 直接变成一次校验失败，触发回喂纠错：
 *
 * - `grounded=true` 必须给出引用 —— 「有依据」却不指出依据在哪，无法核查。
 * - `grounded=false` 必须**不带引用**，并至少给一条风险提示 ——
 *   依据不足时最危险的动作就是「照样给一句听起来很确定的话术」，
 *   强制带风险提示能让主播看到「这句话没有依据兜底」。
 * - `shouldRespond=false` 与 `recommendedAction="ignore"` 必须同时成立 ——
 *   否则会出现「不建议回应，但推荐动作是处理异议」这种自相矛盾的卡片。
 *
 * 引用只允许 id（`documentId` / `chunkId`），标题由服务端按 id 回填 ——
 * 模型编不出真实标题，也就伪造不出一条看起来可信的引用。
 */

import { z } from "zod";

import {
  LIVE_INTENTS,
  LIVE_PRIORITIES,
  LIVE_RECOMMENDED_ACTIONS,
  LIVE_RESPONSE_MODES,
} from "@/types";

import { confidenceSchema, textField, textListField } from "./field-rules";

/** 主播建议上限。直播场景要短 —— 长了主播来不及看 */
export const MAX_HOST_SUGGESTION_LENGTH = 240;
/** 建议话术上限 */
export const MAX_SUGGESTED_REPLY_LENGTH = 500;
/** 营销切入点上限 */
export const MAX_SELLING_ANGLE_LENGTH = 200;
/** 引用条数上限（与检索 TopK 同量级） */
export const MAX_LIVE_CITATIONS = 6;
/** 风险提示单条上限 */
export const MAX_LIVE_RISK_NOTE_LENGTH = 80;

/** 单条引用：只允许 id，标题由服务端回填 */
export const LiveCitationSchema = z.object({
  documentId: z.string().trim().min(1, "引用缺少 documentId"),
  chunkId: z.string().trim().min(1, "引用缺少 chunkId"),
});

export const LiveDirectorResultSchema = z
  .object({
    intent: z.enum(LIVE_INTENTS),
    priority: z.enum(LIVE_PRIORITIES),
    shouldRespond: z.boolean(),
    responseMode: z.enum(LIVE_RESPONSE_MODES),
    hostSuggestion: textField("主播建议", MAX_HOST_SUGGESTION_LENGTH),
    suggestedReply: textField("建议话术", MAX_SUGGESTED_REPLY_LENGTH),
    /**
     * 营销切入点：只对营销型问题有意义。
     * 允许缺省 —— 事实型问题本来就不该有切入点，模型不写是正确行为。
     */
    sellingAngle: z
      .string()
      .trim()
      .max(MAX_SELLING_ANGLE_LENGTH)
      .optional(),
    grounded: z.boolean(),
    citations: z.array(LiveCitationSchema).max(MAX_LIVE_CITATIONS, "引用条数过多"),
    recommendedAction: z.enum(LIVE_RECOMMENDED_ACTIONS),
    riskNotes: textListField("风险提示", {
      maxItemLength: MAX_LIVE_RISK_NOTE_LENGTH,
      minItems: 0,
      maxItems: 6,
    }),
    confidence: confidenceSchema,
  })
  .superRefine((value, ctx) => {
    if (value.grounded && value.citations.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["citations"],
        message: "grounded=true 时必须至少给出一条引用",
      });
    }

    if (!value.grounded && value.citations.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["citations"],
        message: "grounded=false 时不得给出引用（没有依据就不该有引用）",
      });
    }

    if (!value.grounded && value.riskNotes.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["riskNotes"],
        message: "依据不足（grounded=false）时必须至少给出一条风险提示",
      });
    }

    if (!value.shouldRespond && value.recommendedAction !== "ignore") {
      ctx.addIssue({
        code: "custom",
        path: ["recommendedAction"],
        message: "shouldRespond=false 时推荐动作只能是 ignore",
      });
    }

    if (value.shouldRespond && value.recommendedAction === "ignore") {
      ctx.addIssue({
        code: "custom",
        path: ["recommendedAction"],
        message: "shouldRespond=true 时推荐动作不能是 ignore",
      });
    }
  });

export type LiveDirectorResultDraft = z.infer<typeof LiveDirectorResultSchema>;

/**
 * 依据不足时直播导演的置信度。
 *
 * 与客服同理：不复用模型自评的 confidence —— 它常对「我答不上来但有话说」
 * 给出很高的把握，而界面会把那个数字读成「这条建议很可信」。
 */
export const INSUFFICIENT_LIVE_CONFIDENCE = 0.2;

/** 字段 → 中文标签，让纠错提示可读 */
export const LIVE_DIRECTOR_FIELD_LABELS: Readonly<Record<string, string>> = {
  intent: "评论意图",
  priority: "优先级",
  shouldRespond: "是否建议回应",
  responseMode: "回应方式",
  hostSuggestion: "主播建议",
  suggestedReply: "建议话术",
  sellingAngle: "营销切入点",
  grounded: "是否有知识依据",
  citations: "引用来源",
  "citations.documentId": "引用的文档 ID",
  "citations.chunkId": "引用的片段 ID",
  recommendedAction: "推荐动作",
  riskNotes: "风险提示",
  confidence: "置信度",
};

/** 纠错提示里要强调的键名 */
export const LIVE_DIRECTOR_REQUIRED_KEYS: readonly string[] = [
  "intent",
  "priority",
  "shouldRespond",
  "responseMode",
  "hostSuggestion",
  "suggestedReply",
  "grounded",
  "citations",
  "recommendedAction",
  "riskNotes",
  "confidence",
];
