/**
 * Content Agent —— 第三个 AI Agent（技术文档 Module 5 / 6.4 / 9.5）
 *
 * 输入：商品资料 + Product DNA + Brand Profile（+ Owner Profile 的禁用表达）
 * 输出：结构化 Content Asset（标题 / 钩子 / 正文 / 分镜 / 标签 / CTA / 视觉建议 / 口播 / 风险）
 *
 * 执行流程（每一步都可失败、都可观测，全程返回 Result，不抛异常给上层）：
 *
 *   1. 校验输入（Zod）        —— 平台 / 形态非法、商品名缺失时直接拒绝
 *   2. Provider 解析          —— 未接入的真实提供方在这里明确报错，不静默降级
 *   3. 依据前置检查            —— 既没有 Product DNA、也没有品牌档案时直接拒绝
 *   4. 组装提示词              —— 商品事实 + 品牌约束 + 平台 / 形态调性 + 结构化上下文块
 *   5. 结构化生成 + 校验       —— Schema 校验失败时把错误回喂模型纠错一次
 *   6. 归一化 / 事实对齐 / 扫描 —— 去重限长；平台与形态以**请求**为准；
 *                               扫「疑似虚构事实」「绝对化用语」「命中禁用表达」
 *   7. 产出 draft 与可观测信息 —— 落库交给服务层
 *
 * 设计要点：
 * - Agent 只依赖 `AIProvider` 接口，不认识任何模型 SDK。
 * - **不编造依据**：输入里既没有商品卖点、也没有品牌策略时直接失败 ——
 *   这种情况下模型只能靠「海产品」这个品类标签编文案，产出必然是假的，不如明确拒绝。
 * - **平台与形态以请求为准**：见 `alignContentDraftToRequest`；模型复述不一致只记 warning。
 * - **合规扫描只告警不改写**：Agent 不改模型的用词（改写会掩盖问题），
 *   而是把风险点记进 warnings 与 riskNotes 让商家看到（技术文档 5.4）。
 */

import { z } from "zod";

import { getAIProvider } from "@/ai/provider";
import type { AIProvider, ModelTier } from "@/ai/provider/types";
import {
  CONTENT_AGENT_REQUIRED_KEYS,
  CONTENT_AGENT_SYSTEM_PROMPT,
  buildContentAgentPrompt,
  clipDnaList,
  type ContentContext,
  type ContentContextBrand,
  type ContentContextProduct,
} from "@/ai/prompts/content-agent";
import { generateValidatedObject } from "@/ai/schemas/agent-output";
import {
  CONTENT_FIELD_LABELS,
  CONTENT_RISK_NOTE_MAX_LENGTH,
  CONTENT_SCENE_MAX_LENGTH,
  ContentAssetSchema,
  alignContentDraftToRequest,
  normalizeContentDraft,
  type ContentAssetDraft,
  type ContentRequestSlot,
} from "@/ai/schemas/content";
import { CONTENT_ANGLES, CONTENT_FORMATS, CONTENT_PLATFORMS, type ContentAngle } from "@/lib/content-options";
import { fail, ok, toAppError, type Result } from "@/lib/result";
import { formatIssues } from "@/lib/validation";
import type { ContentFormat, ContentPlatform, OwnerTwin } from "@/types";

import {
  ABSOLUTE_CLAIM_TERMS,
  findForbiddenHits,
  findTermHits,
  findUnsupportedOriginTerms,
} from "./compliance";

/** Agent 标识（运行时），与写入 `agent_tasks.agent_type` 的 `content_agent` 区分开 */
export const CONTENT_AGENT_ID = "content-agent";
/** 展示名 */
export const CONTENT_AGENT_NAME = "内容运营 Agent";

/**
 * 内容生产属于**高频、轻推理**的文本创作，使用 fast 档位（对应 AI_MODEL_FAST）。
 * 与品牌策略刻意选用 reasoning 档位形成对照：不是所有 Agent 都该用最贵的模型，
 * 档位是按任务性质挑的，不是按「哪个更强」挑的。
 */
const AGENT_MODEL_TIER: ModelTier = "fast";

