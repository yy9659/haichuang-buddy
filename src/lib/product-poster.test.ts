import { describe, expect, it } from "vitest";
import { getPosterIssue, parsePosterPoints, posterFilename, posterPrice, wrapPosterText, type PosterCopy } from "./product-poster";
import type { ProductPosterSource } from "@/types";

const product: ProductPosterSource = {
  id: "fish-balls", name: "连江手工鱼丸", imageUrl: "/api/product-images/photo.png",
  price: 45, unit: "500g", tags: ["手工制作"], specification: "500g / 袋",
};
const copy: PosterCopy = {
  title: "连江手工鱼丸", subtitle: "一份家常鲜味", sellingPoints: ["500g 家庭装"], cta: "想要的私信我",
};

describe("商品海报的导出条件与排版", () => {
  it("缺少实拍和无效价格不能被当成可下载的海报", () => {
    expect(getPosterIssue({ ...product, imageUrl: null }, copy)).toContain("照片");
    for (const price of [NaN, Infinity, -1]) {
      expect(getPosterIssue({ ...product, price }, copy)).toContain("价格");
    }
    expect(getPosterIssue(product, copy)).toBeNull();
    expect(getPosterIssue({ ...product, price: 0 }, copy)).toBeNull();
  });

  it("超长或过多的卖点应提示修改，不能静默删除商户文字", () => {
    const points = parsePosterPoints("  家庭装\n\n 手工制作\r\n冷冻保存 ");
    expect(points).toEqual(["家庭装", "手工制作", "冷冻保存"]);
    expect(getPosterIssue(product, { ...copy, sellingPoints: [...points, "第四条"] })).toContain("最多");
    expect(getPosterIssue(product, { ...copy, sellingPoints: ["长".repeat(37)] })).toContain("36");
  });

  it("换行保留金额、中文和完整 emoji", () => {
    const text = "鱼丸🐟¥45.00/500g";
    const lines = wrapPosterText(text, 4, (line) => Array.from(line).length);
    expect(lines.join("")).toBe(text);
    expect(lines.every((line) => Array.from(line).length <= 4)).toBe(true);
    expect(posterPrice(45)).toBe("45.00");
    expect(posterPrice(39.9)).toBe("39.90");
  });

  it("导出名可用于 Windows，并包含实际图片尺寸", () => {
    expect(posterFilename('鱼丸/家庭装: "新"', "portrait")).toBe("鱼丸-家庭装- -新--营销海报-1080x1440.png");
    expect(posterFilename("", "square")).toBe("商品-营销海报-1080x1080.png");
  });
});
