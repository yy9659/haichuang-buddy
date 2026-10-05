import { describe, expect, it } from "vitest";
import { createPosterPreviewDesign, PosterCompositionSchema, starterComposition } from "./poster-design";

describe("海报自由布局的安全区", () => {
  it("初始排版的区域互不遮挡，且完整保留图片和文案", () => {
    for (const layout of ["editorial", "showcase", "split"] as const) {
      expect(PosterCompositionSchema.safeParse(starterComposition(layout)).success).toBe(true);
    }
  });
  it("模型不能把文字放到图片上，也不能把价格移出画布", () => {
    const composition = starterComposition("editorial");
    expect(PosterCompositionSchema.safeParse({ ...composition, title: composition.photo }).success).toBe(false);
    expect(PosterCompositionSchema.safeParse({ ...composition, price: { ...composition.price, x: 950 } }).success).toBe(false);
    expect(PosterCompositionSchema.safeParse({ ...composition, headlineSize: 1000 }).success).toBe(false);
  });
  it("初始预览响应创意建议与商户选择，不伪称模型产出", () => {
    const copy = { title: "家常鱼丸", subtitle: "好好吃顿晚饭", sellingPoints: ["手工制作"], cta: "来店选购" };
    const preview = createPosterPreviewDesign(copy, "温馨餐桌，商品实拍大图");
    expect(preview.palette.background).toBe("#fff6e9");
    expect(preview.layout).toBe("showcase");
    expect(preview.rationale).toContain("初始预览");
    const override = createPosterPreviewDesign(copy, "温馨餐桌，商品实拍大图", "ocean");
    expect(override.palette.background).toBe("#102e45");
  });
});