/**
 * 结构化输出的总尝试次数（首次 + 2 次纠错）。
 * 与直播的 `LIVE_SCHEMA_ATTEMPTS` 同一逻辑：交互式 / 后台自动步骤
 * 值得多一轮自愈，而不是把概率性失败直接甩给商家手动重试。
 */
const CONTENT_SCHEMA_ATTEMPTS = 3;

/* ------------------------------------------------------------------ */
/* 输入                                                                */
/* ------------------------------------------------------------------ */

/** 生成依据里的商品（含可选 DNA） */
export interface ContentAgentProductInput {
  name: string;
  category?: string | null;
  subCategory?: string | null;
  origin?: string | null;
  specification?: string | null;
  /** 价格 + 单位已拼成可读文本（如「128.50 元 / 500g」），Agent 不做单位换算 */
  priceText?: string | null;
  storageMethod?: string | null;
  shelfLife?: string | null;
  dna?: {
    coreFeatures?: readonly string[] | null;
    sellingPoints?: readonly string[] | null;
    targetUsers?: readonly string[] | null;
    consumptionScenarios?: readonly string[] | null;
    userPainPoints?: readonly string[] | null;
    marketingAngles?: readonly string[] | null;
    visualFeatures?: readonly string[] | null;
  } | null;
}

/** Agent 输入：商品 + 品牌档案 + 老板数字分身 + 本次请求的槽位 */
export interface ContentAgentInput {
  product: ContentAgentProductInput;
  /** 品牌档案；未生成时传 null（内容语气将退化为通用海产经营者口吻） */
  brand?: ContentContextBrand | null;
  /** 老板数字分身：主要取 `forbiddenExpressions` 做合规约束 */
  ownerTwin?: OwnerTwin | null;
  /** 本次请求的平台与内容形态 */
  request: ContentRequestSlot;
  angle?: ContentAngle;
}

const stringListSchema = z.array(z.string().trim().min(1)).nullish();

const dnaSchema = z
  .object({
    coreFeatures: stringListSchema,
    sellingPoints: stringListSchema,
    targetUsers: stringListSchema,
    consumptionScenarios: stringListSchema,
    userPainPoints: stringListSchema,
    marketingAngles: stringListSchema,
    visualFeatures: stringListSchema,
  })
  .nullish();

const brandSchema = z
  .object({
    positioning: z.string().trim().default(""),
    slogan: z.string().trim().default(""),
    brandStory: z.string().trim().optional(),
    brandValues: z.array(z.string().trim()).default([]),
    targetAudience: z.array(z.string().trim()).default([]),
    brandKeywords: z.array(z.string().trim()).default([]),
    toneOfVoice: z.array(z.string().trim()).default([]),
    visualKeywords: z.array(z.string().trim()).default([]),
  })
  .nullish();

const contentAgentInputSchema = z.object({
  product: z.object({
    name: z.string().trim().min(1, "商品名称不能为空").max(60),
    category: z.string().trim().max(30).nullish(),
    subCategory: z.string().trim().max(40).nullish(),
    origin: z.string().trim().max(60).nullish(),
    specification: z.string().trim().max(80).nullish(),
    priceText: z.string().trim().max(60).nullish(),
    storageMethod: z.string().trim().max(80).nullish(),
    shelfLife: z.string().trim().max(40).nullish(),
    dna: dnaSchema,
  }),
  brand: brandSchema,
  ownerTwin: z
    .object({
      displayName: z.string().trim().default(""),
      avatarLabel: z.string().trim().default(""),
      businessPhilosophy: z.array(z.string().trim()).default([]),
      tone: z.array(z.string().trim()).default([]),
      salesStyle: z.string().trim().default(""),
      targetCustomers: z.array(z.string().trim()).default([]),
      forbiddenExpressions: z.array(z.string().trim()).default([]),
    })
    .nullish(),
  request: z.object({
    platform: z.enum(CONTENT_PLATFORMS),
    format: z.enum(CONTENT_FORMATS),
  }),
  angle: z.enum(CONTENT_ANGLES).optional(),
});

const CONTENT_AGENT_INPUT_LABELS: Record<string, string> = {
  "product.name": "商品名称",
  "request.platform": "发布平台",
  "request.format": "内容形态",
};

