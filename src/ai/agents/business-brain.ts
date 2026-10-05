/**
 * Business Brain —— 经营大脑 / 规划者（S4-1 / 技术文档 Module 6、第 15 章）
 *
 * 输入：一句经营目标 + 可参与规划的商品（含各自是否已有商品理解）+ 品牌档案 / 数字分身状态
 * 输出：结构化 **Business Plan**（任务、执行者、依赖、参数）
 *
 * ⚠️ 本 Agent 的边界（任务书里的硬约束）：**只规划、不执行**。
 * 它不调用 Product / Brand / Content 任何一个 Service，不写任何业务表，
 * 只管把目标拆成计划。执行由 `workflows/business-workflow.ts` 负责 ——
 * 这条分界让「规划」与「执行」可以各自独立测试与替换：
 * 规划质量问题只需要换提示词或模型，执行问题只需要改引擎，互不牵连。
 *
 * 执行流程：
 *   1. 输入校验（Zod）      —— 目标为空 / 一件商品都没有时直接拒绝
 *   2. Provider 解析        —— 未接入的真实提供方在这里明确报错，不静默降级
 *   3. 组装提示词            —— 目标 + 现有状态 + 商品清单 + 结构化上下文块
 *   4. 结构化生成 + 校验     —— Schema 失败由 `generateValidatedObject` 回喂一次纠错
 *   5. **计划合法性自检**     —— 由 `plan-validator` 判定；不合法则把违规清单回喂再试一次
 *   6. 产出计划与可观测信息   —— 落库与执行交给服务层
 *
 * 为什么第 4、5 步是**两层**纠错而不是一层：
 * 它们修的是两类不同的问题。Schema 失败 = 形状不对（漏键、类型错），
 * 模型看见 Zod 错误就能改；计划不合法 = 形状对了但排错了（依赖成环、引用了不存在的商品），
 * 这类问题 Zod 根本看不见，必须由校验器给出「问题清单」才能修。
 * 两层的重试都不做无意义循环：Schema 层限 2 次调用、语义层限 2 轮，
 * 因此单次规划最多 4 次模型调用，用尽后明确报错（不静默返回半成品）。
 */

import { z } from "zod";

import { getAIProvider } from "@/ai/provider";
import type { AIProvider, ModelTier } from "@/ai/provider/types";
import {
  BUSINESS_BRAIN_REQUIRED_KEYS,
  BUSINESS_BRAIN_SYSTEM_PROMPT,
  MAX_CONTEXT_PRODUCTS,
  buildBusinessBrainPrompt,
  type BusinessContext,
} from "@/ai/prompts/business-brain";
import { generateValidatedObject } from "@/ai/schemas/agent-output";
import {
  BUSINESS_PLAN_FIELD_LABELS,
  BusinessPlanSchema,
  PLANNER_AGENT_WHITELIST,
  normalizeBusinessPlanDraft,
  type BusinessPlanDraft,
} from "@/ai/schemas/business-plan";
import { MAX_BUSINESS_GOAL_LENGTH } from "@/lib/business-goal";
import { CONTENT_FORMATS, CONTENT_PLATFORMS } from "@/lib/content-options";
import { fail, ok, toAppError, type Result } from "@/lib/result";
import { formatIssues } from "@/lib/validation";
import type { ContentFormat, ContentPlatform } from "@/types";

import {
  formatPlanViolations,
  validateBusinessPlan,
  type PlanViolation,
} from "../workflows/plan-validator";

/** Agent 标识（运行时），与写入 `agent_tasks.agent_type` 的 `business_brain` 区分开 */
export const BUSINESS_BRAIN_AGENT_ID = "business-brain";
/** 展示名（与 `AGENT_NAME_LABEL.business_brain` 保持一致） */
export const BUSINESS_BRAIN_AGENT_NAME = "AI经营大脑";

/**
 * 规划属于**长链推理**：要读懂目标、判断现有状态够不够、再排出依赖顺序，
 * 因此用 reasoning 档位。这四类任务的档位选择对照如下（按任务性质而非「哪个更强」）：
 * 商品理解（看图 + 归纳）reasoning · 品牌策略（长文本立意）reasoning ·
 * 内容生成（高频轻创作）fast · 经营规划（多步推理）reasoning。
 */
const AGENT_MODEL_TIER: ModelTier = "reasoning";

/**
 * 语义纠错的最大轮数（含首次）。
 * 2 意味着「最多让模型看着违规清单重排一次」。不再多试的理由：
 * 同一份上下文连续两次排出非法计划，问题多半在提示词或模型档位，而不是这一份计划，
 * 继续重试只是花钱重复同一个错误。
 */
const MAX_PLAN_ROUNDS = 2;

/* ------------------------------------------------------------------ */
/* 输入                                                                */
/* ------------------------------------------------------------------ */

/** 参与规划的商品 */
export interface BusinessBrainProductInput {
  id: string;
  name: string;
  category?: string | null;
  /** 是否已有 Product DNA（由调用方查询后传入，Agent 自己不查库） */
  hasDna?: boolean | null;
}

