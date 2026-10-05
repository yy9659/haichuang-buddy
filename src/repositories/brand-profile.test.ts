/**
 * 品牌档案共享纯规则单测
 *
 * 为什么这些规则值得单独测：Mock 与数据库两套仓储都调用它们，
 * 一旦算法漂移，就会出现「切到 db 后完整度数字变了」这类最难查的问题。
 *
 * `MOCK_BRAND_PROFILE` 在这里作为 fixture 使用 —— 它已经不是 Mock 数据源的初始值
 * （品牌档案改为真实生成，初始为 null），保留下来正是为了给这组测试
 * 与展示组件提供一份「完整档案长什么样」的参考样例。
 */

import { describe, expect, it } from "vitest";

import { MOCK_BRAND_PROFILE } from "@/lib/mock";
import type { BrandProfile } from "@/types";

import {
  applyBrandProfilePatch,
  computeBrandCompleteness,
  toBrandProfile,
} from "./brand-profile";
import type { NewBrandProfileInput } from "./types";

function baseInput(): NewBrandProfileInput {
  return {
    positioning: "连江直发 · 家庭海鲜餐桌的稳定供应者",
    brandStory: "从渔港到餐桌，把可核查的细节讲清楚。",
    slogan: "从黄岐半岛，到你的餐桌。",
    ipConcept: "以老板本人为原型的内容 IP。",
    brandValues: ["产地真实可查", "当天到货的新鲜"],
    targetAudience: ["年轻家庭"],
    brandPersonality: ["实在"],
    toneOfVoice: ["口语化"],
    visualKeywords: ["海雾蓝"],
    riskNotes: [],
    sourceProductId: null,
    aiVersion: "v1.0",
    confidence: 0.6,
    approved: false,
  };
}

describe("computeBrandCompleteness", () => {
  it("空档案完整度为 0", () => {
    expect(
      computeBrandCompleteness({
        positioning: "",
        brandStory: "",
        slogan: "",
        ipConcept: "",
        brandValues: [],
        targetAudience: [],
        brandPersonality: [],
        toneOfVoice: [],
        visualKeywords: [],
      }),
    ).toBe(0);
  });

  it("内容越丰满完整度越高（同一份档案的两种写法）", () => {
    const thin = computeBrandCompleteness({
      positioning: "卖海鲜",
      brandStory: "很好吃",
      slogan: "新鲜",
      ipConcept: "老板",
      brandValues: ["真实"],
      targetAudience: ["家庭"],
      brandPersonality: ["实在"],
      toneOfVoice: ["自然"],
      visualKeywords: ["蓝色"],
    });
    const rich = computeBrandCompleteness({
      ...MOCK_BRAND_PROFILE,
    });

    expect(thin).toBeGreaterThan(0);
    expect(rich).toBeGreaterThan(thin);
  });

  it("达到参考尺度即满分，超过不再加分（避免堆字刷完整度）", () => {
    const fat = computeBrandCompleteness({
      positioning: "定".repeat(200),
      brandStory: "事".repeat(2000),
      slogan: "语".repeat(200),
      ipConcept: "概".repeat(500),
      brandValues: ["A", "B", "C", "D", "E", "F", "G", "H"],
      targetAudience: ["A", "B", "C", "D", "E"],
      brandPersonality: ["A", "B", "C", "D"],
      toneOfVoice: ["A", "B", "C", "D"],
      visualKeywords: ["A", "B", "C", "D"],
    });
    expect(fat).toBe(1);
  });

  it("结果保留两位小数，不出现浮点尾巴", () => {
    const value = computeBrandCompleteness(MOCK_BRAND_PROFILE);
    expect(Number.isFinite(value)).toBe(true);
    expect(String(value)).toMatch(/^\d(\.\d{1,2})?$/);
  });

  it("完整度只看内容，不看风险提示与确认状态", () => {
    const withRisks = computeBrandCompleteness({
      ...MOCK_BRAND_PROFILE,
      brandValues: ["A", "B", "C", "D"],
      targetAudience: ["A", "B", "C", "D"],
      brandPersonality: ["A", "B", "C", "D"],
      toneOfVoice: ["A", "B", "C", "D"],
      visualKeywords: ["A", "B", "C", "D"],
      positioning: "定".repeat(30),
      brandStory: "事".repeat(200),
      slogan: "语".repeat(20),
      ipConcept: "概".repeat(80),
    });
    const withoutRisks = computeBrandCompleteness({
      ...MOCK_BRAND_PROFILE,
      brandValues: ["A", "B", "C", "D"],
      targetAudience: ["A", "B", "C", "D"],
      brandPersonality: ["A", "B", "C", "D"],
      toneOfVoice: ["A", "B", "C", "D"],
      visualKeywords: ["A", "B", "C", "D"],
      positioning: "定".repeat(30),
      brandStory: "事".repeat(200),
      slogan: "语".repeat(20),
      ipConcept: "概".repeat(80),
    });
    expect(withRisks).toBe(withoutRisks);
  });
});