/**
 * 商品是否真的提供了可用的卖点依据（有 DNA 且至少一个列表非空）
 */
function hasUsableDna(product: ContentAgentProductInput): boolean {
  const dna = product.dna;
  if (!dna) {
    return false;
  }
  return [
    dna.coreFeatures,
    dna.sellingPoints,
    dna.targetUsers,
    dna.consumptionScenarios,
    dna.userPainPoints,
    dna.marketingAngles,
    dna.visualFeatures,
  ].some((list) => (list?.length ?? 0) > 0);
}

/** 品牌档案是否真的带有可用的品牌约束 */
function hasBrandMaterial(brand: ContentContextBrand | null | undefined): boolean {
  if (!brand) {
    return false;
  }
  return (
    brand.positioning.trim().length > 0 ||
    brand.slogan.trim().length > 0 ||
    brand.toneOfVoice.length > 0 ||
    brand.brandKeywords.length > 0
  );
}

/* ------------------------------------------------------------------ */
/* 事实与合规扫描                                                       */
/* ------------------------------------------------------------------ */

/** 扫描结果：短词条进内容条目，长说明进任务告警 */
export interface ContentRiskScan {
  /** 随内容落库的短词条（每条 ≤ CONTENT_RISK_NOTE_MAX_LENGTH 字） */
  notes: string[];
  /** 给商家看的完整说明（进 agent_tasks.output.warnings 与界面提示） */
  warnings: string[];
}

/** 内容里所有会被读者看到的文本 */
function buildScanCorpus(draft: ContentAssetDraft): string {
  return [
    draft.title,
    draft.hook,
    draft.body,
    draft.callToAction,
    draft.voiceover,
    ...draft.scenes,
    ...draft.visualSuggestions,
    ...draft.tags,
  ].join("\n");
}

/**
 * 扫描产出里的事实与合规风险。
 * 词表与基础判定来自 `./compliance`（与 Brand Agent 共用同一份红线）。
 *
 * 判定规则：
 * - 命中「其他产地词」，但该词**不在**商品产地 / 商品名 / 品牌档案已有的表述里
 *   → 疑似虚构产地；
 * - 命中「绝对化用语」→ 合规风险（广告法下不可用）；
 * - 命中老板数字分身的禁用表达 → 必须改写。
 *
 * 为什么把品牌档案文本也算作「有据可依」：内容应当忠实复述品牌已有的表述，
 * 若品牌定位里就写了「连江黄岐半岛」，内容跟着写就不是内容 Agent 的编造 ——
 * 真有问题应该在品牌那一层被发现（Brand Agent 有自己的扫描）。
 *
 * 入参用**对外的** `ContentAgentInput` 而不是 Zod 解析后的内部类型：
 * 这个函数是导出的，如果签名里引用一个不导出的类型，外部调用方（含测试）
 * 就永远没法直接调用它，导出等于白导。解析后的类型可以安全地赋给本类型
 * （`string[]` 可赋给 `readonly string[]`），因此 `runContentAgent` 传进来的值不用转换。
 */
export function scanContentRisks(
  draft: ContentAssetDraft,
  input: ContentAgentInput,
): ContentRiskScan {
  const corpus = buildScanCorpus(draft);
  const brand = input.brand;

  const grounding = [
    input.product.name,
    input.product.origin ?? "",
    input.product.specification ?? "",
    brand?.positioning ?? "",
    brand?.slogan ?? "",
    brand?.brandStory ?? "",
    ...(brand?.brandKeywords ?? []),
    ...(brand?.brandValues ?? []),
    ...(brand?.visualKeywords ?? []),
  ].join("\n");

  const notes: string[] = [];
  const warnings: string[] = [];

  const clip = (note: string): string =>
    note.slice(0, CONTENT_RISK_NOTE_MAX_LENGTH);

  const fabricated = findUnsupportedOriginTerms(corpus, grounding);
  if (fabricated.length > 0) {
    notes.push(clip(`疑似虚构产地：${fabricated.join("、")}`));
    warnings.push(
      `内容中出现输入资料里没有的产地/地域表述（${fabricated.join("、")}），疑似虚构产地，请核对后再发布`,
    );
  }

  const absolute = findTermHits(corpus, ABSOLUTE_CLAIM_TERMS);
  if (absolute.length > 0) {
    notes.push(clip(`绝对化用语：${absolute.join("、")}`));
    warnings.push(
      `内容中出现绝对化或无法证实的用语（${absolute.join("、")}），存在广告法合规风险，建议改写`,
    );
  }

  const forbidden = findForbiddenHits(
    corpus,
    input.ownerTwin?.forbiddenExpressions ?? [],
  );
  if (forbidden.length > 0) {
    notes.push(clip(`命中禁用表达：${forbidden.join("、")}`));
    warnings.push(
      `内容命中了老板数字分身的禁用表达（${forbidden.join("、")}），必须改写`,
    );
  }

  return { notes, warnings };
}

