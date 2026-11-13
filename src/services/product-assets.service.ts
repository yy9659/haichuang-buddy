import { getServerEnv } from "@/lib/env";
import { ownsLocalProductImage, readOwnedProductImageReference } from "@/repositories/db/product.repository";

export { ownsLocalProductImage, readOwnedProductImageReference };
import { AppError } from "@/lib/result";
import { getSupabaseAdmin } from "@/storage/client";
import { MAX_PRODUCT_IMAGE_BYTES, PRODUCT_IMAGE_BUCKET, trustedProductImagePath } from "@/storage/paths";
import { getCurrentAuthUser } from "./auth.service";

export async function readOwnedRemoteProductImage(businessId: string, productId: string) {
  const reference = await readOwnedProductImageReference(businessId, productId);
  const path = trustedProductImagePath(reference, getServerEnv().NEXT_PUBLIC_SUPABASE_URL);
  if (!path) return null;
  const { data, error } = await getSupabaseAdmin().storage.from(PRODUCT_IMAGE_BUCKET).download(path);
  if (error || !data || data.size > MAX_PRODUCT_IMAGE_BYTES) {
    throw new AppError({ code: "STORAGE_ERROR", message: "商品图片暂时无法读取。" });
  }
  const ext = path.split(".").at(-1);
  const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/" + ext;
  return { bytes: await data.arrayBuffer(), contentType };
}

export async function readProductVisionImage(productId: string) {
  const user = await getCurrentAuthUser();
  if (!user) throw new AppError({ code: "UNAUTHORIZED", message: "请登录后读取商品图片。" });
  const image = await readOwnedRemoteProductImage(user.businessId, productId);
  if (!image) throw new AppError({ code: "NOT_FOUND", message: "商品图片不存在。" });
  return `data:${image.contentType};base64,${Buffer.from(image.bytes).toString("base64")}`;
}
