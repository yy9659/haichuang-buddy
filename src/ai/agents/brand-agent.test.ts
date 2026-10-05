/**
 * Brand Agent 单测（S3-1 Task 7）
 *
 * 覆盖的是**流程边界**，不是「函数能跑」：
 *   - 正常路径产出的 draft 必须能通过契约、并带上可观测信息（attempts / repaired / warnings）；
 *   - 脏 JSON 能自愈一次，连续脏输出给出明确的 SCHEMA_INVALID（而不是白屏）；
 *   - 模型超时/不可用**直接透传错误码**，不做无意义重试；
 *   - **没有任何依据时直接拒绝** —— 这是本 Agent 最重要的一条纪律：
 *     没有 Product DNA 也没有 Owner Profile，模型只能凭空编一份品牌故事。
 */

import { describe, expect, it } from "vitest";

import { createMockAIProvider, MOCK_OUTPUT_MARKER } from "@/ai/provider/mock";

import {
  MAX_BRAND_SOURCE_PRODUCTS,
  hasBrandGrounding,
  runBrandAgent,
  scanBrandRisks,
  type BrandAgentInput,
} from "./brand-agent";

/** 一份「依据充分」的输入：有 Owner Profile + 两个商品 DNA */
function groundedInput(): BrandAgentInput {
  return {
    business: {
      id: "biz_demo_001",
      name: "连江海创海产商贸",
      shortName: "海创海产",
      owner: "陈老板",
      location: "福建省福州市连江县黄岐半岛",
      mainCategory: "连江海产品",
      channels: ["抖音小店", "视频号"],
    },
    ownerTwin: {
      displayName: "陈老板",
      avatarLabel: "陈",
      businessPhilosophy: ["真实", "诚信", "新鲜"],
      tone: ["亲切", "自然", "不夸张"],
      salesStyle: "专业介绍，不强迫消费",
      targetCustomers: ["年轻家庭", "品质消费者", "节庆礼赠人群"],
      forbiddenExpressions: ["绝对第一", "全网最低"],
    },
    primaryProductId: "prod_001",
    products: [
      {
        name: "连江鲜活鲍鱼",
        category: "海产品",
        subCategory: "鲍鱼",
        origin: "福建连江 · 黄岐半岛",
        dna: {
          coreFeatures: ["品类归属：海产品 · 鲍鱼", "产地：福建连江 · 黄岐半岛"],
          sellingPoints: ["当日现捞、肉质弹牙", "产地直发减少中间环节"],
          targetUsers: ["注重食材新鲜度的家庭主厨"],
          consumptionScenarios: ["家庭日常三餐", "节庆聚餐"],
          marketingAngles: ["产地溯源：从连江海域到餐桌"],
          visualFeatures: ["鲜活带壳，壳面洁净"],
        },
      },
      {
        name: "连江头水坛紫菜",
        category: "干货",
        subCategory: "紫菜",
        origin: "福建连江 · 马鼻镇",
        dna: {
          coreFeatures: ["头水采摘，叶片完整"],
          sellingPoints: ["冲泡即食，方便"],
          targetUsers: ["上班族"],
          consumptionScenarios: ["早餐配汤"],
          marketingAngles: ["头水紫菜的稀缺性"],
          visualFeatures: ["叶片完整，色泽深绿"],
        },
      },
    ],
  };
}

