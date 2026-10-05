/**
 * Brand Agent —— 第二个 AI Agent（技术文档 Module 4 / 6.3 / 7）
 *
 * 输入：商家资料 + Owner Profile（老板数字分身）+ 一组 Product DNA
 * 输出：结构化 Brand Profile（品牌定位 / 品牌故事 / 品牌价值 / 目标客户 / 语气 / 视觉方向…）
 *
 * 执行流程（每一步都可失败、都可观测，全程返回 Result，不抛异常给上层）：
 *
 *   1. 校验输入（Zod）        —— 商家名缺失、或**没有任何品牌依据**时直接拒绝
 *   2. Provider 解析          —— 未接入的真实提供方在这里明确报错，不静默降级
 *   3. 组装提示词              —— 商家 + 老板分身 + 商品 DNA + 结构化上下文块（含注入防护）
 *   4. 结构化生成 + 校验       —— Schema 校验失败时把错误回喂模型纠错一次
 *   5. 归一化与合规扫描        —— 去重限长；扫「虚构产地词」与「绝对化用语」，命中则记 warning
 *   6. 产出 draft 与可观测信息 —— 落库交给服务层（仓储负责派生 completeness）
 *
 * 设计要点：
 * - Agent 只依赖 `AIProvider` 接口，不认识任何模型 SDK。
 * - **不编造依据**：输入里既没有商品 DNA、也没有 Owner Profile 时直接失败 ——
 *   这种情况下模型只能凭空编品牌，产出必然是假的，不如明确拒绝。
 * - **合规扫描只告警不改写**：Agent 不改模型的用词（改写会掩盖问题），
 *   而是把风险点记进 warnings 让商家看到。人与 AI 的分工在文档 5.4 有明确规定。
 */

import { z } from "zod";

import { getAIProvider } from "@/ai/provider";
import type { AIProvider, ModelTier } from "@/ai/provider/types";
import {
  BRAND_AGENT_REQUIRED_KEYS,
  BRAND_AGENT_SYSTEM_PROMPT,
  buildBrandAgentPrompt,
  type BrandContext,
  type BrandContextProduct,
} from "@/ai/prompts/brand-agent";
import { generateValidatedObject } from "@/ai/schemas/agent-output";
import {
  BRAND_PROFILE_FIELD_LABELS,
  BrandProfileSchema,
  normalizeBrandProfileDraft,
  type BrandProfileDraft,
} from "@/ai/schemas/brand-profile";
import { fail, ok, toAppError, type Result } from "@/lib/result";
import { formatIssues } from "@/lib/validation";
import type { OwnerTwin } from "@/types";

import {
  ABSOLUTE_CLAIM_TERMS,
  findForbiddenHits,
  findTermHits,
  findUnsupportedOriginTerms,
} from "./compliance";

/** Agent 标识（运行时），与写入 `agent_tasks.agent_type` 的 `brand_agent` 区分开 */
export const BRAND_AGENT_ID = "brand-agent";
/** 展示名 */
export const BRAND_AGENT_NAME = "品牌经理 Agent";

/** 品牌策略属于复杂推理，使用 reasoning 档位（对应 AI_MODEL_REASONING） */
const AGENT_MODEL_TIER: ModelTier = "reasoning";

/** 单个商品参与推导时，DNA 列表最多取多少条（避免提示词被单个商品淹没） */
const MAX_DNA_ITEMS_PER_FIELD = 6;
/** 参与推导的商品数量上限 */
export const MAX_BRAND_SOURCE_PRODUCTS = 8;

/* ------------------------------------------------------------------ */
/* 输入                                                                */
/* ------------------------------------------------------------------ */

/** Agent 输入：商家资料 + 老板数字分身 + 商品（含可选 DNA） */
export interface BrandAgentInput {
  business: {
    id?: string;
    name: string;
    shortName?: string | null;
    description?: string | null;
    owner?: string | null;
    location?: string | null;
    mainCategory?: string | null;
    channels?: readonly string[] | null;
  };
  ownerTwin?: OwnerTwin | null;
  /** 参与推导的商品；至少一个商品带 DNA，或提供 ownerTwin，否则直接拒绝 */
  products?: readonly BrandAgentProductInput[] | null;
  /** 主依据商品 id（用于落库时记录来源） */
  primaryProductId?: string | null;
}

