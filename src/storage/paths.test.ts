/**
 * 存储路径规则的单测（纯函数，不需要任何凭证）
 *
 * 这些规则是「能上传就一定能删掉」的前提：上传时生成路径，
 * 删除时从 URL 反推路径，两边必须严格互逆。
 */

import { describe, expect, it } from "vitest";

import {
  ALLOWED_PRODUCT_IMAGE_TYPES,
  MAX_PRODUCT_IMAGE_BYTES,
  PRODUCT_IMAGE_BUCKET,
  buildProductImagePath,
  buildProductImagePublicUrl,
  isInlineProductImageUrl,
  isAllowedProductImageType,
  parseProductImagePath,
  resolveProductImageExtension,
  toPathSlug,
} from "./paths";

const PROJECT_URL = "https://demo-project.supabase.co";

describe("类型与大小限制", () => {
  it("Bucket 名称与前端约定一致", () => {
    expect(PRODUCT_IMAGE_BUCKET).toBe("product-images");
  });

  it("允许常见的图片类型（大小写不敏感）", () => {
    expect(isAllowedProductImageType("image/png")).toBe(true);
    expect(isAllowedProductImageType("IMAGE/JPEG")).toBe(true);
    expect(isAllowedProductImageType("image/webp")).toBe(true);
    expect(isAllowedProductImageType("image/gif")).toBe(false);
    expect(isAllowedProductImageType("application/pdf")).toBe(false);
  });

  it("白名单键与 Storage 上传统一为小写 MIME", () => {
    for (const key of Object.keys(ALLOWED_PRODUCT_IMAGE_TYPES)) {
      expect(key).toBe(key.toLowerCase());
    }
    expect(MAX_PRODUCT_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });

  it("扩展名优先取 MIME，其次才是文件名", () => {
    expect(resolveProductImageExtension("image/jpeg")).toBe("jpg");
    expect(resolveProductImageExtension("image/webp")).toBe("webp");
    // 浏览器偶尔上报 octet-stream，此时退回文件名
    expect(resolveProductImageExtension("application/octet-stream", "a.PNG")).toBe(
      "png",
    );
    expect(resolveProductImageExtension("", "noext")).toBe("jpg");
  });
});

describe("toPathSlug", () => {
  it("英文名转为短横线形式", () => {
    expect(toPathSlug("Lianjiang Abalone")).toBe("lianjiang-abalone");
  });

  it("中文名整体丢弃，回落为 product（避免 URL 里出现百分号转义）", () => {
    expect(toPathSlug("连江鲜活鲍鱼")).toBe("product");
    expect(toPathSlug("")).toBe("product");
    expect(toPathSlug("!!!")).toBe("product");
  });

  it("长度受限且不留首尾短横线", () => {
    const slug = toPathSlug("a".repeat(80));
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug.startsWith("-")).toBe(false);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("buildProductImagePath", () => {
  it("按 年月 分目录，并带唯一后缀", () => {
    const path = buildProductImagePath({
      name: "Lianjiang Abalone",
      extension: "png",
      now: new Date("2026-09-25T10:00:00Z"),
    });
    expect(path).toMatch(/^products\/2026\/09\/lianjiang-abalone-[a-z0-9]+\.png$/);
  });

  it("同一商品连续上传不会互相覆盖", () => {
    const first = buildProductImagePath({ name: "abalone", extension: "png" });
    const second = buildProductImagePath({ name: "abalone", extension: "png" });
    expect(first).not.toBe(second);
  });
});

describe("buildProductImagePublicUrl / parseProductImagePath", () => {
  it("拼接公开 URL，忽略项目地址结尾多余的斜杠", () => {
    expect(
      buildProductImagePublicUrl(PROJECT_URL, "products/2026/09/a.png"),
    ).toBe(
      "https://demo-project.supabase.co/storage/v1/object/public/product-images/products/2026/09/a.png",
    );
    expect(buildProductImagePublicUrl(`${PROJECT_URL}/`, "a.png")).toContain(
      "/public/product-images/a.png",
    );
  });

  it("从公共 URL 反推出存储路径（上传与删除互逆）", () => {
    const path = "products/2026/09/鲍鱼-lianjiang.png";
    const url = buildProductImagePublicUrl(PROJECT_URL, path);
    expect(parseProductImagePath(url)).toBe(path);
  });

  it("也接受裸存储路径", () => {
    expect(parseProductImagePath("products/2026/09/a.png")).toBe(
      "products/2026/09/a.png",
    );
    expect(parseProductImagePath("/products/2026/09/a.png")).toBe(
      "products/2026/09/a.png",
    );
  });

  it("无法识别（第三方图床 / 空值）时返回 null，调用方应跳过删除", () => {
    expect(parseProductImagePath("https://cdn.example.com/a.png")).toBeNull();
    expect(parseProductImagePath("")).toBeNull();
    expect(parseProductImagePath("   ")).toBeNull();
  });
});

describe("本地内联图片", () => {
  it("只识别受支持 MIME 的 base64 data URL", () => {
    expect(isInlineProductImageUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isInlineProductImageUrl("data:image/jpeg;base64,AAAA")).toBe(true);
    expect(isInlineProductImageUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isInlineProductImageUrl("https://cdn.example.com/a.png")).toBe(false);
  });
});
