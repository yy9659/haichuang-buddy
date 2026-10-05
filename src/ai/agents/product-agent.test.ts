import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import type { AIProvider } from "@/ai/provider/types";
import { resetServerEnvCache } from "@/lib/env";
import {
  readLocalProductImageAsDataUrl,
  removeLocalProductImage,
  saveLocalProductImage,
} from "@/storage/local-product-image";
import type { Product } from "@/types";

import { runProductAgent, toProductAgentInput, type ProductAgentInput } from "./product-agent";

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

/** 可注入单点行为的假 Provider，用于精确构造降级与不一致场景 */
function stubProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  const base: AIProvider = {
    id: "stub",
    async generateText() {
      throw new Error("generateText 未被期望调用");
    },
    async generateObject<T>(): Promise<T> {
      throw new Error("generateObject 未被期望调用");
    },
    async streamText() {
      throw new Error("streamText 未被期望调用");
    },
    async analyzeImage() {
      throw new Error("analyzeImage 未被期望调用");
    },
    async embed() {
      throw new Error("embed 未被期望调用");
    },
  };
  return { ...base, ...overrides };
}

/** 一段合法的 Product DNA JSON 文本 */
function draftJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    category: "海产品",
    subcategory: "鲍鱼",
    visualFeatures: ["外壳完整"],
    coreFeatures: ["鲜活冷链"],
    sellingPoints: ["当日现捞"],
    targetUsers: ["家庭主厨"],
    scenarios: ["家庭聚餐"],
    painPoints: ["担心不新鲜"],
    marketingAngles: ["产地溯源"],
    riskNotes: [],
    confidence: 0.7,
    ...overrides,
  });
}

const baseInput: ProductAgentInput = {
  id: "prod_001",
  name: "连江鲜活鲍鱼",
  description: "当日现捞打包，肉质厚实弹牙。",
  category: "海产品",
  subCategory: "鲍鱼",
  origin: "福建连江 · 黄岐半岛",
  tags: ["鲜活", "当日现捞"],
};

const sampleProduct: Product = {
  id: "prod_001",
  name: "连江鲜活鲍鱼",
  description: "当日现捞打包，肉质厚实弹牙。",
  category: "海产品",
  subCategory: "鲍鱼",
  price: 128,
  unit: "500g",
  stock: 86,
  origin: "福建连江 · 黄岐半岛",
  specification: "8-10 头 / 500g",
  storageMethod: "0-4℃ 冷藏",
  shelfLife: "鲜活产品，建议 2 天内烹饪",
  imageUrl: null,
  analysisStatus: "pending",
  updatedAt: "2026-09-25 10:24",
  metrics: { views: 12000, inquiries: 2340, conversions: 368 },
  tags: ["鲜活", "当日现捞"],
};

describe("toProductAgentInput", () => {
  it("从领域 Product 提取分析所需的字段", () => {
    const input = toProductAgentInput(sampleProduct);
    expect(input).toMatchObject({
      id: "prod_001",
      name: "连江鲜活鲍鱼",
      category: "海产品",
      subCategory: "鲍鱼",
      imageUrl: null,
    });
    // 经营数据不进入提示词
    expect(Object.keys(input)).not.toContain("price");
    expect(Object.keys(input)).not.toContain("stock");
  });
});