/** 单个商品的品牌依据 */
export interface BrandAgentProductInput {
  name: string;
  category?: string | null;
  subCategory?: string | null;
  origin?: string | null;
  dna?: {
    coreFeatures?: readonly string[] | null;
    sellingPoints?: readonly string[] | null;
    targetUsers?: readonly string[] | null;
    consumptionScenarios?: readonly string[] | null;
    marketingAngles?: readonly string[] | null;
    visualFeatures?: readonly string[] | null;
  } | null;
}

/** 输入校验 Schema：只把真正必要的字段设为必填 */
const stringListSchema = z.array(z.string().trim().min(1)).nullish();

const brandAgentInputSchema = z.object({
  business: z.object({
    id: z.string().trim().nullish(),
    name: z.string().trim().min(2, "商家名称至少 2 个字").max(60, "商家名称不能超过 60 字"),
    shortName: z.string().trim().max(30).nullish(),
    description: z.string().trim().max(500).nullish(),
    owner: z.string().trim().max(30).nullish(),
    location: z.string().trim().max(80).nullish(),
    mainCategory: z.string().trim().max(40).nullish(),
    channels: stringListSchema,
  }),
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
  products: z
    .array(
      z.object({
        name: z.string().trim().min(1, "商品名称不能为空").max(60),
        category: z.string().trim().max(30).nullish(),
        subCategory: z.string().trim().max(40).nullish(),
        origin: z.string().trim().max(60).nullish(),
        dna: z
          .object({
            coreFeatures: stringListSchema,
            sellingPoints: stringListSchema,
            targetUsers: stringListSchema,
            consumptionScenarios: stringListSchema,
            marketingAngles: stringListSchema,
            visualFeatures: stringListSchema,
          })
          .nullish(),
      }),
    )
    .max(MAX_BRAND_SOURCE_PRODUCTS, `最多只能基于 ${MAX_BRAND_SOURCE_PRODUCTS} 个商品推导品牌`)
    .nullish(),
  primaryProductId: z.string().trim().nullish(),
});

const BRAND_AGENT_INPUT_LABELS: Record<string, string> = {
  "business.name": "商家名称",
  products: "品牌依据商品",
  ownerTwin: "老板数字分身",
};

type ParsedBrandInput = z.infer<typeof brandAgentInputSchema>;

/** 商品是否真的提供了可用的品牌依据（有 DNA 且至少一个列表非空） */
function hasUsableDna(product: BrandAgentProductInput): boolean {
  const dna = product.dna;
  if (!dna) {
    return false;
  }
  return [
    dna.coreFeatures,
    dna.sellingPoints,
    dna.targetUsers,
    dna.consumptionScenarios,
    dna.marketingAngles,
    dna.visualFeatures,
  ].some((list) => (list?.length ?? 0) > 0);
}

function hasOwnerMaterial(owner: OwnerTwin | null | undefined): boolean {
  if (!owner) {
    return false;
  }
  return (
    owner.businessPhilosophy.length > 0 ||
    owner.tone.length > 0 ||
    owner.targetCustomers.length > 0 ||
    owner.salesStyle.trim().length > 0
  );
}

/* ------------------------------------------------------------------ */
/* 合规 / 事实风险扫描                                                  */
/* ------------------------------------------------------------------ */


/** 把多个可能为空的文本拼成一段扫描语料 */
function buildScanCorpus(draft: BrandProfileDraft): string {
  return [
    draft.brandPositioning,
    draft.brandStory,
    draft.slogan,
    draft.ipConcept,
    ...draft.brandValues,
    ...draft.targetAudience,
    ...draft.brandKeywords,
    ...draft.tone,
    ...draft.visualDirection,
  ].join("\n");
}

/** 扫描结果：短词条进档案，长说明进任务告警 */
export interface BrandRiskScan {
  /** 随档案落库的短词条（每条 ≤ 40 字，满足 riskNotes 的字段约束） */
  notes: string[];
  /** 给商家看的完整说明（进 agent_tasks.output.warnings 与界面提示） */
  warnings: string[];
}

/**
 * 扫描产出里的事实与合规风险。
 * 词表与基础判定来自 `./compliance`（与 Content Agent 共用同一份红线）。
 *
 * 判定规则：
 * - 命中「其他产地词」，但该词**不在**商家所在地 / 主营类目 / 任何商品产地里 → 疑似虚构产地；
 * - 命中「绝对化用语」→ 合规风险（这类用语在广告法下不可用）；
 * - 命中老板数字分身的禁用表达 → 必须改写。
 *
 * 只告警、不改写：把判断交给商家，Agent 不做「替用户删词」这种掩盖问题的动作。
 *
 * 为什么同时返回 notes 与 warnings：`riskNotes` 是档案字段（单条 ≤ 40 字），
 * 而这里想说的话更长。把「短词条」与「长说明」从同一次检测里派生出来，
 * 既让风险随档案留痕，又不在界面上塞半句话。
 */
