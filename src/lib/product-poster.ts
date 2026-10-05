import type { ProductPosterSource } from "@/types";

export const POSTER_SIZES = {
  portrait: { width: 1080, height: 1440, label: "竖版 3:4" },
  square: { width: 1080, height: 1080, label: "方形 1:1" },
} as const;

export type PosterSize = keyof typeof POSTER_SIZES;

export const POSTER_TEMPLATES = {
  fresh: { label: "清新海盐", description: "浅色通透，突出商品实拍", swatches: ["#edf7f3", "#0b8087", "#193d40"] },
  warm: { label: "暖色食欲", description: "暖白与陶橙，适合家常美食", swatches: ["#fff4e4", "#b94e2d", "#513727"] },
  ocean: { label: "深海质感", description: "深蓝与青色，延续海洋品牌", swatches: ["#102e45", "#56d6e5", "#e7f6fa"] },
} as const;

export type PosterTemplate = keyof typeof POSTER_TEMPLATES;

export interface PosterCopy {
  title: string;
  subtitle: string;
  sellingPoints: string[];
  cta: string;
}

export function parsePosterPoints(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function getPosterIssue(product: ProductPosterSource | undefined, copy: PosterCopy): string | null {
  if (!product) return "没有找到关联商品，请重新选择素材。";
  if (!product.imageUrl) return "这件商品还没有照片，请先到商品中心上传商品照片。";
  if (!Number.isFinite(product.price) || product.price < 0 || product.price > 1_000_000) return "商品价格有误，请先修改商品档案。";
  if (!product.unit.trim() || product.unit.trim().length > 24) return "请在商品档案中填写简短的计价单位。";
  if (!copy.title.trim()) return "请填写海报标题。";
  if (Array.from(copy.title.trim()).length > 60) return "海报标题请控制在 60 字以内。";
  if (Array.from(copy.subtitle.trim()).length > 120) return "副标题请控制在 120 字以内。";
  if (copy.sellingPoints.length === 0) return "请填写至少一条已核对的卖点。";
  if (copy.sellingPoints.length > 3) return "海报最多展示 3 条卖点，请保留最重要的内容。";
  if (copy.sellingPoints.some((point) => Array.from(point).length > 36)) return "每条卖点请控制在 36 字以内。";
  if (!copy.cta.trim()) return "请填写海报底部的引导语。";
  if (Array.from(copy.cta.trim()).length > 80) return "引导语请控制在 80 字以内。";
  return null;
}

export function posterPrice(price: number): string {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(price);
}

/** 按字符测量并换行，保留全部文字，避免中文或 emoji 被截断。 */
export function wrapPosterText(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const character of Array.from(text.replace(/\s+/g, " ").trim())) {
    if (line && measure(line + character) > width) {
      lines.push(line);
      line = character;
    } else {
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function posterFilename(name: string, size: PosterSize): string {
  const safeName = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim().replace(/[. ]+$/, "").slice(0, 70) || "商品";
  const { width, height } = POSTER_SIZES[size];
  return `${safeName}-营销海报-${width}x${height}.png`;
}
