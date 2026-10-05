/**
 * 商品图片存储能力（本地文件与 Supabase Storage）
 *
 * 对外只暴露三个能力 + 一个 Bucket 初始化工具，全部返回 `Result<T>`，
 * 不抛异常，由服务层与页面决定如何展示与降级。
 *
 * 存储路径规则见 ./paths.ts；本地图片由 ./local-product-image.ts 管理。
 *
 * ⚠️ 仅服务端可用（service_role key）。
 */

import { attempt, fail, ok, AppError, type Result } from "@/lib/result";

import { getSupabaseAdmin, getSupabaseProjectUrl } from "./client";
import {
  localProductImageFilename,
  removeLocalProductImage,
} from "./local-product-image";
import {
  ALLOWED_PRODUCT_IMAGE_TYPES,
  MAX_PRODUCT_IMAGE_BYTES,
  PRODUCT_IMAGE_BUCKET,
  buildProductImagePath,
  buildProductImagePublicUrl,
  isAllowedProductImageType,
  isInlineProductImageUrl,
  parseProductImagePath,
  resolveProductImageExtension,
} from "./paths";

/** 上传成功后的结果：既返回可直接渲染的 URL，也返回存储路径（删除时用） */
export interface UploadedProductImage {
  path: string;
  url: string;
  size: number;
  contentType: string;
}

export interface UploadProductImageInput {
  /** 文件二进制内容 */
  data: Uint8Array;
  /** 浏览器上报的 MIME 类型 */
  contentType: string;
  /** 原始文件名，仅用于兜底推断扩展名 */
  fileName?: string;
  /** 用于生成路径前缀，通常是商品名 */
  name: string;
}

/**
 * 本地 PGlite 演示模式的图片存储。
 *
 * 图片以 data URL 直接写入 products.image_url：浏览器可立即显示，DashScope
 * 视觉接口也原生接受 data:image 地址。比赛现场因此不依赖对象存储或公网回调；
 * 远程 db 模式仍使用 Supabase Storage，避免生产数据库被大图片撑大。
 */
export function createInlineProductImage(
  input: UploadProductImageInput,
): Result<UploadedProductImage> {
  const contentType = input.contentType.trim().toLowerCase();

  if (input.data.byteLength === 0) {
    return fail("VALIDATION_FAILED", "图片内容为空，请重新选择文件");
  }
  if (!isAllowedProductImageType(contentType)) {
    return fail(
      "VALIDATION_FAILED",
      "图片格式不支持，请上传 JPG / PNG / WebP / AVIF",
      `contentType=${input.contentType}`,
    );
  }
  if (input.data.byteLength > MAX_PRODUCT_IMAGE_BYTES) {
    return fail(
      "VALIDATION_FAILED",
      `图片不能超过 ${Math.round(MAX_PRODUCT_IMAGE_BYTES / 1024 / 1024)}MB`,
      `size=${input.data.byteLength}`,
    );
  }

  const url = `data:${contentType};base64,${Buffer.from(input.data).toString("base64")}`;
  return ok({
    path: "inline:products.image_url",
    url,
    size: input.data.byteLength,
    contentType,
  });
}

/** Storage SDK 的错误对象形状（避免直接依赖其类型导出） */
interface StorageErrorLike {
  message?: string;
  statusCode?: string | number;
  error?: string;
}

function describeStorageError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as StorageErrorLike;
    return (
      candidate.message ??
      candidate.error ??
      `status=${candidate.statusCode ?? "unknown"}`
    );
  }
  return typeof error === "string" ? error : "未知错误";
}

/**
 * 把 Storage 错误收敛为 AppError。
 * 401/403 归为凭证问题（不可重试，提示去检查 key），其余归为可重试的 STORAGE_ERROR，
 * 便于前端展示「重新上传」。
 */
function toStorageError(cause: unknown, action: string): AppError {
  // 已经是 AppError（例如同文件内主动抛出）就不要再包一层，保留原始错误码
  if (cause instanceof AppError) {
    return cause;
  }
  const text = describeStorageError(cause);
  if (/401|403|unauthorized|invalid.*key|jwt/i.test(text)) {
    return new AppError({
      code: "STORAGE_ERROR",
      message: `${action}失败：存储凭证无效或权限不足`,
      detail: text,
      retryable: false,
    });
  }
  return new AppError({
    code: "STORAGE_ERROR",
    message: `${action}失败，请稍后重试`,
    detail: text,
  });
}

/**
 * 确保商品图片 Bucket 存在且为公开读。
 * seed 脚本与首次部署时调用；已存在时返回 created=false，不视为错误。
 */
export async function ensureProductImageBucket(): Promise<
  Result<{ created: boolean }>