/**
 * 商家在驾驶舱勾选的渠道（S4-2）。
 * 与 `prompts/business-brain.ts` 的 `BusinessContextChannel` 同形，
 * 在这里重复声明是把「Agent 的输入契约」与「提示词上下文的形状」分开 ——
 * 二者将来可能各自演化（例如契约层接受平台 + 缺失形态由提示词补默认）。
 */
export interface BusinessBrainChannelInput {
  platform: ContentPlatform;
  format: ContentFormat;
}

/**
 * Agent 输入。
 *
 * S4-2 新增的三个字段全部可选，因此既有调用方（含 S4-1 的全部测试）
 * 不传它们时的行为与之前**逐字一致**。
 */
export interface BusinessBrainInput {
  /** 商家原话的经营目标 */
  goal: string;
  /** 可参与规划的商品；调用方保证非空 */
  products: readonly BusinessBrainProductInput[];
  hasBrandProfile?: boolean | null;
  hasOwnerTwin?: boolean | null;
  /** 主推商品 id（不在商品清单里时视为未指定） */
  primaryProductId?: string | null;
  /** 商家勾选的渠道；空数组与未指定等价 */
  channels?: readonly BusinessBrainChannelInput[];
  /** 目标人群，可选 */
  targetAudience?: string | null;
  /** 用户明确选择六岗位全链路；已有结果仍要在计划里占位以显示复用。 */
  fullChain?: boolean;
}

const businessBrainInputSchema = z.object({
  /**
   * 上限取 `MAX_BUSINESS_GOAL_LENGTH`（与驾驶舱输入框、与计划的 goal 字段同一个数）。
   * 不在这里放更宽的上限，是因为 Mock 会把这句话**原样回填**进计划，
   * 一旦这里放行、计划的 120 字上限拦下，商家看到的就是一句没头没脑的
   * 「模型输出格式错误」—— 而真正的原因是输入太长。
   */
  goal: z
    .string()
    .trim()
    .min(1, "经营目标不能为空")
    .max(MAX_BUSINESS_GOAL_LENGTH, `经营目标不能超过 ${MAX_BUSINESS_GOAL_LENGTH} 字`),
  products: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(64),
        name: z.string().trim().min(1).max(60),
        category: z.string().trim().max(30).nullish(),
        hasDna: z.boolean().nullish(),
      }),
    )
    .min(1, "至少需要一件商品才能制定经营计划")
    .max(MAX_CONTEXT_PRODUCTS, `一次最多针对 ${MAX_CONTEXT_PRODUCTS} 件商品规划`),
  hasBrandProfile: z.boolean().nullish(),
  hasOwnerTwin: z.boolean().nullish(),
  primaryProductId: z.string().trim().max(64).nullish(),
  /**
   * 渠道用契约里的枚举校验：非法组合在这里就被挡掉，
   * 不会流到提示词里变成一条「看起来像指令」的脏数据。
   * `.default([])` 而不是 `.nullish()`：下游（上下文渲染）需要一个数组，
   * 把 null 归一在这一层，比在每个消费者里各写一次 `?? []` 可靠。
   */
  channels: z
    .array(
      z.object({
        platform: z.enum(CONTENT_PLATFORMS),
        format: z.enum(CONTENT_FORMATS),
      }),
    )
    .max(CONTENT_PLATFORMS.length)
    .default([]),
  targetAudience: z.string().trim().max(60).nullish(),
  fullChain: z.boolean().optional().default(false),
});

const BUSINESS_BRAIN_INPUT_LABELS: Record<string, string> = {
  goal: "经营目标",
  products: "可选商品",
  "products.id": "商品 ID",
  "products.name": "商品名称",
  primaryProductId: "主推商品",
  channels: "目标渠道",
  targetAudience: "目标人群",
};

/**
 * 输入是否足以规划。
 * 服务层在**创建任务记录与工作流之前**用它做一次前置检查，
 * 避免为一次注定失败的调用留下记录（同 `hasContentGrounding` 的做法）。
 */
export function hasPlannableInput(input: BusinessBrainInput): boolean {
  return (
    input.goal.trim().length > 0 &&
    input.products.length > 0 &&
    input.products.every(
      (product) => product.id.trim().length > 0 && product.name.trim().length > 0,
    )
  );
}

/* ------------------------------------------------------------------ */
/* 运行                                                                */
/* ------------------------------------------------------------------ */

export interface BusinessBrainRunOptions {
  /** 注入 Provider（测试用）；默认取 `getAIProvider()` */
  provider?: AIProvider;
  signal?: AbortSignal;
}

/** Agent 运行结果：计划 + 可观测性信息（服务层据此写 agent_workflows / agent_tasks） */
export interface BusinessBrainRunResult {
  plan: BusinessPlanDraft;
  /** 实际使用的 Provider 标识，便于区分 Mock 与真实模型 */
  providerId: string;
  /** 调用模型的次数（含两层纠错重试） */
  attempts: number;
  /** 语义纠错经历了几轮（1 = 首次就通过合法性校验） */
  planRounds: number;
  /** 是否经过任意一层纠错才成功 */
  repaired: boolean;
  /** 规划过程中的提示（如「第 1 版计划依赖成环，已回喂修正」） */
  warnings: string[];
}