/* ------------------------------------------------------------------ */
/* 组装                                                                */
/* ------------------------------------------------------------------ */

/** 截断列表并对齐到提示词用的形状 */
function toContextDna(
  dna: ContentAgentProductInput["dna"],
): ContentContextProduct["dna"] {
  if (!dna) {
    return null;
  }
  return {
    coreFeatures: clipDnaList(dna.coreFeatures),
    sellingPoints: clipDnaList(dna.sellingPoints),
    targetUsers: clipDnaList(dna.targetUsers),
    consumptionScenarios: clipDnaList(dna.consumptionScenarios),
    userPainPoints: clipDnaList(dna.userPainPoints),
    marketingAngles: clipDnaList(dna.marketingAngles),
    visualFeatures: clipDnaList(dna.visualFeatures),
  };
}

export interface ContentAgentRunOptions {
  /** 注入 Provider（测试用）；默认取 `getAIProvider()` */
  provider?: AIProvider;
  signal?: AbortSignal;
}

/** Agent 运行结果：内容 draft + 可观测性信息（服务层据此写 agent_tasks） */
export interface ContentAgentRunResult {
  /** 通过 Schema 校验、且已归一化与对齐槽位的契约对象 */
  draft: ContentAssetDraft;
  /** 实际使用的 Provider 标识，便于区分 Mock 与真实模型 */
  providerId: string;
  platform: ContentPlatform;
  format: ContentFormat;
  /** 调用模型的次数（含纠错重试） */
  attempts: number;
  /** 是否经过纠错重试才通过校验 */
  repaired: boolean;
  /** 依据缺口、槽位不一致与合规风险提示 */
  warnings: string[];
}

/**
 * 判断依据是否可用。
 * 服务层在**创建任务记录之前**用它做一次前置检查，避免为一次注定失败的调用留下任务记录。
 */
export function hasContentGrounding(input: ContentAgentInput): boolean {
  return hasUsableDna(input.product) || hasBrandMaterial(input.brand ?? null);
}

