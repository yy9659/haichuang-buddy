/**
 * Product Agent —— 第一个 AI Agent（技术文档 Module 3 / 9.2）
 *
 * 输入：商品（名称 / 描述 / 图片）
 * 输出：结构化 Product DNA
 *
 * 执行流程（每一步都可失败、都可观测，全程返回 Result，不抛异常给上层）：
 *
 *   1. 校验输入（Zod）        —— 商品名等关键字段不合法就直接返回 VALIDATION_FAILED
 *   2. 图像理解（可选）        —— 有图片才调用视觉模型；失败**降级**为纯文本推断并记 warning
 *   3. 组装提示词              —— 商品资料 + 视觉结论 + 结构化上下文块（含注入防护）
 *   4. 结构化生成 + 校验       —— Schema 校验失败时把错误回喂模型纠错一次
 *   5. 归一化与事实对齐        —— 去重限长；分类等**业务字段以商品资料为准**，AI 只补空缺
 *   6. 补元数据                —— 生成领域类型 ProductDNA（approved 默认 false，需人工确认）
 *
 * 设计要点：
 * - Agent 不认识具体模型，只依赖 `AIProvider` 接口；S2-2 换成通义千问时本文件零改动。
 * - 「业务事实优先于 AI 猜测」：AI 推断的分类与商品资料冲突时以资料为准，并记录 warning。
 */

import { z } from "zod";

import { getAIProvider } from "@/ai/provider";
import type { AIProvider, ModelTier } from "@/ai/provider/types";
import {
  PRODUCT_AGENT_REQUIRED_KEYS,
  PRODUCT_AGENT_SYSTEM_PROMPT,
  PRODUCT_VISION_SYSTEM_PROMPT,
  buildProductAgentPrompt,
  buildProductVisionPrompt,
  type ProductContext,
} from "@/ai/prompts/product-agent";
import { generateValidatedObject } from "@/ai/schemas/agent-output";
import {
  PRODUCT_DNA_FIELD_LABELS,
  ProductDNASchema,
  normalizeProductDnaDraft,
  toProductDna,
  type ProductDNADraft,
} from "@/ai/schemas/product-dna";
import { attempt, fail, ok, toAppError, type Result } from "@/lib/result";
import { formatIssues } from "@/lib/validation";
import {
  localProductImageFilename,
  readLocalProductImageAsDataUrl,
} from "@/storage/local-product-image";
import type { Product, ProductDNA } from "@/types";

/** Agent 标识，写入 agent_tasks.agentType 用 */
export const PRODUCT_AGENT_ID = "product-agent";
/** 展示名 */
export const PRODUCT_AGENT_NAME = "商品经理 Agent";

/** 结构化推理使用的模型档位（复杂推理档，对应 AI_MODEL_REASONING） */
const AGENT_MODEL_TIER: ModelTier = "reasoning";

/**
 * Agent 输入：商品的最小必要信息。
 * 刻意不含价格/库存等经营数据 —— 它们与「商品理解」无关，放进提示词只会增加噪声。
 */
export interface ProductAgentInput {
  id: string;
  name: string;
  description?: string | null;
  /** 商品图片地址（本地图片路径或 Supabase 公共 URL）；为空则跳过图像理解 */
  imageUrl?: string | null;
  category?: string | null;
  subCategory?: string | null;
  origin?: string | null;
  specification?: string | null;
  tags?: readonly string[] | null;
}

/** 输入校验 Schema：只把真正必要的字段设为必填 */
const productAgentInputSchema = z.object({
  id: z.string().trim().min(1, "商品 ID 不能为空"),
  name: z.string().trim().min(2, "商品名称至少 2 个字").max(60, "商品名称不能超过 60 字"),
  description: z.string().trim().max(2000, "商品描述不能超过 2000 字").optional().default(""),
  imageUrl: z.string().trim().min(1).nullish(),
  category: z.string().trim().max(30).nullish(),
  subCategory: z.string().trim().max(40).nullish(),
  origin: z.string().trim().max(60).nullish(),
  specification: z.string().trim().max(60).nullish(),
  tags: z.array(z.string().trim().min(1)).max(12, "标签最多 12 个").nullish(),
});

const PRODUCT_AGENT_INPUT_LABELS: Record<string, string> = {
  id: "商品 ID",
  name: "商品名称",
  description: "商品描述",
  imageUrl: "商品图片",
  tags: "标签",
};

/** 从领域 `Product` 生成 Agent 输入（页面/服务层调用时的便捷入口） */
export function toProductAgentInput(product: Product): ProductAgentInput {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    imageUrl: product.imageUrl,
    category: product.category,
    subCategory: product.subCategory,
    origin: product.origin,
    specification: product.specification,
    tags: product.tags,
  };
}

export interface ProductAgentRunOptions {
  /** 注入 Provider（测试用）；默认取 `getAIProvider()` */
  provider?: AIProvider;
  /** 跳过图像理解，仅用文字资料推断 */
  skipVision?: boolean;
  signal?: AbortSignal;
}