describe("toBrandProfile", () => {
  it("由入参现算完整度，且不接受外部写死", () => {
    const profile = toBrandProfile(baseInput(), { updatedAt: "2026-09-25 20:00" });
    expect(profile.completeness).toBe(
      computeBrandCompleteness(baseInput()),
    );
    expect(profile.updatedAt).toBe("2026-09-25 20:00");
    expect(profile.approved).toBe(false);
    expect(profile.aiVersion).toBe("v1.0");
  });

  it("列表字段是拷贝，改原数组不影响已生成的档案", () => {
    const input = baseInput();
    const profile = toBrandProfile(input, { updatedAt: "2026-09-25 20:00" });
    input.brandValues.push("后来加的");
    expect(profile.brandValues).toEqual(["产地真实可查", "当天到货的新鲜"]);
  });
});

describe("applyBrandProfilePatch", () => {
  const current: BrandProfile = {
    ...MOCK_BRAND_PROFILE,
    brandValues: [...MOCK_BRAND_PROFILE.brandValues],
    targetAudience: [...MOCK_BRAND_PROFILE.targetAudience],
    brandPersonality: [...MOCK_BRAND_PROFILE.brandPersonality],
    toneOfVoice: [...MOCK_BRAND_PROFILE.toneOfVoice],
    visualKeywords: [...MOCK_BRAND_PROFILE.visualKeywords],
    riskNotes: [...MOCK_BRAND_PROFILE.riskNotes],
  };

  it("只覆盖显式传入的字段", () => {
    const next = applyBrandProfilePatch(
      current,
      { positioning: "新定位" },
      { updatedAt: "2026-09-25 21:00" },
    );
    expect(next.positioning).toBe("新定位");
    expect(next.slogan).toBe(current.slogan);
    expect(next.brandStory).toBe(current.brandStory);
    expect(next.brandValues).toEqual(current.brandValues);
    expect(next.updatedAt).toBe("2026-09-25 21:00");
  });

  it("空补丁也会刷新 updatedAt 并重算完整度", () => {
    const next = applyBrandProfilePatch(current, {}, { updatedAt: "2026-09-25 22:00" });
    expect(next.updatedAt).toBe("2026-09-25 22:00");
    expect(next.completeness).toBe(computeBrandCompleteness(current));
  });

  it("列表补丁是拷贝，不与被覆盖的数组共享引用", () => {
    const patchValues = ["新价值一", "新价值二"];
    const next = applyBrandProfilePatch(
      current,
      { brandValues: patchValues },
      { updatedAt: "2026-09-25 22:00" },
    );
    patchValues.push("事后追加");
    expect(next.brandValues).toEqual(["新价值一", "新价值二"]);
  });

  it("可以清空风险提示（审核后风险已消除是正常场景）", () => {
    const next = applyBrandProfilePatch(
      current,
      { riskNotes: [] },
      { updatedAt: "2026-09-25 22:00" },
    );
    expect(next.riskNotes).toEqual([]);
  });

  it("approved 可被商家确认改写，且不影响完整度", () => {
    const before = applyBrandProfilePatch(
      current,
      { approved: false },
      { updatedAt: "2026-09-25 22:00" },
    );
    const after = applyBrandProfilePatch(
      current,
      { approved: true },
      { updatedAt: "2026-09-25 22:00" },
    );
    expect(before.completeness).toBe(after.completeness);
    expect(after.approved).toBe(true);
  });
});
