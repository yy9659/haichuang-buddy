/**
 * 商品表单与列表下拉的选项常量
 *
 * 单独放这里的理由：
 * - 客户端组件（新增 / 编辑对话框、筛选工具条）需要这些选项，
 *   但它们不应该为了拿一个数组而把 Zod 打进浏览器包。
 * - 与 `src/types/product.ts` 的联合类型用 `satisfies` 绑定，
 *   任何一边改了而另一边没跟上都会在编译期报错。
 */

import type { ProductAnalysisStatus, ProductCategory } from "@/types";

/** 商品分类（值即中文展示名） */
export const PRODUCT_CATEGORIES = [
  "海产品",
  "干货",
  "预制菜",
  "礼盒",
] as const satisfies readonly ProductCategory[];

/** 商品 AI 分析状态 */
export const PRODUCT_ANALYSIS_STATUSES = [
  "pending",
  "analyzing",
  "analyzed",
  "failed",
] as const satisfies readonly ProductAnalysisStatus[];

/** 常用计价单位（表单 datalist 提示，允许自由输入） */
export const PRODUCT_UNIT_SUGGESTIONS = [
  "500g",
  "1kg",
  "250g",
  "盒",
  "袋",
  "箱",
  "只",
] as const;

/** 表单字段 → 中文标签，用于把校验错误翻译成用户看得懂的话 */
export const PRODUCT_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "商品名称",
  description: "商品描述",
  category: "分类",
  subCategory: "子类目",
  price: "价格",
  unit: "计价单位",
  stock: "库存",
  origin: "产地",
  specification: "规格",
  storageMethod: "储存方式",
  shelfLife: "保质期",
  tags: "标签",
  image: "商品图片",
};

export function isProductCategory(value: string): value is ProductCategory {
  return (PRODUCT_CATEGORIES as readonly string[]).includes(value);
}

export function isProductAnalysisStatus(
  value: string,
): value is ProductAnalysisStatus {
  return (PRODUCT_ANALYSIS_STATUSES as readonly string[]).includes(value);
}
