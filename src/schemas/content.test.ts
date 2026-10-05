/**
 * 内容工厂查询参数解析单测（S3-2 Task 7）
 *
 * 这组测试盯的是**「手改地址栏会不会把页面弄崩」**：
 * URL 是用户可以直接编辑的输入，任何拼错的值都必须退回默认槽位，
 * 而不是让 `/content` 直接 500。同时要保证「合法值不被吞掉」——
 * 一个把 `platform=wechat` 悄悄变成默认抖音的解析器同样是 bug。
 */

import { describe, expect, it } from "vitest";

import { parseContentSlotQuery } from "./content";

describe("parseContentSlotQuery", () => {
  it("缺省参数全部返回空串（由服务层补默认槽位）", () => {
    expect(parseContentSlotQuery()).toEqual({
      productId: "",
      platform: "",
      format: "",
    });
  });

  it("合法参数原样透传", () => {
    expect(
      parseContentSlotQuery({
        productId: "prod_001",
        platform: "wechat",
        format: "article",
      }),
    ).toEqual({
      productId: "prod_001",
      platform: "wechat",
      format: "article",
    });
  });

  it("非法平台 / 形态退回空串，而不是抛错或替用户改选", () => {
    const parsed = parseContentSlotQuery({
      productId: "prod_001",
      platform: "kuaishou",
      format: "podcast",
    });
    expect(parsed.platform).toBe("");
    expect(parsed.format).toBe("");
    // 商品 id 不受影响
    expect(parsed.productId).toBe("prod_001");
  });

  it("大小写敏感：Douyin 不是一个合法的平台值", () => {
    expect(parseContentSlotQuery({ platform: "Douyin" }).platform).toBe("");
  });

  it("同一参数重复出现时取第一个值", () => {
    expect(
      parseContentSlotQuery({ platform: ["xiaohongshu", "douyin"] }).platform,
    ).toBe("xiaohongshu");
  });

  it("商品 id 超长被拦下（退回空串 → 服务层用首件商品兜底）", () => {
    const parsed = parseContentSlotQuery({ productId: "x".repeat(80) });
    expect(parsed.productId).toBe("");
  });

  it("商品 id 两侧空白被裁掉", () => {
    expect(parseContentSlotQuery({ productId: "  prod_001  " }).productId).toBe(
      "prod_001",
    );
  });

  it("非字符串类型（数组为空 / 数字）不会抛错", () => {
    expect(
      parseContentSlotQuery({
        productId: [],
        platform: [],
        format: [],
      }),
    ).toEqual({ productId: "", platform: "", format: "" });
  });
});