/** Agent 运行结果：DNA + 可观测性信息（后续写入 agent_tasks） */
export interface ProductAgentRunResult {
  productId: string;
  dna: ProductDNA;
  /** 实际使用的 Provider 标识，便于区分 Mock 与真实模型 */
  providerId: string;
  /** 是否成功用上了图像理解 */
  visionUsed: boolean;
  /** 调用模型的次数（含纠错重试） */
  attempts: number;
  /** 是否经过纠错重试才通过校验 */
  repaired: boolean;
  /** 降级与不一致提示，供上层展示或记录 */
  warnings: string[];
}

/**
 * 用商品资料校正 AI 推断。
 * 规则：**已确认的业务字段优先**，AI 只负责填补资料里的空缺。
 */
function reconcileWithInput(
  draft: ProductDNADraft,
  input: z.infer<typeof productAgentInputSchema>,
  warnings: string[],
): ProductDNADraft {
  const category = input.category?.trim() || draft.category;
  const subcategory = input.subCategory?.trim() || draft.subcategory;

  if (input.category && input.category.trim() !== draft.category) {
    warnings.push(
      `模型推断分类「${draft.category}」与商品资料「${input.category}」不一致，已以资料为准`,
    );
  }
  if (input.subCategory && input.subCategory.trim() !== draft.subcategory) {
    warnings.push(
      `模型推断子类目「${draft.subcategory}」与商品资料「${input.subCategory}」不一致，已以资料为准`,
    );
  }

  return { ...draft, category, subcategory };
}

/** 执行 Product Agent */
export async function runProductAgent(
  rawInput: ProductAgentInput,
  options: ProductAgentRunOptions = {},
): Promise<Result<ProductAgentRunResult>> {
  const warnings: string[] = [];

  // 1. 输入校验
  const parsedInput = productAgentInputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return fail(
      "VALIDATION_FAILED",
      "商品资料不完整，无法进行 AI 分析",
      formatIssues(parsedInput.error, PRODUCT_AGENT_INPUT_LABELS),
    );
  }
  const input = parsedInput.data;

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

  // 3. 图像理解（可选，失败降级）
  let visualNotes: string | null = null;
  let visionUsed = false;
  const imageUrl = input.imageUrl?.trim();

  let imageForVision = imageUrl;
  if (imageForVision && !options.skipVision && localProductImageFilename(imageForVision)) {
    const localImage = await readLocalProductImageAsDataUrl(imageForVision);
    if (localImage.ok) {
      imageForVision = localImage.data;
    } else {
      imageForVision = undefined;
      warnings.push("商品图片暂时无法读取，已改用文字资料分析");
    }
  }

  if (imageForVision && !options.skipVision) {
    const vision = await attempt(() =>
      provider.analyzeImage({
        system: PRODUCT_VISION_SYSTEM_PROMPT,
        prompt: buildProductVisionPrompt({
          name: input.name,
          description: input.description,
        }),
        imageUrls: [imageForVision],
        tier: "vision",
        signal: options.signal,
      }),
    );

    if (vision.ok && vision.data.trim()) {
      visualNotes = vision.data.trim();
      visionUsed = true;
    } else if (!vision.ok) {
      warnings.push(
        `图像理解失败（${vision.error.code}），已降级为纯文字推断：${vision.error.message}`,
      );
    }
  }

  // 4. 组装提示词
  const context: ProductContext = {
    name: input.name,
    description: input.description,
    category: input.category ?? undefined,
    subCategory: input.subCategory ?? undefined,
    origin: input.origin ?? undefined,
    specification: input.specification ?? undefined,
    tags: input.tags ?? undefined,
    // 本地路径与旧 data URL 只在上一步交给视觉模型；文本模型不需要这些地址。
    imageUrls:
      imageUrl && !/^data:image\//i.test(imageUrl) && !localProductImageFilename(imageUrl)
        ? [imageUrl]
        : undefined,
  };

  // 5. 结构化生成 + 校验（含一次纠错重试）
  const generated = await generateValidatedObject({
    provider,
    system: PRODUCT_AGENT_SYSTEM_PROMPT,
    prompt: buildProductAgentPrompt({ context, visualNotes }),
    schema: ProductDNASchema,
    tier: AGENT_MODEL_TIER,
    labels: PRODUCT_DNA_FIELD_LABELS,
    requiredKeys: PRODUCT_AGENT_REQUIRED_KEYS,
    signal: options.signal,
  });

  if (!generated.ok) {
    return { ok: false, error: generated.error };
  }

  // 6. 归一化 + 事实对齐 + 补元数据
  const reconciled = reconcileWithInput(generated.data.value, input, warnings);
  const draft = normalizeProductDnaDraft(reconciled);

  return ok({
    productId: input.id,
    dna: toProductDna(draft, input.id),
    providerId: provider.id,
    visionUsed,
    attempts: generated.data.attempts,
    repaired: generated.data.repaired,
    warnings,
  });
}
