"use server";

/**
 * 商品中心的 Server Actions
 *
 * 为什么用 Server Actions 而不是 API Route：
 * - 图片上传必须走服务端（Supabase service_role key 不能下发到浏览器），
 *   表单字段与文件在**同一次请求**里提交，避免"先传图再建商品"出现半成品；
 * - 服务端可复用 `src/services` 与 `src/schemas`，无需在客户端重复一套校验。
 *
 * 约束：本文件只做「解析入参 → 调服务 → 失效缓存」，
 * 不含业务规则（业务规则在 service / repository）。
 */

import { revalidatePath } from "next/cache";

import { fail, type Result } from "@/lib/result";
import { deleteProductImage } from "@/storage";
import {
  parseProductForm,
  parseProductId,
  type ProductImageFileInput,
} from "@/schemas/product";
import {
  createProduct,
  deleteProduct,
  updateProduct,
  uploadImage,
  type DeleteProductResult,
  type ProductWritePayload,
} from "@/services/products";
import type { Product } from "@/types";

/** 商品数据出现在哪些页面：改动后统一失效，避免看到旧数据 */
function revalidateProductSurfaces(productId?: string): void {
  revalidatePath("/products");
  revalidatePath("/dashboard");
  revalidatePath("/analytics");
  if (productId) {
    revalidatePath(`/products/${productId}`);
  }
}

/**
 * 从 FormData 里取出图片文件。
 * 用结构判断而不是 instanceof File —— 不同运行时的 File 实现可能不是同一个类。
 */
function readImageFile(formData: FormData): ProductImageFileInput | null {
  const value = formData.get("image");
  if (!value || typeof value === "string") {
    return null;
  }
  const candidate = value as ProductImageFileInput;
  if (typeof candidate.arrayBuffer !== "function" || candidate.size <= 0) {
    return null;
  }
  return candidate;
}

function readField(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** 提交表单时的图片处理：上传新图 / 清除旧图 / 保持不变 */
async function resolveImageUrl(
  formData: FormData,
  productName: string,
  mode: "create" | "update",
): Promise<Result<{ imageUrl?: string | null }>> {
  const file = readImageFile(formData);
  if (file) {
    const uploaded = await uploadImage(file, { name: productName });
    if (!uploaded.ok) {
      return uploaded;
    }
    return { ok: true, data: { imageUrl: uploaded.data.url } };
  }

  if (mode === "update" && readField(formData, "removeImage") === "1") {
    return { ok: true, data: { imageUrl: null } };
  }

  return { ok: true, data: {} };
}

/** 新增商品：字段校验 → 图片上传 → 落库 */
export async function createProductAction(
  formData: FormData,
): Promise<Result<Product>> {
  const values = parseProductForm(formData);
  if (!values.ok) {
    return values;
  }

  const image = await resolveImageUrl(formData, values.data.name, "create");
  if (!image.ok) {
    return image;
  }

  const created = await createProduct({
    values: values.data,
    imageUrl: image.data.imageUrl ?? null,
  });
  if (!created.ok) {
    if (image.data.imageUrl) {
      await deleteProductImage(image.data.imageUrl);
    }
    return created;
  }

  revalidateProductSurfaces(created.data.id);
  return created;
}

/** 编辑商品：字段校验 → 图片处理（上传 / 清除 / 不变）→ 保存 */
export async function updateProductAction(
  formData: FormData,
): Promise<Result<Product>> {
  const productId = parseProductId(readField(formData, "productId"));
  if (!productId.ok) {
    return productId;
  }

  const values = parseProductForm(formData);
  if (!values.ok) {
    return values;
  }

  const image = await resolveImageUrl(formData, values.data.name, "update");
  if (!image.ok) {
    return image;
  }

  const payload: ProductWritePayload = { values: values.data };
  if (image.data.imageUrl !== undefined) {
    payload.imageUrl = image.data.imageUrl;
  }

  const saved = await updateProduct(productId.data, payload);
  if (!saved.ok) {
    if (image.data.imageUrl) {
      await deleteProductImage(image.data.imageUrl);
    }
    return saved;
  }

  revalidateProductSurfaces(saved.data.id);
  return saved;
}

/** 删除商品（连带清理对象存储中的图片） */
export async function deleteProductAction(
  productId: string,
): Promise<Result<DeleteProductResult>> {
  if (!productId) {
    return fail("VALIDATION_FAILED", "缺少要删除的商品 ID");
  }

  const removed = await deleteProduct(productId);
  if (!removed.ok) {
    return removed;
  }

  revalidateProductSurfaces(productId);
  return removed;
}