/** 执行 Content Agent */
export async function runContentAgent(
  rawInput: ContentAgentInput,
  options: ContentAgentRunOptions = {},
): Promise<Result<ContentAgentRunResult>> {
  const warnings: string[] = [];

  // 1. 输入校验
  const parsed = contentAgentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      "VALIDATION_FAILED",
      "内容生成参数不完整，无法生成内容",
      formatIssues(parsed.error, CONTENT_AGENT_INPUT_LABELS),
    );
  }
  const input = parsed.data;
  const { platform, format } = input.request;

  const dnaAvailable = hasUsableDna(input.product);
  const brandAvailable = hasBrandMaterial(input.brand ?? null);

  /**
   * 既没有商品卖点依据、也没有品牌策略时**直接拒绝**，不浪费一次模型调用。
   * 理由：这时模型手上只有「品名 + 分类 + 产地」，产出必然是套话或编造的事实。
   */
  if (!dnaAvailable && !brandAvailable) {
    return fail(
      "VALIDATION_FAILED",
      "缺少可用于生成内容的依据",
      "请先对商品执行「AI 分析商品」生成 Product DNA，或先生成品牌档案，再生成内容。",
    );
  }

  if (!dnaAvailable) {
    warnings.push(
      "该商品尚未完成 AI 分析（无 Product DNA），本次内容只基于品类事实与品牌档案撰写，卖点依据不足，建议先分析商品后重新生成。",
    );
  }
  if (!brandAvailable) {
    warnings.push(
      "尚未生成品牌档案，本次内容语气采用通用海产经营者口吻，建议先生成品牌策略后重新生成。",
    );
  }

  // 2. Provider 解析（真实提供方未接入时这里是明确报错，不是静默降级）
  let provider: AIProvider;
  if (options.provider) {
    provider = options.provider;
  } else {
    try {
      provider = getAIProvider();
    } catch (cause) {
      return {
        ok: false,
        error: toAppError(cause, "MODEL_UNAVAILABLE", "模型提供方不可用"),
      };
    }
  }

  // 3. 组装提示词
  const context: ContentContext = {
    request: { platform, format, angle: input.angle ?? "selling-point" },
    product: {
      name: input.product.name,
      category: input.product.category ?? undefined,
      subCategory: input.product.subCategory ?? undefined,
      origin: input.product.origin ?? undefined,
      specification: input.product.specification ?? undefined,
      priceText: input.product.priceText ?? undefined,
      storageMethod: input.product.storageMethod ?? undefined,
      shelfLife: input.product.shelfLife ?? undefined,
      dna: toContextDna(input.product.dna),
    },
    brand: input.brand
      ? {
          positioning: input.brand.positioning,
          slogan: input.brand.slogan,
          brandStory: input.brand.brandStory,
          brandValues: [...input.brand.brandValues],
          targetAudience: [...input.brand.targetAudience],
          brandKeywords: [...input.brand.brandKeywords],
          toneOfVoice: [...input.brand.toneOfVoice],
          visualKeywords: [...input.brand.visualKeywords],
        }
      : null,
    owner: input.ownerTwin ?? null,
  };

  // 4. 结构化生成 + 校验（首次 + 2 次纠错）
  const generated = await generateValidatedObject({
    provider,
    system: CONTENT_AGENT_SYSTEM_PROMPT,
    prompt: buildContentAgentPrompt({ context, notes: warnings }),
    schema: ContentAssetSchema,
    tier: AGENT_MODEL_TIER,
    labels: CONTENT_FIELD_LABELS,
    requiredKeys: CONTENT_AGENT_REQUIRED_KEYS,
    repairGuidance: (issue) =>
      /镜头场景|scenes/.test(issue)
        ? `请逐条检查 scenes：每条只保留一个画面或一页配图的可执行安排，绝不超过 ${CONTENT_SCENE_MAX_LENGTH} 字；较长说明移到 body。保留其他已通过校验的字段，同时修复校验错误中提到的其他字段。`
        : null,
    /**
     * 内容专用纠错预算（先例：直播的 `LIVE_SCHEMA_ATTEMPTS`，不改全局常量）。
     * 结构校验失败是**概率性**的——同一份输入重放 8 次全部合法，
     * 但真实运行中出现过连续 2 次不过的情况；内容又是工作流的后台步骤，
     * 失败要商家手动点「重试」，多留一轮自愈比把人叫回来划算。
     * 快速档模型单次调用成本低，放大的代价可忽略。
     */
    maxAttempts: CONTENT_SCHEMA_ATTEMPTS,
    signal: options.signal,
  });

  if (!generated.ok) {
    return { ok: false, error: generated.error };
  }

  // 5. 归一化 → 事实对齐（平台/形态以请求为准）→ 合规扫描
  const normalized = normalizeContentDraft(generated.data.value);
  const aligned = alignContentDraftToRequest(normalized, { platform, format });
  warnings.push(...aligned.notes);

  const scan = scanContentRisks(aligned.draft, input);
  warnings.push(...scan.warnings);

  /**
   * 把扫描发现的短词条并入 riskNotes，让风险随内容一起留痕
   * （而不是只活在任务记录里，被下一次生成覆盖掉）。
   * 仍受字段约束（最多 8 条），因此取前 8 条。
   */
  const mergedRiskNotes = Array.from(
    new Set([...aligned.draft.riskNotes, ...scan.notes]),
  ).slice(0, 8);

  // 6. 产出
  return ok({
    draft: { ...aligned.draft, riskNotes: mergedRiskNotes },
    providerId: provider.id,
    platform,
    format,
    attempts: generated.data.attempts,
    repaired: generated.data.repaired,
    warnings,
  });
}