describe("runBrandAgent：正常路径", () => {
  it("产出可通过契约的品牌 draft，并带回可观测信息", async () => {
    const result = await runBrandAgent(groundedInput(), {
      provider: createMockAIProvider(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const run = result.data;

    expect(run.providerId).toBe("mock");
    expect(run.attempts).toBe(1);
    expect(run.repaired).toBe(false);
    expect(run.sourceProductCount).toBe(2);
    expect(run.analyzedProductCount).toBe(2);

    expect(run.draft.brandPositioning.length).toBeGreaterThan(0);
    expect(run.draft.brandStory.length).toBeGreaterThan(0);
    expect(run.draft.brandValues.length).toBeGreaterThan(0);
    expect(run.draft.targetAudience.length).toBeGreaterThan(0);
    expect(run.draft.visualDirection.length).toBeGreaterThan(0);

    // 依据充分（都有 DNA + 有 Owner Profile）→ 不应产生依据缺口告警
    expect(run.warnings.join()).not.toContain("尚未建立老板数字分身");
    expect(run.warnings.join()).not.toContain("没有任何商品完成 AI 分析");
  });

  it("Mock 产出必须自带占位标记，避免被当成真实品牌结论", async () => {
    const result = await runBrandAgent(groundedInput(), {
      provider: createMockAIProvider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.draft.riskNotes.some((note) => note.includes("【Mock】"))).toBe(
      true,
    );
    expect(MOCK_OUTPUT_MARKER).toContain("【Mock】");
  });

  it("同一输入两次调用结果全等（Mock 必须确定性）", async () => {
    const first = await runBrandAgent(groundedInput(), {
      provider: createMockAIProvider(),
    });
    const second = await runBrandAgent(groundedInput(), {
      provider: createMockAIProvider(),
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.data.draft).toEqual(second.data.draft);
  });
});

describe("runBrandAgent：依据缺口", () => {
  it("部分商品没有 DNA 时告警，但仍在已分析商品上完成生成", async () => {
    const input = groundedInput();
    const products = input.products ?? [];
    const result = await runBrandAgent(
      {
        ...input,
        products: [...products, { name: "连江手工鱼丸", origin: "福建连江 · 苔菉镇" }],
      },
      { provider: createMockAIProvider() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.sourceProductCount).toBe(3);
    expect(result.data.analyzedProductCount).toBe(2);
    expect(result.data.warnings.join()).toContain("其余商品的卖点未纳入本次品牌推导");
  });

  it("完全没有商品 DNA 时告警「仅基于老板数字分身」", async () => {
    const result = await runBrandAgent(
      {
        business: { name: "连江海创海产商贸", location: "福建省福州市连江县黄岐半岛" },
        ownerTwin: {
          displayName: "陈老板",
          avatarLabel: "陈",
          businessPhilosophy: ["真实"],
          tone: ["亲切"],
          salesStyle: "专业介绍",
          targetCustomers: ["年轻家庭"],
          forbiddenExpressions: [],
        },
        products: [{ name: "连江手工鱼丸" }],
      },
      { provider: createMockAIProvider() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.analyzedProductCount).toBe(0);
    expect(result.data.warnings.join()).toContain("没有任何商品完成 AI 分析");
  });

  it("既没有商品 DNA 也没有 Owner Profile 时直接拒绝，且不触达模型", async () => {
    // 用 always-invalid 场景：若真的调了模型，错误码就不是 VALIDATION_FAILED
    const result = await runBrandAgent(
      {
        business: { name: "连江海创海产商贸" },
        ownerTwin: null,
        products: [{ name: "连江手工鱼丸" }],
      },
      { provider: createMockAIProvider({ scenario: "always-invalid" }) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.detail).toContain("AI 分析商品");
  });

  it("hasBrandGrounding 与 Agent 的判据保持一致", () => {
    expect(hasBrandGrounding(groundedInput())).toBe(true);
    expect(
      hasBrandGrounding({
        business: { name: "连江海创海产商贸" },
        products: [{ name: "连江手工鱼丸" }],
      }),
    ).toBe(false);
    expect(
      hasBrandGrounding({
        business: { name: "连江海创海产商贸" },
        ownerTwin: {
          displayName: "陈老板",
          avatarLabel: "陈",
          businessPhilosophy: ["真实"],
          tone: [],
          salesStyle: "",
          targetCustomers: [],
          forbiddenExpressions: [],
        },
      }),
    ).toBe(true);
  });
});

describe("runBrandAgent：输入校验", () => {
  it("商家名缺失时返回 VALIDATION_FAILED", async () => {
    const result = await runBrandAgent(
      { business: { name: " " }, ownerTwin: groundedInput().ownerTwin },
      { provider: createMockAIProvider() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it(`商品数超过 ${MAX_BRAND_SOURCE_PRODUCTS} 个时拒绝，避免提示词被淹没`, async () => {
    const result = await runBrandAgent(
      {
        ...groundedInput(),
        products: Array.from({ length: MAX_BRAND_SOURCE_PRODUCTS + 1 }, (_, index) => ({
          name: `商品${index}`,
        })),
      },
      { provider: createMockAIProvider() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.detail).toContain("最多只能基于");
  });
});

describe("runBrandAgent：模型失败与纠错", () => {
  it("脏 JSON 自愈一次：attempts=2 且 repaired=true", async () => {
    const result = await runBrandAgent(groundedInput(), {
      provider: createMockAIProvider({ scenario: "messy-then-ok" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.attempts).toBe(2);
    expect(result.data.repaired).toBe(true);
  });

  it("连续脏输出用尽重试后返回 SCHEMA_INVALID", async () => {
    const result = await runBrandAgent(groundedInput(), {
      provider: createMockAIProvider({ scenario: "always-invalid" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SCHEMA_INVALID");
  });

  it("模型不可用时直接透传 MODEL_UNAVAILABLE，不做无意义重试", async () => {
    const result = await runBrandAgent(groundedInput(), {
      provider: createMockAIProvider({ scenario: "unavailable" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MODEL_UNAVAILABLE");
  });

  it("模型超时时返回 MODEL_TIMEOUT", async () => {
    const result = await runBrandAgent(groundedInput(), {
      provider: createMockAIProvider({ scenario: "timeout" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MODEL_TIMEOUT");
  });
});

describe("scanBrandRisks：事实与合规扫描", () => {
  const input = {
    business: {
      id: "biz_1",
      name: "连江海创海产商贸",
      shortName: null,
      owner: null,
      location: "福建省福州市连江县黄岐半岛",
      mainCategory: "连江海产品",
      channels: null,
    },
    ownerTwin: {
      displayName: "陈老板",
      avatarLabel: "陈",
      businessPhilosophy: [],
      tone: [],
      salesStyle: "",
      targetCustomers: [],
      forbiddenExpressions: ["全网最低"],
    },
    products: [
      { name: "连江鲜活鲍鱼", category: null, subCategory: null, origin: "福建连江 · 黄岐半岛" },
    ],
  };

  /** 只填扫描关心的字段，其余给最小合法值 */
  function draftWith(overrides: Record<string, unknown>) {
    return {
      brandPositioning: "海产供应者",
      brandStory: "从产地到餐桌。",
      slogan: "新鲜到家。",
      ipConcept: "以老板为原型的内容 IP。",
      brandValues: ["真实"],
      targetAudience: ["家庭"],
      brandKeywords: ["实在"],
      tone: ["自然"],
      visualDirection: ["海雾蓝"],
      riskNotes: [],
      confidence: 0.5,
      ...overrides,
    } as never;
  }

  it("输入资料里没有的产地被判为疑似虚构，并同时产出短词条与长说明", () => {
    const scan = scanBrandRisks(
      draftWith({ brandStory: "我们的海产源自大连深海，也供应舟山带鱼。" }),
      input,
    );

    expect(scan.notes.some((note) => note.includes("大连"))).toBe(true);
    expect(scan.notes.some((note) => note.includes("舟山"))).toBe(true);
    expect(scan.warnings.join()).toContain("疑似虚构产地");
    // 短词条必须满足 riskNotes 的单条长度约束
    for (const note of scan.notes) {
      expect(note.length).toBeLessThanOrEqual(40);
    }
  });

  it("输入里确实出现过的产地不算虚构", () => {
    const scan = scanBrandRisks(
      draftWith({ brandStory: "我们在福建连江黄岐半岛经营海产。" }),
      input,
    );
    expect(scan.warnings.join()).not.toContain("疑似虚构产地");
  });

  it("绝对化用语被判为合规风险", () => {
    const scan = scanBrandRisks(
      draftWith({ slogan: "全网最低价，100% 纯天然无污染" }),
      input,
    );
    expect(scan.notes.some((note) => note.includes("绝对化用语"))).toBe(true);
    expect(scan.warnings.join()).toContain("广告法合规风险");
  });

  it("命中老板数字分身的禁用表达时单独告警", () => {
    const scan = scanBrandRisks(
      draftWith({ brandPositioning: "全网最低的海产直供" }),
      input,
    );
    expect(scan.notes.some((note) => note.includes("命中禁用表达：全网最低"))).toBe(true);
    expect(scan.warnings.join()).toContain("必须改写");
  });

  it("干净文案不产生任何风险提示", () => {
    const scan = scanBrandRisks(
      draftWith({ brandStory: "在黄岐半岛靠海吃海，把真实差异讲清楚。" }),
      input,
    );
    expect(scan.notes).toEqual([]);
    expect(scan.warnings).toEqual([]);
  });
});
