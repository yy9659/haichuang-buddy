import { describe, expect, it } from "vitest";

import {
  PRODUCT_DNA_AI_VERSION,
  ProductDNASchema,
  normalizeProductDnaDraft,
  toNewProductDnaInput,
  toProductDna,
  type ProductDNADraft,
} from "./product-dna";

/** 一份合法的模型输出样本 */
function validDraft(): Record<string, unknown> {
  return {
    category: "海产品",
    subcategory: "鲍鱼",
    visualFeatures: ["外壳完整", "肉质饱满"],
    coreFeatures: ["鲜活冷链", "8-10 头规格"],
    sellingPoints: ["当日现捞", "产地直发"],
    targetUsers: ["家庭主厨", "节庆送礼人群"],
    scenarios: ["家庭聚餐", "节庆宴客"],
    painPoints: ["担心不新鲜", "怕规格虚标"],
    marketingAngles: ["产地溯源", "烹饪教程"],
    riskNotes: ["避免绝对化用语"],
    confidence: 0.8,
  };
}

function parse(input: unknown): ProductDNADraft {
  const result = ProductDNASchema.safeParse(input);
  if (!result.success) {
    throw new Error(`预期校验通过，实际失败：${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}

describe("ProductDNASchema", () => {
  it("接受完整的合法输出", () => {
    const draft = parse(validDraft());
    expect(draft.category).toBe("海产品");
    expect(draft.sellingPoints).toEqual(["当日现捞", "产地直发"]);
    expect(draft.confidence).toBe(0.8);
  });

  it("对格式宽容：字符串列表按中英文分隔符切分", () => {
    const draft = parse({ ...validDraft(), sellingPoints: "当日现捞、产地直发；冷链配送" });
    expect(draft.sellingPoints).toEqual(["当日现捞", "产地直发", "冷链配送"]);
  });

  it("对格式宽容：列表里的非字符串项会被转换并剔除空条目", () => {
    const draft = parse({ ...validDraft(), coreFeatures: ["鲜活", 2026, "  ", null] });
    expect(draft.coreFeatures).toEqual(["鲜活", "2026"]);
  });

  it("对字段缺失严格：缺少必填键必须失败（触发纠错重试）", () => {
    const { sellingPoints: _omitted, ...rest } = validDraft();
    const result = ProductDNASchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("必填列表为空数组时失败，但风险提示允许为空", () => {
    expect(ProductDNASchema.safeParse({ ...validDraft(), targetUsers: [] }).success).toBe(false);
    expect(ProductDNASchema.safeParse({ ...validDraft(), riskNotes: [] }).success).toBe(true);
  });

  it("去掉空白后为空的字符串视为缺失", () => {
    expect(ProductDNASchema.safeParse({ ...validDraft(), category: "   " }).success).toBe(false);
  });

  it("列表超出条数上限时失败", () => {
    const tooMany = Array.from({ length: 9 }, (_, index) => `卖点${index}`);
    expect(ProductDNASchema.safeParse({ ...validDraft(), sellingPoints: tooMany }).success).toBe(false);
  });

  describe("confidence 归一化", () => {
    it("百分制与百分号写法归一为 0~1", () => {
      expect(parse({ ...validDraft(), confidence: "85%" }).confidence).toBeCloseTo(0.85);
      expect(parse({ ...validDraft(), confidence: 85 }).confidence).toBeCloseTo(0.85);
      expect(parse({ ...validDraft(), confidence: 100 }).confidence).toBe(1);
      expect(parse({ ...validDraft(), confidence: "0%" }).confidence).toBe(0);
    });

    it("越界的小数按夹取处理，不会被误当成百分数", () => {
      // 1.8 若按百分制除以 100 会得到 0.018，属于明显错误
      expect(parse({ ...validDraft(), confidence: 1.8 }).confidence).toBe(1);
      expect(parse({ ...validDraft(), confidence: -0.5 }).confidence).toBe(0);
    });

    it("非数值时兜底为 0.5，而不是让整份结果失败", () => {
      expect(parse({ ...validDraft(), confidence: "高" }).confidence).toBe(0.5);
    });
  });
});

describe("normalizeProductDnaDraft", () => {
  it("按忽略大小写去重并保持首次出现顺序", () => {
    const draft = parse({ ...validDraft(), sellingPoints: ["当日现捞", " 当日现捞 ", "产地直发"] });
    expect(normalizeProductDnaDraft(draft).sellingPoints).toEqual(["当日现捞", "产地直发"]);
  });
});

describe("字段映射", () => {
  it("AI 契约字段名映射到仓储输入（唯一改名点）", () => {
    const input = toNewProductDnaInput(parse(validDraft()), "prod_001");

    expect(input.productId).toBe("prod_001");
    expect(input.subCategory).toBe("鲍鱼");
    expect(input.consumptionScenarios).toEqual(["家庭聚餐", "节庆宴客"]);
    expect(input.userPainPoints).toEqual(["担心不新鲜", "怕规格虚标"]);
    expect(input.aiVersion).toBe(PRODUCT_DNA_AI_VERSION);
    expect(input.approved).toBe(false);
  });

  it("补全领域类型 ProductDNA 的元数据", () => {
    const dna = toProductDna(parse(validDraft()), "prod_001", "2026-09-25 12:00");

    expect(dna.productId).toBe("prod_001");
    expect(dna.subCategory).toBe("鲍鱼");
    expect(dna.consumptionScenarios).toEqual(["家庭聚餐", "节庆宴客"]);
    expect(dna.generatedAt).toBe("2026-09-25 12:00");
    expect(dna.approved).toBe(false);
  });

  it("映射结果是拷贝，改动其一不影响另一", () => {
    const draft = parse(validDraft());
    const input = toNewProductDnaInput(draft, "prod_001");
    input.sellingPoints.push("新卖点");
    expect(draft.sellingPoints).toHaveLength(2);
  });
});
