/**
 * Brand Profile Schema 单测（S3-1 Task 7）
 *
 * 这组测试盯的是**契约边界**，而不是「字段能填进去」：
 *   - 对格式宽容：模型把列表写成 `"亲切、实在"` 也要能过 → 否则会无谓地触发纠错重试；
 *   - 对字段缺失严格：缺键必须失败 → 否则脏结果会静默补空数组蒙混过关；
 *   - 改名只在一处：AI 契约名（brandKeywords / tone / visualDirection）
 *     与领域名（brandPersonality / toneOfVoice / visualKeywords）的映射必须完整且不串位。
 */

import { describe, expect, it } from "vitest";

import {
  BRAND_PROFILE_AI_VERSION,
  BRAND_PROFILE_FIELD_LABELS,
  BrandProfileSchema,
  normalizeBrandProfileDraft,
  toBrandProfile,
  toNewBrandProfileInput,
  type BrandProfileDraft,
} from "./brand-profile";

/** 一份完整合法的模型输出（各用例在此基础上做变形） */
function validDraft(): Record<string, unknown> {
  return {
    brandPositioning: "连江黄岐半岛直发 · 家庭海鲜餐桌的稳定供应者",
    brandStory:
      "陈老板在连江黄岐半岛长大，家里靠海吃海。过去海产靠批发商收走，价格和故事都由别人讲；现在他决定自己讲，把当日到货的鲍鱼与海带按最直白的方式送到家庭餐桌上。",
    slogan: "从黄岐半岛，到你的餐桌。",
    ipConcept: "以老板本人为原型的内容 IP，用分拣现场与家庭烹饪两个场景持续输出可核实的内容。",
    brandValues: ["产地真实可查", "当天到货的新鲜", "不夸张的表达"],
    targetAudience: ["25-40 岁年轻家庭", "节庆礼赠人群"],
    brandKeywords: ["实在", "专业", "有海边的松弛感"],
    tone: ["口语化", "像邻居介绍一样自然"],
    visualDirection: ["海雾蓝", "晨光", "鲜活质感"],
    riskNotes: [],
    confidence: 0.72,
  };
}