describe("runProductAgent 正常路径", () => {
  it("用 Mock Provider 产出结构完整的 Product DNA", async () => {
    const result = await runProductAgent(baseInput, { provider: createMockAIProvider() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.productId).toBe("prod_001");
    expect(result.data.providerId).toBe("mock");
    expect(result.data.visionUsed).toBe(false);
    expect(result.data.attempts).toBe(1);
    expect(result.data.repaired).toBe(false);
    expect(result.data.warnings).toEqual([]);

    const { dna } = result.data;
    expect(dna.category).toBe("海产品");
    expect(dna.subCategory).toBe("鲍鱼");
    expect(dna.sellingPoints.length).toBeGreaterThan(0);
    expect(dna.consumptionScenarios.length).toBeGreaterThan(0);
    expect(dna.userPainPoints.length).toBeGreaterThan(0);
    expect(dna.confidence).toBeGreaterThan(0);
    expect(dna.confidence).toBeLessThanOrEqual(1);
    // AI 产出必须等待人工确认
    expect(dna.approved).toBe(false);
    expect(dna.aiVersion).toBeTruthy();
    expect(dna.generatedAt).toBeTruthy();
  });

  it("有图片时启用图像理解", async () => {
    const result = await runProductAgent(
      { ...baseInput, imageUrl: "https://example.com/abalone.png" },
      { provider: createMockAIProvider() },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.visionUsed).toBe(true);
      expect(result.data.warnings).toEqual([]);
    }
  });

  it("本地内联图片只提交给视觉模型，不把 base64 重复塞进文本 Prompt", async () => {
    const inlineImage = `data:image/png;base64,${"A".repeat(2048)}`;
    let generatedPrompt = "";

    const result = await runProductAgent(
      { ...baseInput, imageUrl: inlineImage },
      {
        provider: stubProvider({
          async analyzeImage(input) {
            expect(input.imageUrls).toEqual([inlineImage]);
            return "可见鲜活鲍鱼与简洁包装";
          },
          async generateText(input) {
            generatedPrompt = input.prompt;
            return draftJson();
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(generatedPrompt).not.toContain(inlineImage);
    expect(generatedPrompt).toContain("可见鲜活鲍鱼与简洁包装");
  });

  it("本地文件图片在调用视觉模型时才转换为 data URL", async () => {
    const saved = await saveLocalProductImage({
      data: new Uint8Array([1, 2, 3, 4]),
      contentType: "image/png",
      name: "连江鲜活鲍鱼",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    try {
      const image = await readLocalProductImageAsDataUrl(saved.data.url);
      expect(image.ok).toBe(true);
      if (!image.ok) return;
      let generatedPrompt = "";
      const result = await runProductAgent(
        { ...baseInput, imageUrl: saved.data.url },
        {
          provider: stubProvider({
            async analyzeImage(input) {
              expect(input.imageUrls).toEqual([image.data]);
              return "包装完整";
            },
            async generateText(input) {
              generatedPrompt = input.prompt;
              return draftJson();
            },
          }),
        },
      );

      expect(result.ok).toBe(true);
      expect(generatedPrompt).not.toContain(saved.data.url);
      expect(generatedPrompt).toContain("包装完整");
    } finally {
      await removeLocalProductImage(saved.data.url);
    }
  });

  it("skipVision 时即使有图片也不调用视觉模型", async () => {
    const result = await runProductAgent(
      { ...baseInput, imageUrl: "https://example.com/abalone.png" },
      { provider: createMockAIProvider(), skipVision: true },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.visionUsed).toBe(false);
    }
  });

  it("脏输出经过纠错重试后成功，并记录重试次数", async () => {
    const result = await runProductAgent(baseInput, {
      provider: createMockAIProvider({ scenario: "messy-then-ok" }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.attempts).toBe(2);
      expect(result.data.repaired).toBe(true);
    }
  });
});

describe("runProductAgent 失败与降级", () => {
  it("商品资料不合法时返回 VALIDATION_FAILED 且不调用模型", async () => {
    const result = await runProductAgent(
      { id: "prod_001", name: "鲍" },
      { provider: stubProvider() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.detail).toContain("商品名称");
    }
  });

  it("图像理解失败时降级为纯文字推断，并给出 warning", async () => {
    const result = await runProductAgent(
      { ...baseInput, imageUrl: "https://example.com/abalone.png" },
      {
        provider: stubProvider({
          async generateText() {
            return draftJson();
          },
          async analyzeImage() {
            throw Object.assign(new Error("视觉模型超时"), { name: "AppError" });
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.visionUsed).toBe(false);
      expect(result.data.warnings).toHaveLength(1);
      expect(result.data.warnings[0]).toContain("图像理解失败");
    }
  });

  it("连续脏输出时返回 SCHEMA_INVALID", async () => {
    const result = await runProductAgent(baseInput, {
      provider: createMockAIProvider({ scenario: "always-invalid" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCHEMA_INVALID");
    }
  });

  it("模型超时时返回 MODEL_TIMEOUT", async () => {
    const result = await runProductAgent(baseInput, {
      provider: createMockAIProvider({ scenario: "timeout" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODEL_TIMEOUT");
    }
  });

  it("未注入 Provider 且配置了尚未接入的提供方时明确报错", async () => {
    process.env.AI_PROVIDER = "openai";
    resetServerEnvCache();

    const result = await runProductAgent(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_IMPLEMENTED");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("未注入 Provider 且真实模型缺少凭证时明确报错，**不会**用 Mock 顶替", async () => {
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.AI_API_KEY;
    process.env.AI_PROVIDER = "dashscope";
    resetServerEnvCache();

    const result = await runProductAgent(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.message).toContain("通义千问");
    }
  });
});

describe("runProductAgent 事实对齐", () => {
  it("业务字段以商品资料为准，并记录不一致 warning", async () => {
    const result = await runProductAgent(
      { ...baseInput, category: "干货", subCategory: "紫菜" },
      {
        provider: stubProvider({
          async generateText() {
            return draftJson({ category: "预制菜", subcategory: "即食" });
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.dna.category).toBe("干货");
    expect(result.data.dna.subCategory).toBe("紫菜");
    expect(result.data.warnings).toHaveLength(2);
    expect(result.data.warnings.join(" ")).toContain("以资料为准");
  });

  it("商品资料空缺时采用模型推断的分类", async () => {
    const result = await runProductAgent(
      { id: "prod_001", name: "连江鲜活鲍鱼" },
      {
        provider: stubProvider({
          async generateText() {
            return draftJson({ category: "海产品", subcategory: "鲍鱼" });
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dna.category).toBe("海产品");
      expect(result.data.dna.subCategory).toBe("鲍鱼");
      expect(result.data.warnings).toEqual([]);
    }
  });
});
