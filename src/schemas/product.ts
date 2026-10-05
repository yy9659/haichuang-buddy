/**
 * 商品域的 Zod Schema（唯一可信的输入校验入口）
 *
 * 三件事：
 * 1. 表单 → 领域值的解析（`productFormSchema` / `parseProductForm`）
 * 2. URL 查询参数 → 列表查询条件的解析（`parseProductListQuery`，容错不抛错）
 * 3. 上传图片文件的本地校验（大小 / MIME，避免把无效文件传到云端再失败）
 *
 * 为什么表单解析要单独测：它是「用户输入进入系统」的唯一闸门，
 * 一旦这里放水，脏数据会直接进数据库。
 */

import { z } from "zod";

import { PRODUCT_FIELD_LABELS } from "@/lib/product-options";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_ANALYSIS_STATUSES,
} from "@/lib/product-options";
import { fail, ok, type Result } from "@/lib/result";
import { readParam, type RawSearchParams } from "@/lib/search-params";
import { MAX_PRODUCT_IMAGE_BYTES, isAllowedProductImageType } from "@/storage/paths";
import { firstIssueMessage, formatIssues } from "@/lib/validation";

import { DEFAULT_PRODUCT_PAGE_SIZE } from "@/repositories/types";

/* ------------------------------------------------------------------ */
/* 新增 / 编辑商品                                                     */
/* ------------------------------------------------------------------ */

/**
 * 商品表单 schema。
 * 字段全部以字符串或数字到达（FormData 场景下是字符串），因此价格与库存用 coerce。
 * 空字符串会被 coerce 成 0（价格 / 库存），空文本字段则是合法的空值。
 */
export const productFormSchema = z.object({
  name: z.string().trim().min(2, "至少 2 个字").max(60, "不超过 60 个字"),
  description: z.string().trim().max(500, "不超过 500 个字"),
  category: z.enum(PRODUCT_CATEGORIES),
  subCategory: z.string().trim().max(30, "不超过 30 个字"),
  price: z.coerce.number().min(0, "不能为负数").max(1_000_000, "数值过大"),
  unit: z.string().trim().max(20, "不超过 20 个字"),
  stock: z.coerce
    .number()
    .int("必须是整数")
    .min(0, "不能为负数")
    .max(1_000_000, "数值过大"),
  origin: z.string().trim().max(60, "不超过 60 个字"),
  specification: z.string().trim().max(60, "不超过 60 个字"),
  storageMethod: z.string().trim().max(60, "不超过 60 个字"),
  shelfLife: z.string().trim().max(30, "不超过 30 个字"),
  tags: z.array(z.string().trim().min(1).max(12, "单个标签不超过 12 个字")).max(
    8,
    "最多 8 个标签",
  ),
});

export type ProductFormValues = z.infer<typeof productFormSchema>;

/** 把任意值安全解析为商品表单值（服务层二次校验用） */
export function validateProductForm(input: unknown): Result<ProductFormValues> {
  const parsed = productFormSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      "VALIDATION_FAILED",
      firstIssueMessage(parsed.error, PRODUCT_FIELD_LABELS),
      formatIssues(parsed.error, PRODUCT_FIELD_LABELS),
    );
  }
  return ok(parsed.data);
}

