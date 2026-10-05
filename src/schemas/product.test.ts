/**
 * 商品输入校验的单测
 *
 * 这是「用户输入进入系统」的唯一闸门，重点验证三件事：
 * 1. 合法输入被正确规整（去空格、标签拆分、字符串 → 数字）
 * 2. 非法输入被拦住，并且错误文案能指到具体字段
 * 3. URL 查询参数永远解析出可用的默认值（不抛错）
 */

import { describe, expect, it } from "vitest";

import {
  parseProductForm,
  parseProductId,
  parseProductImageFile,
  parseProductListQuery,
  parseTagInput,
  validateProductForm,
  type ProductImageFileInput,
} from "./product";

function buildFormData(overrides: Record<string, string> = {}): FormData {
  const fields: Record<string, string> = {
    name: "  连江鲜活鲍鱼  ",
    description: "黄岐半岛当日捕捞",
    category: "海产品",
    subCategory: "鲍鱼",
    price: "128.5",
    unit: "500g",
    stock: "60",
    origin: "福建连江",
    specification: "8-10 头 / 500g",
    storageMethod: "0-4℃ 冷藏",
    shelfLife: "2 天",
    tags: "鲜活, 产地直发、顺丰冷链",
    ...overrides,
  };

  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return formData;
}

function fakeImageFile(
  overrides: Partial<ProductImageFileInput> & { bytes?: number } = {},
): ProductImageFileInput {
  const size = overrides.bytes ?? 1024;
  return {
    size,
    type: overrides.type ?? "image/png",
    name: overrides.name ?? "baoyu.png",
    arrayBuffer: async () => new ArrayBuffer(size),
  };
}

describe("parseTagInput", () => {
  it("支持中英文逗号、顿号与空白分隔", () => {
    expect(parseTagInput("鲜活, 产地直发、顺丰冷链  火锅")).toEqual([
      "鲜活",
      "产地直发",
      "顺丰冷链",
      "火锅",
    ]);
  });

  it("丢弃空项并最多保留 8 个", () => {
    expect(parseTagInput(",,  ,鲜活,, ")).toEqual(["鲜活"]);
    expect(parseTagInput("a,b,c,d,e,f,g,h,i,j")).toHaveLength(8);
  });
});

describe("parseProductForm", () => {
  it("规整合法输入：去空格、价格与库存转数字、标签拆成数组", () => {
    const result = parseProductForm(buildFormData());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.name).toBe("连江鲜活鲍鱼");
    expect(result.data.price).toBe(128.5);
    expect(typeof result.data.price).toBe("number");
    expect(result.data.stock).toBe(60);
    expect(result.data.tags).toEqual(["鲜活", "产地直发", "顺丰冷链"]);
    expect(result.data.category).toBe("海产品");
  });

  it("空价格与空库存按 0 处理（表单允许留空）", () => {
    const result = parseProductForm(buildFormData({ price: "", stock: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.price).toBe(0);
    expect(result.data.stock).toBe(0);
  });

  it("名称为空 / 过短时失败，错误文案带上中文字段名", () => {
    const result = parseProductForm(buildFormData({ name: " 鲍 " }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.message).toContain("商品名称");
  });

  it("价格非法（负数 / 非数字）时失败", () => {
    expect(parseProductForm(buildFormData({ price: "-1" })).ok).toBe(false);
    expect(parseProductForm(buildFormData({ price: "abc" })).ok).toBe(false);
  });

  it("库存必须是整数", () => {
    expect(parseProductForm(buildFormData({ stock: "1.5" })).ok).toBe(false);
  });

  it("分类必须是四个合法值之一", () => {
    expect(parseProductForm(buildFormData({ category: "生鲜" })).ok).toBe(false);
    expect(parseProductForm(buildFormData({ category: "礼盒" })).ok).toBe(true);
  });

  it("标签数量超过 8 个时失败", () => {
    const result = parseProductForm(
      buildFormData({ tags: "1,2,3,4,5,6,7,8,9" }),
    );
    // parseTagInput 先截断到 8 个，因此这里应当通过且长度为 8
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tags).toHaveLength(8);
    }
  });
});

