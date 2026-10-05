import type { SalesReviewAction, SalesReviewSnapshot } from "@/types";

/** 跳转地址由程序生成，模型仅选择允许的操作类型。 */
export function salesReviewActionLink(action: SalesReviewAction, snapshot: SalesReviewSnapshot): { href: string; label: string } {
  const product = snapshot.products.find(item => item.name === action.productName);
  if (action.destination === "sales") return { href: "#sales-import", label: "查看销售记录" };
  if (action.destination === "customer_service") return { href: "/customer-service", label: "去整理答疑" };
  if (action.destination === "products" || (action.destination === "content" && action.productName && !product?.productId)) return { href: product?.productId ? `/products/${encodeURIComponent(product.productId)}` : "/products", label: product?.productId ? "查看商品资料" : "去整理商品" };
  const channel = product?.primaryChannel ?? snapshot.summary.byChannel[0]?.name ?? "";
  const platform = /抖音/.test(channel) ? "douyin" : /小红书/.test(channel) ? "xiaohongshu" : /视频号/.test(channel) ? "shipinhao" : "wechat";
  const format = platform === "douyin" || platform === "shipinhao" ? "short-video" : "poster-copy";
  return { href: product?.productId ? `/content?${new URLSearchParams({ productId: product.productId, platform, format })}` : "/content", label: "去准备推广素材" };
}
