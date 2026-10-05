import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EMBEDDING_DIMENSIONS, cosineSimilarity } from "@/lib/embedding";
import { resetServerEnvCache } from "@/lib/env";
import { AppError } from "@/lib/result";

import {
  BRAND_AGENT_SYSTEM_PROMPT,
  buildBrandAgentPrompt,
} from "@/ai/prompts/brand-agent";
import { PRODUCT_AGENT_SYSTEM_PROMPT, buildProductAgentPrompt } from "@/ai/prompts/product-agent";
import { BrandProfileSchema } from "@/ai/schemas/brand-profile";
import { ProductDNASchema } from "@/ai/schemas/product-dna";

import { getAIProvider } from "./index";
import { MOCK_OUTPUT_MARKER, createMockAIProvider } from "./mock";

const ORIGINAL_AI_PROVIDER = process.env.AI_PROVIDER;
const ORIGINAL_DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const ORIGINAL_AI_API_KEY = process.env.AI_API_KEY;

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  delete process.env.AI_PROVIDER;
  resetServerEnvCache();
});

afterEach(() => {
  restoreEnvVar("AI_PROVIDER", ORIGINAL_AI_PROVIDER);
  restoreEnvVar("DASHSCOPE_API_KEY", ORIGINAL_DASHSCOPE_API_KEY);
  restoreEnvVar("AI_API_KEY", ORIGINAL_AI_API_KEY);
  resetServerEnvCache();
});

const structuredPrompt = buildProductAgentPrompt({
  context: {
    name: "连江鲜活鲍鱼",
    description: "当日现捞的鲜活鲍鱼",
    category: "海产品",
    subCategory: "鲍鱼",
    tags: ["鲜活"],
  },
});

/**
 * 品牌结构化提示词（S3-1）：含 `<<<BRAND_CONTEXT>>>` 块，
 * Mock 应当据此产出 Brand Profile 候选，而不是复用 Product DNA 的形状。
 */
const brandStructuredPrompt = buildBrandAgentPrompt({
  context: {
    business: {
      name: "连江海创海产商贸",
      shortName: "海创海产",
      location: "福建省福州市连江县黄岐半岛",
      mainCategory: "连江海产品",
    },
    ownerTwin: {
      displayName: "陈老板",
      avatarLabel: "陈",
      businessPhilosophy: ["真实", "新鲜"],
      tone: ["亲切", "不夸张"],
      salesStyle: "专业介绍",
      targetCustomers: ["年轻家庭"],
      forbiddenExpressions: ["全网最低"],
    },
    products: [
      {
        name: "连江鲜活鲍鱼",
        category: "海产品",
        subCategory: "鲍鱼",
        origin: "福建连江 · 黄岐半岛",
        dna: {
          coreFeatures: ["品类归属：海产品 · 鲍鱼"],
          sellingPoints: ["当日现捞、肉质弹牙"],
          targetUsers: ["家庭主厨"],
          consumptionScenarios: ["家庭日常三餐"],
          marketingAngles: ["产地溯源"],
          visualFeatures: ["鲜活带壳，壳面洁净"],
        },
      },
    ],
  },
});