> {
  return attempt(
    async () => {
      const storage = getSupabaseAdmin().storage;

      const existing = await storage.getBucket(PRODUCT_IMAGE_BUCKET);
      if (!existing.error) {
        return { created: false };
      }

      const created = await storage.createBucket(PRODUCT_IMAGE_BUCKET, {
        public: true,
        fileSizeLimit: MAX_PRODUCT_IMAGE_BYTES,
        allowedMimeTypes: Object.keys(ALLOWED_PRODUCT_IMAGE_TYPES),
      });
      if (created.error) {
        throw toStorageError(created.error, "创建图片 Bucket");
      }
      return { created: true };
    },
    (cause) => toStorageError(cause, "初始化图片 Bucket").toShape(),
  );
}

/**
 * 上传商品图片。
 * 校验（类型 / 大小 / 空文件）在本地完成，避免把无效文件传到云端再失败。
 */
export async function uploadProductImage(
  input: UploadProductImageInput,
): Promise<Result<UploadedProductImage>> {
  const contentType = input.contentType.trim().toLowerCase();

  if (input.data.byteLength === 0) {
    return fail("VALIDATION_FAILED", "图片内容为空，请重新选择文件");
  }
  if (!isAllowedProductImageType(contentType)) {
    return fail(
      "VALIDATION_FAILED",
      "图片格式不支持，请上传 JPG / PNG / WebP / AVIF",
      `contentType=${input.contentType}`,
    );
  }
  if (input.data.byteLength > MAX_PRODUCT_IMAGE_BYTES) {
    return fail(
      "VALIDATION_FAILED",
      `图片不能超过 ${Math.round(MAX_PRODUCT_IMAGE_BYTES / 1024 / 1024)}MB`,
      `size=${input.data.byteLength}`,
    );
  }

  const path = buildProductImagePath({
    name: input.name,
    extension: resolveProductImageExtension(contentType, input.fileName),
  });

  return attempt<UploadedProductImage>(
    async () => {
      const { error } = await getSupabaseAdmin()
        .storage.from(PRODUCT_IMAGE_BUCKET)
        .upload(path, Buffer.from(input.data), {
          contentType,
          upsert: false,
          // 文件名带唯一后缀，内容不会变，可长缓存
          cacheControl: "31536000",
        });

      if (error) {
        throw toStorageError(error, "上传商品图片");
      }

      const url = await getProductImageUrl(path);
      if (!url.ok) {
        // 上传成功但 URL 拼不出来属于配置问题，按失败处理（避免入库一个坏 URL）
        throw new AppError({
          code: "STORAGE_ERROR",
          message: "图片已上传，但无法生成访问地址",
          detail: url.error.detail ?? url.error.message,
        });
      }

      return {
        path,
        url: url.data,
        size: input.data.byteLength,
        contentType,
      };
    },
    (cause) => toStorageError(cause, "上传商品图片").toShape(),
  );
}

/**
 * 删除商品图片。
 * 接受完整公共 URL 或存储路径；无法识别来源时返回明确的校验错误，
 * 由调用方决定是否忽略（例如商品用的是外部图床）。
 */
export async function deleteProductImage(
  imageUrlOrPath: string,
): Promise<Result<{ path: string }>> {
  if (localProductImageFilename(imageUrlOrPath)) {
    return removeLocalProductImage(imageUrlOrPath);
  }
  // 内联图片与商品记录存放在一起；商品行已删除即完成清理，无外部对象可删。
  if (isInlineProductImageUrl(imageUrlOrPath)) {
    return ok({ path: "inline:products.image_url" });
  }

  const path = parseProductImagePath(imageUrlOrPath);
  if (!path) {
    return fail(
      "VALIDATION_FAILED",
      "无法识别该图片的存储路径",
      `value=${imageUrlOrPath}`,
    );
  }

  return attempt<{ path: string }>(
    async () => {
      const { error } = await getSupabaseAdmin()
        .storage.from(PRODUCT_IMAGE_BUCKET)
        .remove([path]);
      if (error) {
        throw toStorageError(error, "删除商品图片");
      }
      return { path };
    },
    (cause) => toStorageError(cause, "删除商品图片").toShape(),
  );
}

/** 由存储路径生成公开访问 URL（纯拼字符串，不上传） */
export async function getProductImageUrl(path: string): Promise<Result<string>> {
  const trimmed = path.trim();
  if (!trimmed) {
    return fail("VALIDATION_FAILED", "图片路径为空");
  }

  const projectUrl = getSupabaseProjectUrl();
  if (!projectUrl) {
    return fail(
      "VALIDATION_FAILED",
      "尚未配置对象存储地址",
      "缺少环境变量：NEXT_PUBLIC_SUPABASE_URL",
    );
  }

  return { ok: true, data: buildProductImagePublicUrl(projectUrl, trimmed) };
}

export { PRODUCT_IMAGE_BUCKET, MAX_PRODUCT_IMAGE_BYTES };