describe("BrandProfileSchema：格式宽容", () => {
  it("列表字段写成中文分隔符字符串也能通过", () => {
    const parsed = BrandProfileSchema.safeParse({
      ...validDraft(),
      brandValues: "产地真实可查、当天到货的新鲜；不夸张的表达",
      tone: "口语化,自然",
      visualDirection: "海雾蓝\n晨光\n鲜活质感",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.brandValues).toEqual([
      "产地真实可查",
      "当天到货的新鲜",
      "不夸张的表达",
    ]);
    expect(parsed.data.tone).toEqual(["口语化", "自然"]);
    expect(parsed.data.visualDirection).toEqual(["海雾蓝", "晨光", "鲜活质感"]);
  });

  it("数组里的非字符串项被转成字符串并剔除空条目", () => {
    const parsed = BrandProfileSchema.safeParse({
      ...validDraft(),
      brandValues: ["真实", 2026, null, "  ", "新鲜"],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.brandValues).toEqual(["真实", "2026", "新鲜"]);
  });

  it("confidence 支持 0.72 / 72 / \"72%\" 三种写法", () => {
    const normalize = (value: unknown): number | undefined => {
      const parsed = BrandProfileSchema.safeParse({ ...validDraft(), confidence: value });
      return parsed.success ? parsed.data.confidence : undefined;
    };

    expect(normalize(0.72)).toBeCloseTo(0.72);
    expect(normalize(72)).toBeCloseTo(0.72);
    expect(normalize("72%")).toBeCloseTo(0.72);
  });

  it("confidence 非数值时兜底 0.5，不让单个字段拖垮整份结果", () => {
    const parsed = BrandProfileSchema.safeParse({ ...validDraft(), confidence: "高" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.confidence).toBe(0.5);
  });

  it("riskNotes 允许为空数组（「没发现风险」是合法结论）", () => {
    const parsed = BrandProfileSchema.safeParse({ ...validDraft(), riskNotes: [] });
    expect(parsed.success).toBe(true);
  });
});

describe("BrandProfileSchema：字段缺失严格", () => {
  it.each([
    "brandPositioning",
    "brandStory",
    "slogan",
    "ipConcept",
    "brandValues",
    "targetAudience",
    "brandKeywords",
    "tone",
    "visualDirection",
  ])("缺少 %s 时校验必须失败（触发纠错，而不是静默补空）", (key) => {
    const draft = validDraft();
    delete draft[key];
    expect(BrandProfileSchema.safeParse(draft).success).toBe(false);
  });

  it("必填列表为空数组时校验失败", () => {
    expect(
      BrandProfileSchema.safeParse({ ...validDraft(), brandValues: [] }).success,
    ).toBe(false);
  });

  it("短文本超长时校验失败（品牌定位 > 120 字）", () => {
    expect(
      BrandProfileSchema.safeParse({
        ...validDraft(),
        brandPositioning: "定".repeat(121),
      }).success,
    ).toBe(false);
  });

  it("列表条数超过上限时校验失败", () => {
    expect(
      BrandProfileSchema.safeParse({
        ...validDraft(),
        visualDirection: Array.from({ length: 9 }, (_, index) => `关键词${index}`),
      }).success,
    ).toBe(false);
  });
});

describe("normalizeBrandProfileDraft", () => {
  it("去重（忽略大小写与空白）并保持首次出现顺序", () => {
    const draft = BrandProfileSchema.parse({
      ...validDraft(),
      brandValues: ["真实", "真实", " 真实 ", "新鲜"],
    });
    const normalized = normalizeBrandProfileDraft(draft);
    expect(normalized.brandValues).toEqual(["真实", "新鲜"]);
  });

  it("裁掉超出单条长度上限的内容", () => {
    const draft = BrandProfileSchema.parse({
      ...validDraft(),
      tone: ["口".repeat(39)],
    });
    const normalized = normalizeBrandProfileDraft(draft);
    expect(normalized.tone[0]).toHaveLength(39);
  });
});

describe("字段标签", () => {
  it("契约里的每个键都有中文标签（用于纠错提示与界面展示）", () => {
    const draft = validDraft();
    for (const key of Object.keys(draft)) {
      expect(BRAND_PROFILE_FIELD_LABELS[key as keyof BrandProfileDraft]).toBeTruthy();
    }
    expect(Object.keys(BRAND_PROFILE_FIELD_LABELS).sort()).toEqual(
      Object.keys(draft).sort(),
    );
  });
});

describe("契约 → 领域 / 仓储 的映射", () => {
  const draft = normalizeBrandProfileDraft(BrandProfileSchema.parse(validDraft()));

  it("改名只发生在这三处，且不串位", () => {
    const input = toNewBrandProfileInput(draft, { sourceProductId: "prod_001" });

    expect(input.positioning).toBe(draft.brandPositioning);
    expect(input.brandPersonality).toEqual(draft.brandKeywords);
    expect(input.toneOfVoice).toEqual(draft.tone);
    expect(input.visualKeywords).toEqual(draft.visualDirection);
    expect(input.brandStory).toBe(draft.brandStory);
    expect(input.slogan).toBe(draft.slogan);
    expect(input.ipConcept).toBe(draft.ipConcept);
  });

  it("AI 产出恒为未确认，且带上契约版本号", () => {
    const input = toNewBrandProfileInput(draft, {});
    expect(input.approved).toBe(false);
    expect(input.aiVersion).toBe(BRAND_PROFILE_AI_VERSION);
  });

  it("未指定 businessId 时不写入该键（交由仓储解析当前商家）", () => {
    const input = toNewBrandProfileInput(draft, {});
    expect("businessId" in input).toBe(false);
    expect(input.sourceProductId).toBeNull();
  });

  it("列表字段是拷贝而不是引用（避免调用方后续改动污染已保存档案）", () => {
    const input = toNewBrandProfileInput(draft, {});
    expect(input.brandValues).not.toBe(draft.brandValues);
    expect(input.brandValues).toEqual(draft.brandValues);
  });

  it("toBrandProfile 只搬运字段，completeness 由调用方传入", () => {
    const profile = toBrandProfile(draft, {
      updatedAt: "2026-09-25 20:00",
      completeness: 0.8,
    });
    expect(profile.completeness).toBe(0.8);
    expect(profile.updatedAt).toBe("2026-09-25 20:00");
    expect(profile.approved).toBe(false);
    expect(profile.riskNotes).toEqual(draft.riskNotes);
  });
});