describe("getAIProvider", () => {
  it("未配置 AI_PROVIDER 时使用 Mock", () => {
    expect(getAIProvider().id).toBe("mock");
  });

  it("显式配置 mock 时使用 Mock", () => {
    process.env.AI_PROVIDER = "mock";
    resetServerEnvCache();
    expect(getAIProvider().id).toBe("mock");
  });

  it("AI_PROVIDER=dashscope 时启用通义千问（S2-2 起已接入）", () => {
    process.env.AI_PROVIDER = "dashscope";
    process.env.DASHSCOPE_API_KEY = "sk-test";
    resetServerEnvCache();

    expect(getAIProvider().id).toBe("dashscope");
  });

  it("dashscope 缺 Key 时明确报 VALIDATION_FAILED，而不是静默降级为 Mock", () => {
    // 清掉所有 Key 来源，否则本机 .env.local 会让这条断言失效
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.AI_API_KEY;
    process.env.AI_PROVIDER = "dashscope";
    resetServerEnvCache();

    let caught: unknown;
    try {
      getAIProvider();
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain("DASHSCOPE_API_KEY");
  });

  it("配置了尚未接入的提供方时明确报错，而不是静默降级", () => {
    process.env.AI_PROVIDER = "openai";
    resetServerEnvCache();

    let caught: unknown;
    try {
      getAIProvider();
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_IMPLEMENTED");
    expect((caught as AppError).retryable).toBe(false);
    // 提示里要写清楚现在有哪些可用选项
    expect((caught as AppError).detail).toContain("dashscope");
  });
});

describe("Mock Provider 结构化输出", () => {
  it("识别到结构化上下文块时返回可被 Schema 接受的对象", async () => {
    const provider = createMockAIProvider();
    const raw = await provider.generateText({
      system: PRODUCT_AGENT_SYSTEM_PROMPT,
      prompt: structuredPrompt,
    });

    const parsed = ProductDNASchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subcategory).toBe("鲍鱼");
      expect(parsed.data.riskNotes).toContain(MOCK_OUTPUT_MARKER);
      expect(parsed.data.confidence).toBeLessThan(0.5);
    }
  });

  it("没有上下文块时按自由文本处理（视觉描述）", async () => {
    const provider = createMockAIProvider();
    const text = await provider.generateText({
      system: "视觉",
      prompt: "请分析商品「连江鲜活鲍鱼」的图片。",
    });

    expect(text).toContain("连江鲜活鲍鱼");
    expect(text.split("\n").length).toBeGreaterThan(1);
    expect(() => JSON.parse(text)).toThrow();
  });

  it("同样的输入得到同样的输出（确定性）", async () => {
    const first = await createMockAIProvider().generateText({
      system: PRODUCT_AGENT_SYSTEM_PROMPT,
      prompt: structuredPrompt,
    });
    const second = await createMockAIProvider().generateText({
      system: PRODUCT_AGENT_SYSTEM_PROMPT,
      prompt: structuredPrompt,
    });
    expect(first).toBe(second);
  });

  it("generateObject 对不合规的候选值抛 SCHEMA_INVALID", async () => {
    const provider = createMockAIProvider({ scenario: "always-invalid" });

    await expect(
      provider.generateObject({
        system: PRODUCT_AGENT_SYSTEM_PROMPT,
        prompt: structuredPrompt,
        schema: ProductDNASchema,
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });
});

describe("Mock Provider：品牌结构化输出（S3-1）", () => {
  it("识别 <<<BRAND_CONTEXT>>> 块并产出可通过 BrandProfileSchema 的候选", async () => {
    const provider = createMockAIProvider();
    const raw = await provider.generateText({
      system: BRAND_AGENT_SYSTEM_PROMPT,
      prompt: brandStructuredPrompt,
    });

    const parsed = BrandProfileSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
  });

  it("只使用输入里真实存在的信息，不编造产地", async () => {
    const provider = createMockAIProvider();
    const raw = await provider.generateText({
      system: BRAND_AGENT_SYSTEM_PROMPT,
      prompt: brandStructuredPrompt,
    });
    const draft = JSON.parse(raw) as { brandPositioning: string; slogan: string };

    // 产地来自主依据商品 → 文案里应体现它
    expect(draft.brandPositioning).toContain("黄岐半岛");
    // 输入里没有的产地绝不能出现
    expect(JSON.stringify(draft)).not.toContain("大连");
    expect(JSON.stringify(draft)).not.toContain("挪威");
  });

  it("另一位商家的品牌草稿不继承演示商家的渔港、直发和家庭定位", async () => {
    const prompt = buildBrandAgentPrompt({ context: {
      business: { name: "林姐干货店", shortName: "林姐干货", description: "在宁德经营海产干货，介绍每批商品的规格。", mainCategory: "海产干货" },
      ownerTwin: { displayName: "林姐", avatarLabel: "林", businessPhilosophy: ["如实说明"], tone: ["朴素"], salesStyle: "不催单", targetCustomers: ["家庭采购"], forbiddenExpressions: [] },
      products: [{ name: "干海带", category: "干货", origin: "", dna: null }],
    } });
    const raw = await createMockAIProvider().generateText({ system: BRAND_AGENT_SYSTEM_PROMPT, prompt });
    const draft = JSON.parse(raw) as { brandStory: string; brandPositioning: string; visualDirection: string[] };
    expect(draft.brandStory).toContain("林姐干货店");
    expect(draft.brandStory).toContain("介绍每批商品的规格");
    expect(draft.brandPositioning).toContain("家庭采购");
    expect(JSON.stringify(draft)).not.toMatch(/渔港|直发|当天到货|三代传承/);
  });

  it("产出带 Mock 占位标记，且同一输入两次结果全等", async () => {
    const provider = createMockAIProvider();
    const first = await provider.generateText({
      system: BRAND_AGENT_SYSTEM_PROMPT,
      prompt: brandStructuredPrompt,
    });
    const second = await provider.generateText({
      system: BRAND_AGENT_SYSTEM_PROMPT,
      prompt: brandStructuredPrompt,
    });

    expect(first).toBe(second);
    expect(first).toContain(MOCK_OUTPUT_MARKER);
  });

  it("品牌请求与商品请求互不串台：同一 Provider 两种提示词各产出各的形状", async () => {
    const provider = createMockAIProvider();

    const productRaw = await provider.generateText({
      system: PRODUCT_AGENT_SYSTEM_PROMPT,
      prompt: structuredPrompt,
    });
    const brandRaw = await provider.generateText({
      system: BRAND_AGENT_SYSTEM_PROMPT,
      prompt: brandStructuredPrompt,
    });

    const product = JSON.parse(productRaw) as Record<string, unknown>;
    const brand = JSON.parse(brandRaw) as Record<string, unknown>;

    // 商品候选有 sellingPoints，品牌候选有 brandPositioning —— 各归各
    expect(product).toHaveProperty("sellingPoints");
    expect(product).not.toHaveProperty("brandPositioning");
    expect(brand).toHaveProperty("brandPositioning");
    expect(brand).not.toHaveProperty("sellingPoints");
  });
});

describe("Mock Provider 图像理解", () => {
  it("有图片时返回确定性的可见内容描述", async () => {
    const provider = createMockAIProvider();
    const text = await provider.analyzeImage({
      system: "视觉",
      prompt: "请分析商品「连江鲜活鲍鱼」的图片。",
      imageUrls: ["https://example.com/a.png"],
    });

    expect(text).toContain("连江鲜活鲍鱼");
    expect(text).toContain("单张图片");
  });

  it("没有图片时抛 VALIDATION_FAILED", async () => {
    const provider = createMockAIProvider();

    await expect(
      provider.analyzeImage({ system: "视觉", prompt: "分析图片", imageUrls: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("Mock Provider 其它能力", () => {
  it("streamText 拼接后等于完整文本", async () => {
    const provider = createMockAIProvider();
    const stream = await provider.streamText({ system: "s", prompt: structuredPrompt });

    const reader = stream.getReader();
    let collected = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      collected += value;
    }

    expect(collected).toBe(
      await createMockAIProvider().generateText({ system: "s", prompt: structuredPrompt }),
    );
  });

  /**
   * S5 起 Mock 必须真的产出向量。
   *
   * 原因不是「顺手实现一下」：Mock 模式要跑通完整的 RAG 链路
   * （切片 → 向量 → 检索 → 依据判定），如果 embed 抛 NOT_IMPLEMENTED，
   * Mock 模式下的客服 Agent 就永远答不上任何问题 ——
   * 于是「零凭证也能演示」这个前提直接失效。
   *
   * 任务书第七节允许 hash-based deterministic vector，但要求明确：
   * **Mock 向量不代表真实语义质量**（它是词袋哈希，不是语义空间）。
   */
  it("embed 输出确定性向量，同一文本每次逐位相同", async () => {
    const provider = createMockAIProvider();
    const [first] = await provider.embed({ values: ["鲍鱼怎么保存？"] });
    const [second] = await provider.embed({ values: ["鲍鱼怎么保存？"] });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).toEqual(second);
  });

  it("embed 输出 1024 维且全为有限数，与数据库列 vector(1024) 对齐", async () => {
    const [vector] = await createMockAIProvider().embed({
      values: ["连江鲜活鲍鱼 0-4℃ 冷藏 48 小时"],
    });

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vector.every((value) => Number.isFinite(value))).toBe(true);
  });

  it("embed 让相关文本比无关文本更接近（否则检索排序失去意义）", async () => {
    const provider = createMockAIProvider();
    const [query, related, unrelated] = await provider.embed({
      values: [
        "鲍鱼怎么保存",
        "鲜活鲍鱼储存说明：最佳保存温度为 0-4℃ 冷藏，建议 48 小时内食用。",
        "礼盒装适合送礼，内含干贝与花胶。",
      ],
    });

    expect(query).toBeDefined();
    expect(related).toBeDefined();
    expect(unrelated).toBeDefined();

    const relatedScore = cosineSimilarity(query!, related!);
    const unrelatedScore = cosineSimilarity(query!, unrelated!);
    expect(relatedScore).toBeGreaterThan(unrelatedScore);
  });

  it("embed 空数组返回空数组；空文本明确报错而不是产出无意义向量", async () => {
    const provider = createMockAIProvider();
    await expect(provider.embed({ values: [] })).resolves.toEqual([]);

    await expect(provider.embed({ values: ["  "] })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("timeout / unavailable 场景抛出对应错误码", async () => {
    await expect(
      createMockAIProvider({ scenario: "timeout" }).generateText({ system: "s", prompt: "x" }),
    ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });

    await expect(
      createMockAIProvider({ scenario: "unavailable" }).generateText({ system: "s", prompt: "x" }),
    ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });
});