export function scanBrandRisks(
  draft: BrandProfileDraft,
  input: ParsedBrandInput,
): BrandRiskScan {
  const corpus = buildScanCorpus(draft);

  /** 输入里**确实出现过**的地点词与产地，视为有据可依 */
  const grounding = [
    input.business.location ?? "",
    input.business.mainCategory ?? "",
    input.business.name,
    ...(input.products ?? []).map((product) => product.origin ?? ""),
    ...(input.products ?? []).map((product) => product.name),
  ].join("\n");

  const notes: string[] = [];
  const warnings: string[] = [];

  const fabricated = findUnsupportedOriginTerms(corpus, grounding);
  if (fabricated.length > 0) {
    notes.push(`疑似虚构产地：${fabricated.join("、")}`);
    warnings.push(
      `品牌文案中出现输入资料里没有的产地/地域表述（${fabricated.join("、")}），疑似虚构产地，请核对后再对外使用`,
    );
  }

  const absolute = findTermHits(corpus, ABSOLUTE_CLAIM_TERMS);
  if (absolute.length > 0) {
    notes.push(`绝对化用语：${absolute.join("、")}`);
    warnings.push(
      `品牌文案中出现绝对化或无法证实的用语（${absolute.join("、")}），存在广告法合规风险，建议改写`,
    );
  }

  const forbidden = findForbiddenHits(
    corpus,
    input.ownerTwin?.forbiddenExpressions ?? [],
  );
  if (forbidden.length > 0) {
    notes.push(`命中禁用表达：${forbidden.join("、")}`);
    warnings.push(
      `品牌文案命中了老板数字分身的禁用表达（${forbidden.join("、")}），必须改写`,
    );
  }

  return { notes, warnings };
}

/* ------------------------------------------------------------------ */
/* 组装                                                                */
/* ------------------------------------------------------------------ */

/** 截断列表并对齐到提示词用的形状 */
function toContextDna(
  dna: BrandAgentProductInput["dna"],
): BrandContextProduct["dna"] {
  if (!dna) {
    return null;
  }
  const clip = (list: readonly string[] | null | undefined): string[] =>
    (list ?? []).slice(0, MAX_DNA_ITEMS_PER_FIELD);
  return {
    coreFeatures: clip(dna.coreFeatures),
    sellingPoints: clip(dna.sellingPoints),
    targetUsers: clip(dna.targetUsers),
    consumptionScenarios: clip(dna.consumptionScenarios),
    marketingAngles: clip(dna.marketingAngles),
    visualFeatures: clip(dna.visualFeatures),
  };
}

export interface BrandAgentRunOptions {
  /** 注入 Provider（测试用）；默认取 `getAIProvider()` */
  provider?: AIProvider;
  signal?: AbortSignal;
}

/** Agent 运行结果：品牌档案 draft + 可观测性信息（服务层据此写 agent_tasks） */
export interface BrandAgentRunResult {
  /** 通过 Schema 校验的原始契约（落库映射与完整度计算都在服务层/仓储完成） */
  draft: BrandProfileDraft;
  /** 实际使用的 Provider 标识，便于区分 Mock 与真实模型 */
  providerId: string;
  /** 参与推导的商品数 */
  sourceProductCount: number;
  /** 其中真正带 DNA 的商品数 */
  analyzedProductCount: number;
  /** 调用模型的次数（含纠错重试） */
  attempts: number;
  /** 是否经过纠错重试才通过校验 */
  repaired: boolean;
  /** 降级、依据缺口与合规风险提示 */
  warnings: string[];
}

