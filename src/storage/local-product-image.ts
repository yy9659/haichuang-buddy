import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { fail, ok, type Result } from "@/lib/result";

import {
  ALLOWED_PRODUCT_IMAGE_TYPES,
  MAX_PRODUCT_IMAGE_BYTES,
} from "./paths";

import type { UploadedProductImage, UploadProductImageInput } from "./product-image";

const LOCAL_IMAGE_URL_PREFIX = "/api/product-images/";
const LOCAL_IMAGE_NAME = /^[a-f0-9]{32}\.(?:jpg|png|webp|avif)$/;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};

export function localProductImageDirectory(): string {
  return path.join(process.cwd(), ".data", "product-images");
}

export function localProductImageFilename(url: string): string | null {
  if (!url.startsWith(LOCAL_IMAGE_URL_PREFIX)) {
    return null;
  }
  const filename = url.slice(LOCAL_IMAGE_URL_PREFIX.length);
  return LOCAL_IMAGE_NAME.test(filename) ? filename : null;
}

export function localProductImageContentType(filename: string): string | null {
  if (!LOCAL_IMAGE_NAME.test(filename)) {
    return null;
  }
  return IMAGE_MIME_BY_EXTENSION[filename.split(".").at(-1) ?? ""] ?? null;
}

export function localProductImagePath(filename: string): string | null {
  return localProductImageContentType(filename)
    ? path.join(localProductImageDirectory(), filename)
    : null;
}

export async function saveLocalProductImage(
  input: UploadProductImageInput,
): Promise<Result<UploadedProductImage>> {
  const contentType = input.contentType.trim().toLowerCase();
  const extension = ALLOWED_PRODUCT_IMAGE_TYPES[contentType];
  if (!extension || input.data.byteLength === 0 || input.data.byteLength > MAX_PRODUCT_IMAGE_BYTES) {
    return fail("VALIDATION_FAILED", "图片格式或大小不符合要求，请重新选择图片");
  }

  const filename = `${randomUUID().replaceAll("-", "")}.${extension}`;
  try {
    await mkdir(localProductImageDirectory(), { recursive: true });
    await writeFile(path.join(localProductImageDirectory(), filename), input.data, { flag: "wx" });
    return ok({
      path: filename,
      url: `${LOCAL_IMAGE_URL_PREFIX}${filename}`,
      size: input.data.byteLength,
      contentType,
    });
  } catch {
    return fail("STORAGE_ERROR", "图片保存失败，请重试");
  }
}

export async function readLocalProductImageAsDataUrl(
  url: string,
): Promise<Result<string>> {
  const filename = localProductImageFilename(url);
  const filePath = filename ? localProductImagePath(filename) : null;
  const contentType = filename ? localProductImageContentType(filename) : null;
  if (!filePath || !contentType) {
    return fail("VALIDATION_FAILED", "商品图片地址无效");
  }
  try {
    const data = await readFile(filePath);
    return ok(`data:${contentType};base64,${data.toString("base64")}`);
  } catch {
    return fail("STORAGE_ERROR", "商品图片暂时无法读取");
  }
}

export async function removeLocalProductImage(
  url: string,
): Promise<Result<{ path: string }>> {
  const filename = localProductImageFilename(url);
  const filePath = filename ? localProductImagePath(filename) : null;
  if (!filePath || !filename) {
    return fail("VALIDATION_FAILED", "商品图片地址无效");
  }
  try {
    await unlink(filePath);
    return ok({ path: filename });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return ok({ path: filename });
    }
    return fail("STORAGE_ERROR", "商品图片清理失败");
  }
}