/** 把输入商品裁到上限内，并归一成上下文形状 */
function toContextProducts(
  products: readonly BusinessBrainProductInput[],
): BusinessContext["products"] {
  return products.slice(0, MAX_CONTEXT_PRODUCTS).map((product) => ({
    id: product.id,
    name: product.name,
    category: product.category ?? undefined,
    hasDna: product.hasDna === true,
  }));
}

/** 执行 Business Brain */
export async function runBusinessBrain(
  rawInput: BusinessBrainInput,
  options: BusinessBrainRunOptions = {},
): Promise<Result<BusinessBrainRunResult>> {
  const warnings: string[] = [];

  // 1. 输入校验
  const parsed = businessBrainInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      "VALIDATION_FAILED",
      "经营规划参数不完整，无法制定计划",
      formatIssues(parsed.error, BUSINESS_BRAIN_INPUT_LABELS),
    );
  }
  const input = parsed.data;

  /**
   * 主推商品必须落在清单内，否则视为未指定。
   * 校验放在这里（而不是只依赖调用方）：`primaryProductId` 会被写进提示词，
   * 一个指向不存在商品的 id 会让模型去排一件它读不到的商品，
   * 进而被计划校验器拒掉 —— 与其让它绕一圈失败，不如在这里降级为「未指定」。
   */
  const contextProducts = toContextProducts(input.products);
  const primaryProductId =
    input.primaryProductId &&
    contextProducts.some((product) => product.id === input.primaryProductId)
      ? input.primaryProductId
      : null;

  const context: BusinessContext = {
    goal: input.goal,
    products: contextProducts,
    hasBrandProfile: input.hasBrandProfile === true,
    hasOwnerTwin: input.hasOwnerTwin === true,
    primaryProductId,
    channels: input.channels,
    targetAudience: input.targetAudience ?? null,
    fullChain: input.fullChain,
  };

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

  /**
   * 商品 id 快照：必须在**开始规划之前**固定下来。
   * 若改成「校验时再查一次库」，商家在规划过程中删掉一件商品，
   * 就会让一份本来合法的计划突然变成非法 —— 那不是模型排错了，
   * 是上下文变了。用快照，计划与它成立的那一刻绑定。
   */
  const availableProductIds = context.products.map((product) => product.id);

  let prompt = buildBusinessBrainPrompt({ context });
  let totalAttempts = 0;
  let round = 0;
  let lastViolations: PlanViolation[] = [];

  // 3 ~ 5. 生成 → 校验 → （不合法则）回喂纠错
  while (round < MAX_PLAN_ROUNDS) {
    round += 1;

    const generated = await generateValidatedObject({
      provider,
      system: BUSINESS_BRAIN_SYSTEM_PROMPT,
      prompt,
      schema: BusinessPlanSchema,
      tier: AGENT_MODEL_TIER,
      labels: BUSINESS_PLAN_FIELD_LABELS,
      requiredKeys: BUSINESS_BRAIN_REQUIRED_KEYS,
      signal: options.signal,
    });

    if (!generated.ok) {
      // 结构层用尽重试 → 如实透传（SCHEMA_INVALID），不伪造一份计划出来
      return { ok: false, error: generated.error };
    }
    totalAttempts += generated.data.attempts;

    const draft = normalizeBusinessPlanDraft(generated.data.value);
    const validation = validateBusinessPlan(draft, {
      availableProductIds,
      requiredAgents: input.fullChain ? PLANNER_AGENT_WHITELIST : [],
    });

    if (validation.ok) {
      return ok({
        plan: draft,
        providerId: provider.id,
        attempts: totalAttempts,
        planRounds: round,
        repaired: round > 1 || generated.data.repaired,
        warnings,
      });
    }

    lastViolations = validation.violations;
    const codes = validation.violations.map((violation) => violation.code);

    if (round < MAX_PLAN_ROUNDS) {
      warnings.push(
        `第 ${round} 版计划未通过合法性校验（${codes.join("、")}），已把问题回喂给模型重新排布。`,
      );
      prompt = buildBusinessBrainPrompt({
        context,
        violations: formatPlanViolations(validation.violations),
      });
    }
  }

  // 6. 两轮都排出非法计划 → 明确失败，把问题清单带出去给商家看
  const missingRequiredAgent = lastViolations.some(
    (violation) => violation.code === "MISSING_REQUIRED_AGENT",
  );
  return fail(
    "PLAN_INVALID",
    missingRequiredAgent
      ? "六岗位计划未能覆盖全部岗位，请重新制定计划"
      : `连续 ${MAX_PLAN_ROUNDS} 次生成的计划都无法执行`,
    formatPlanViolations(lastViolations).join("；"),
  );
}
