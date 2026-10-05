/**
 * 存储层统一出口
 *
 * 只允许服务端引用（Supabase service_role key）。
 * 页面 / 客户端组件需要通过服务层间接使用，不要直接 import 本模块。
 */

export {
  PRODUCT_IMAGE_BUCKET,
  MAX_PRODUCT_IMAGE_BYTES,
  INLINE_PRODUCT_IMAGE_PREFIX,
  ALLOWED_PRODUCT_IMAGE_TYPES,
  isAllowedProductImageType,
  isInlineProductImageUrl,
} from "./paths";
export {
  createInlineProductImage,
  deleteProductImage,
  ensureProductImageBucket,
  getProductImageUrl,
  uploadProductImage,
  type UploadedProductImage,
  type UploadProductImageInput,
} from "./product-image";
