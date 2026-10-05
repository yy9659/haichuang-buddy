/**
 * 商品图片的存储路径与公共 URL 规则（纯函数，可单测）
 *
 * 为什么单独一层：
 * - 路径规则属于「契约」，数据库里 products.image_url 存的是可直接渲染的
 *   完整公共 URL，而删除时需要一个反推出 storage path 的过程。
 *   两边必须使用同一套规则，否则会出现「能上传、删不掉」。
 * - 纯函数不 import Supabase SDK，因此可以在没有凭证的环境里单测。
 */

/** 商品图片 Bucket（Supabase Storage） */
export const PRODUCT_IMAGE_BUCKET = "product-images";

/** 允许的图片 MIME 类型 → 落盘扩展名 */
export const ALLOWED_PRODUCT_IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

/** 单张图片大小上限 5MB（Supabase 免费额度下足够，也能拦住误传的大图） */
export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;

/** 本地演示模式使用的内联图片 URL 前缀（可直接交给浏览器与视觉模型） */
export const INLINE_PRODUCT_IMAGE_PREFIX = "data:image/";

/** 是否为系统支持的内联商品图片 */
export function isInlineProductImageUrl(value: string): boolean {
  return /^data:image\/(?:jpeg|jpg|png|webp|avif);base64,/i.test(value.trim());
}

/** 是否属于允许上传的图片类型 */
export function isAllowedProductImageType(contentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    ALLOWED_PRODUCT_IMAGE_TYPES,
    contentType.toLowerCase(),
  );
}

/**
 * 解析落盘扩展名。
 * 优先用 MIME 类型（可信来源无法伪造），文件名仅作兜底。
 */
export function resolveProductImageExtension(
  contentType: string,
  fileName = "",
): string {
  const fromMime = ALLOWED_PRODUCT_IMAGE_TYPES[contentType.toLowerCase()];
  if (fromMime) {
    return fromMime;
  }
  const match = /\.([a-z0-9]{2,5})$/i.exec(fileName.trim());
  return match?.[1]?.toLowerCase() ?? "jpg";
}

/**
 * 把商品名转成 ascii 安全的路径前缀。
 * 中文名会被整段丢弃（得到 "product"）—— 这是刻意的：
 * 对象存储 key 里出现百分号转义会让 URL 与日志都难以排查。
 */
export function toPathSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug.length > 0 ? slug : "product";
}

/** 生成唯一后缀，避免同名文件互相覆盖 */
function createSuffix(): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(16).slice(2, 10);
  return `${Date.now().toString(36)}${random}`;
}

/** 生成存储路径：products/2026/09/liangjiang-baoyu-m1x2y3z4.png */
export function buildProductImagePath(options: {
  name: string;
  extension: string;
  /** 可注入，便于单测 */
  now?: Date;
}): string {
  const date = options.now ?? new Date();
  const year = `${date.getFullYear()}`;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const fileName = `${toPathSlug(options.name)}-${createSuffix()}.${options.extension}`;
  return `products/${year}/${month}/${fileName}`;
}

/** 由 Supabase 项目地址与存储路径拼出公开访问 URL */
export function buildProductImagePublicUrl(
  supabaseUrl: string,
  path: string,
): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${PRODUCT_IMAGE_BUCKET}/${path}`;
}

/**
 * 从「完整公共 URL」或「存储路径」中反推出存储路径。
 * 无法识别（例如已经指向第三方图床）时返回 null，调用方应跳过删除。
 */
export function parseProductImagePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const marker = `/storage/v1/object/public/${PRODUCT_IMAGE_BUCKET}/`;
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex >= 0) {
    const raw = trimmed.slice(markerIndex + marker.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      // 含非法百分号转义时保持原样，不因为一个坏 URL 抛异常
      return raw;
    }
  }

  // 传入的就是存储路径本身（不以协议开头）
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^\/+/, "");
  }

  return null;
}