/** 执行 Brand Agent */
export async function runBrandAgent(
  rawInput: BrandAgentInput,
  options: BrandAgentRunOptions = {},
): Promise<Result<BrandAgentRunResult>> {
  const warnings: string[] = [];

  // 1. 输入校验
  const parsed = brandAgentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      "VALIDATION_FAILED",
      "品牌依据不完整，无法生成品牌档案",
      formatIssues(parsed.error, BRAND_AGENT_INPUT_LABELS),
    );
  }
  const input = parsed.data;

  const products = input.products ?? [];
  const analyzedCount = products.filter(hasUsableDna).length;
  const ownerAvailable = hasOwnerMaterial(input.ownerTwin ?? null);

  /**
   * 没有任何依据时**直接拒绝**，不浪费一次模型调用。
   * 理由：品牌档案是「推导」而不是「创作」——没有 Product DNA 也没有 Owner Profile 时，
   * 模型只能凭「海产品商家」这个品类标签编故事，产出必然是编的。
   */
  if (analyzedCount === 0 && !ownerAvailable) {
    return fail(
      "VALIDATION_FAILED",
      "缺少可用于生成品牌的依据",
      "请先对至少一个商品执行「AI 分析商品」生成 Product DNA，或先完善老板数字分身（Owner Profile），再生成品牌策略。",
    );
  }

  if (analyzedCount === 0) {
    warnings.push(
      "本次没有任何商品完成 AI 分析，品牌结论仅基于老板数字分身推导，建议先分析主力商品后重新生成。",
    );
  } else if (analyzedCount < products.length) {
    warnings.push(
      `${products.length} 个商品中有 ${analyzedCount} 个已完成 AI 分析，其余商品的卖点未纳入本次品牌推导。`,
    );
  }
  if (!ownerAvailable) {
    warnings.push(
      "尚未建立老板数字分身（Owner Profile），品牌语气采用通用海产经营者口吻，建议补充后重新生成。",
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
  const context: BrandContext = {
    business: {
      name: input.business.name,
      shortName: input.business.shortName ?? undefined,
      description: input.business.description ?? undefined,
      owner: input.business.owner ?? undefined,
      location: input.business.location ?? undefined,
      mainCategory: input.business.mainCategory ?? undefined,
      channels: input.business.channels ?? undefined,
    },
    ownerTwin: input.ownerTwin ?? null,
    products: products.map((product) => ({
      name: product.name,
      category: product.category ?? undefined,
      subCategory: product.subCategory ?? undefined,
      origin: product.origin ?? undefined,
      dna: toContextDna(product.dna),
    })),
    primaryProductName: products.find(
      (product) => product.name && hasUsableDna(product),
    )?.name,
  };

  // 4. 结构化生成 + 校验（含一次纠错重试）
  const generated = await generateValidatedObject({
    provider,
    system: BRAND_AGENT_SYSTEM_PROMPT,
    prompt: buildBrandAgentPrompt({ context, notes: warnings }),
    schema: BrandProfileSchema,
    tier: AGENT_MODEL_TIER,
    labels: BRAND_PROFILE_FIELD_LABELS,
    requiredKeys: BRAND_AGENT_REQUIRED_KEYS,
    signal: options.signal,
  });

  if (!generated.ok) {
    return { ok: false, error: generated.error };
  }

  // 5. 归一化 + 合规扫描
  const draft = normalizeBrandProfileDraft(generated.data.value);
  const scan = scanBrandRisks(draft, input);
  warnings.push(...scan.warnings);

  /**
   * 把扫描发现的短词条并入档案的 riskNotes，让风险随档案一起留痕
   * （而不是只活在任务记录里，被下一次生成覆盖掉）。
   * 仍然受 `riskNotes` 的字段约束（最多 8 条），因此取前 8 条。
   */
  const mergedRiskNotes = Array.from(
    new Set([...draft.riskNotes, ...scan.notes]),
  ).slice(0, 8);

  // 6. 产出
  return ok({
    draft: { ...draft, riskNotes: mergedRiskNotes },
    providerId: provider.id,
    sourceProductCount: products.length,
    analyzedProductCount: analyzedCount,
    attempts: generated.data.attempts,
    repaired: generated.data.repaired,
    warnings,
  });
}

/** 便捷入口：把领域商品 + Owner Twin 组装成 Agent 输入（服务层用） */
export function toBrandAgentProductInput(input: {
  product: {
    name: string;
    category?: string | null;
    subCategory?: string | null;
    origin?: string | null;
  };
  dna?: {
    coreFeatures: string[];
    sellingPoints: string[];
    targetUsers: string[];
    consumptionScenarios: string[];
    marketingAngles: string[];
    visualFeatures: string[];
  } | null;
}): BrandAgentProductInput {
  return {
    name: input.product.name,
    category: input.product.category ?? null,
    subCategory: input.product.subCategory ?? null,
    origin: input.product.origin ?? null,
    dna: input.dna ?? null,
  };
}

/**
 * 判断依据是否可用。
 * 服务层在**创建任务记录之前**用它做一次前置检查，避免为一次注定失败的调用留下任务记录。
 */
export function hasBrandGrounding(input: BrandAgentInput): boolean {
  const products = input.products ?? [];
  return products.some(hasUsableDna) || hasOwnerMaterial(input.ownerTwin ?? null);
}