/** 从 FormData 读取字符串字段，缺失时返回空串 */
function readField(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** 标签输入框：支持中英文逗号、顿号、空白、换行分隔 */
export function parseTagInput(raw: string): string[] {
  return raw
    .split(/[,，、\s]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, 8);
}

/** 解析新增 / 编辑商品的表单提交 */
export function parseProductForm(formData: FormData): Result<ProductFormValues> {
  return validateProductForm({
    name: readField(formData, "name"),
    description: readField(formData, "description"),
    category: readField(formData, "category"),
    subCategory: readField(formData, "subCategory"),
    price: readField(formData, "price"),
    unit: readField(formData, "unit"),
    stock: readField(formData, "stock"),
    origin: readField(formData, "origin"),
    specification: readField(formData, "specification"),
    storageMethod: readField(formData, "storageMethod"),
    shelfLife: readField(formData, "shelfLife"),
    tags: parseTagInput(readField(formData, "tags")),
  });
}

/* ------------------------------------------------------------------ */
/* 商品 id                                                             */
/* ------------------------------------------------------------------ */

/**
 * 商品 id。
 *
 * 刻意**不校验 uuid**：id 的具体格式是数据源的事情 ——
 * 数据库是 uuid，而 Mock 数据源用的是 `prod_xxxxxx` 这类可读 id。
 * 服务层只需要拦住空值与明显异常输入（超长、带路径分隔符等），
 * 格式判断交给仓储实现（DB 实现在查询前用 isUuid 短路）。
 */
export const productIdSchema = z
  .string()
  .trim()
  .min(1, "缺少商品 ID")
  .max(64, "商品 ID 过长")
  .regex(/^[A-Za-z0-9_-]+$/, "商品 ID 含有非法字符");

export function parseProductId(value: unknown): Result<string> {
  const parsed = productIdSchema.safeParse(value);
  if (!parsed.success) {
    return fail(
      "VALIDATION_FAILED",
      "商品 ID 不合法",
      formatIssues(parsed.error, PRODUCT_FIELD_LABELS),
    );
  }
  return ok(parsed.data);
}

/* ------------------------------------------------------------------ */
/* 列表查询参数                                                        */
/* ------------------------------------------------------------------ */

/**
 * URL 查询参数。
 * **全部字段使用 `.catch()` 兜底** —— 用户可能手改地址栏，
 * 一个拼错的分页参数不应该让整个列表页 500，而应该退回默认视图。
 */
export const productListQuerySchema = z.object({
  keyword: z.string().trim().max(60).catch(""),
  category: z
    .union([z.enum(PRODUCT_CATEGORIES), z.literal("all")])
    .catch("all"),
  status: z
    .union([z.enum(PRODUCT_ANALYSIS_STATUSES), z.literal("all")])
    .catch("all"),
  page: z.coerce.number().int().min(1).max(999).catch(1),
});

export type ProductListQueryInput = z.infer<typeof productListQuerySchema>;

/**
 * 解析列表查询参数，永不抛错。
 * 返回的 pageSize 统一取默认值（不开放给 URL 控制，避免被拿来放大查询）。
 */
export function parseProductListQuery(
  raw: RawSearchParams = {},
): ProductListQueryInput & { pageSize: number } {
  const parsed = productListQuerySchema.parse({
    keyword: readParam(raw, "keyword"),
    category: readParam(raw, "category"),
    status: readParam(raw, "status"),
    page: readParam(raw, "page"),
  });
  return { ...parsed, pageSize: DEFAULT_PRODUCT_PAGE_SIZE };
}

/* ------------------------------------------------------------------ */
/* 图片文件                                                            */
/* ------------------------------------------------------------------ */

/** File 的最小结构契约（便于在测试中传入假对象，不依赖 DOM File） */
export interface ProductImageFileInput {
  size: number;
  type: string;
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ParsedProductImage {
  data: Uint8Array;
  contentType: string;
  fileName: string;
}

/**
 * 校验并读取上传的图片文件。
 * 大小与 MIME 的类型白名单与 Storage 层共用同一份常量，避免两处口径不一致。
 */
export async function parseProductImageFile(
  file: ProductImageFileInput,
): Promise<Result<ParsedProductImage>> {
  if (file.size <= 0) {
    return fail("VALIDATION_FAILED", "商品图片内容为空，请重新选择文件");
  }
  if (!isAllowedProductImageType(file.type)) {
    return fail(
      "VALIDATION_FAILED",
      "图片格式不支持，请上传 JPG / PNG / WebP / AVIF",
      `contentType=${file.type}`,
    );
  }
  if (file.size > MAX_PRODUCT_IMAGE_BYTES) {
    return fail(
      "VALIDATION_FAILED",
      `图片不能超过 ${Math.round(MAX_PRODUCT_IMAGE_BYTES / 1024 / 1024)}MB`,
      `size=${file.size}`,
    );
  }

  const buffer = await file.arrayBuffer();
  if (buffer.byteLength === 0) {
    return fail("VALIDATION_FAILED", "商品图片内容为空，请重新选择文件");
  }

  return ok({
    data: new Uint8Array(buffer),
    contentType: file.type,
    fileName: file.name,
  });
}
