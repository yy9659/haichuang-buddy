/**
 * 客服回答的结构化契约（S5 · 任务书第十八节）
 *
 * 与另外几份 Schema 的**根本差别**：这里的产物是**对外说的话**。
 * 商品理解写错只影响内部判断，而一句编造的「我们三天内发货」
 * 会被消费者截图、被平台判违规。因此本 Schema 用 `superRefine` 加了一组
 * **业务一致性约束**，而不只是形状校验：
 *
 * - `grounded=false` 必须 `needsHuman=true` —— 没有依据却不说要转人工，
 *   等于让消费者以为这就是答案。
 * - `grounded=true` 必须有引用 —— 「有依据」却不指出依据在哪，无法核查。
 * - 事实类问题（intent ≠ other）无依据时必须说明缺哪类信息，
 *   否则商家在缺口面板上只看到一句「答不上来」，无从下手补知识。
 *
 * 这些约束会让「模型偷懒」直接变成一次校验失败，进而触发回喂纠错 ——
 * 比在 Agent 里补一堆 if 更可靠，因为模型自己看得到失败原因。
 */

import { z } from "zod";

import { CUSTOMER_INTENTS } from "@/types";

import { confidenceSchema, textField, textListField } from "./field-rules";

/** 回答正文上限。客服话术要短 —— 超过这个长度基本可以判定它在编故事 */
export const MAX_ANSWER_LENGTH = 800;
/** 缺口说明上限 */
export const MAX_KNOWLEDGE_GAP_LENGTH = 200;
/** 引用条数上限（与检索 TopK 同量级） */
export const MAX_CITATIONS = 6;
/** 风险提示单条上限 */
const MAX_RISK_NOTE_LENGTH = 80;

/** 单条引用：只允许 id，不允许模型自带 title —— 标题由服务端按 id 回填，模型编不出来 */
export const CitationSchema = z.object({
  documentId: z.string().trim().min(1, "引用缺少 documentId"),
  chunkId: z.string().trim().min(1, "引用缺少 chunkId"),
});

export type Citation = z.infer<typeof CitationSchema>;

export const CustomerServiceAnswerSchema = z
  .object({
    answer: textField("回答", MAX_ANSWER_LENGTH),
    intent: z.enum(CUSTOMER_INTENTS),
    grounded: z.boolean(),
    confidence: confidenceSchema,
    citations: z.array(CitationSchema).max(MAX_CITATIONS, "引用条数过多"),
    needsHuman: z.boolean(),
    /**
     * 依据不足时说明「缺哪类信息」。
     *
     * 允许缺省（而不是必填）：模型可能在一次成功的回答里顺手不带它。
     * 「事实类问题无依据时必须给出」这条由下面的 refiner 负责，
     * 用 `.optional()` + 业务校验，比在类型层强制更贴近真实输出的形状。
     */
    knowledgeGap: z.string().trim().max(MAX_KNOWLEDGE_GAP_LENGTH).optional(),
    /** 合规 / 事实风险提示；允许为空数组（「没发现问题」是合法结论） */
    riskNotes: textListField("风险提示", {
      maxItemLength: MAX_RISK_NOTE_LENGTH,
      minItems: 0,
      maxItems: 6,
    }),
  })
  .superRefine((value, ctx) => {
    if (!value.grounded && !value.needsHuman) {
      ctx.addIssue({
        code: "custom",
        path: ["needsHuman"],
        message: "依据不足（grounded=false）时必须同时给出 needsHuman=true",
      });
    }

    if (value.grounded && value.citations.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["citations"],
        message: "grounded=true 时必须至少给出一条引用",
      });
    }

    if (
      !value.grounded &&
      value.intent !== "other" &&
      !value.knowledgeGap?.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["knowledgeGap"],
        message: "事实类问题依据不足时必须说明缺少哪类信息",
      });
    }
  });

export type CustomerServiceAnswerDraft = z.infer<typeof CustomerServiceAnswerSchema>;

/**
 * 依据不足时的置信度。
 *
 * 不复用模型自评的 confidence：它对「我答不上来」这件事往往很有把握（0.9+），
 * 而界面会把那个数字读成「这条回答有 90% 可信」—— 与旁边的「依据不足」
 * 徽标直接矛盾。这里给一个明确的低值：低置信 + 转人工，语义一致。
 */
export const INSUFFICIENT_ANSWER_CONFIDENCE = 0.2;

/**
 * 字段 → 中文标签。
 *
 * 用途与另外几份 Schema 相同：校验失败时把 `grounded: ...` 这类技术信息
 * 变成「是否有依据：…」，模型据此能定位到自己写错了哪一个键。
 */
export const CUSTOMER_SERVICE_FIELD_LABELS: Readonly<Record<string, string>> = {
  answer: "回答正文",
  intent: "意图",
  grounded: "是否有知识依据",
  confidence: "置信度",
  citations: "引用来源",
  "citations.documentId": "引用的文档 ID",
  "citations.chunkId": "引用的片段 ID",
  needsHuman: "是否需要转人工",
  knowledgeGap: "知识缺口说明",
  riskNotes: "风险提示",
};

/** 纠错提示里要强调的键名 */
export const CUSTOMER_SERVICE_REQUIRED_KEYS: readonly string[] = [
  "answer",
  "intent",
  "grounded",
  "confidence",
  "citations",
  "needsHuman",
  "riskNotes",
];