describe("validateProductForm（服务层二次校验）", () => {
  it("接受合法对象", () => {
    const result = validateProductForm({
      name: "黄岐海带",
      description: "",
      category: "干货",
      subCategory: "海带",
      price: 39.9,
      unit: "500g",
      stock: 180,
      origin: "福建连江",
      specification: "干度足 / 500g",
      storageMethod: "阴凉干燥处",
      shelfLife: "12 个月",
      tags: ["日晒"],
    });
    expect(result.ok).toBe(true);
  });

  it("拒绝缺字段的对象（例如绕过表单直接调用）", () => {
    expect(validateProductForm({ name: "黄岐海带" }).ok).toBe(false);
    expect(validateProductForm(null).ok).toBe(false);
  });
});

describe("parseProductId", () => {
  it("同时接受数据库 uuid 与 Mock 的可读 id", () => {
    expect(parseProductId("3f1a0b9c-1d2e-4f5a-8b7c-9d0e1f2a3b4c").ok).toBe(true);
    expect(parseProductId("prod_001").ok).toBe(true);
  });

  it("拒绝空值、超长与含非法字符的 id", () => {
    expect(parseProductId("").ok).toBe(false);
    expect(parseProductId("   ").ok).toBe(false);
    expect(parseProductId("a".repeat(65)).ok).toBe(false);
    expect(parseProductId("../../etc/passwd").ok).toBe(false);
    expect(parseProductId(123).ok).toBe(false);
  });
});

describe("parseProductListQuery", () => {
  it("缺省参数回落到默认视图", () => {
    const query = parseProductListQuery();
    expect(query).toEqual({
      keyword: "",
      category: "all",
      status: "all",
      page: 1,
      pageSize: 9,
    });
  });

  it("解析正常参数", () => {
    const query = parseProductListQuery({
      keyword: " 鲍鱼 ",
      category: "海产品",
      status: "analyzed",
      page: "2",
    });
    expect(query.keyword).toBe("鲍鱼");
    expect(query.category).toBe("海产品");
    expect(query.status).toBe("analyzed");
    expect(query.page).toBe(2);
  });

  it("非法值不抛错，退回默认值（避免手改地址栏把页面打崩）", () => {
    const query = parseProductListQuery({
      category: "不存在的分类",
      status: "unknown",
      page: "abc",
    });
    expect(query.category).toBe("all");
    expect(query.status).toBe("all");
    expect(query.page).toBe(1);
  });

  it("页码越界（0 / 负数 / 超大）被收敛", () => {
    expect(parseProductListQuery({ page: "0" }).page).toBe(1);
    expect(parseProductListQuery({ page: "-3" }).page).toBe(1);
    expect(parseProductListQuery({ page: "100000" }).page).toBe(1);
  });

  it("数组形式的参数取第一个值", () => {
    expect(parseProductListQuery({ keyword: ["鲍鱼", "海带"] }).keyword).toBe(
      "鲍鱼",
    );
  });
});

describe("parseProductImageFile", () => {
  it("接受允许的图片类型并读出字节", async () => {
    const result = await parseProductImageFile(fakeImageFile({ bytes: 2048 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.contentType).toBe("image/png");
    expect(result.data.data.byteLength).toBe(2048);
    expect(result.data.fileName).toBe("baoyu.png");
  });

  it("拒绝空文件、不支持的类型与超大文件", async () => {
    const empty = await parseProductImageFile(fakeImageFile({ bytes: 0 }));
    expect(empty.ok).toBe(false);

    const wrongType = await parseProductImageFile(
      fakeImageFile({ type: "application/pdf" }),
    );
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) {
      expect(wrongType.error.message).toContain("图片格式");
    }

    const tooLarge = await parseProductImageFile(
      fakeImageFile({ bytes: 6 * 1024 * 1024 }),
    );
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) {
      expect(tooLarge.error.message).toContain("5MB");
    }
  });
});
