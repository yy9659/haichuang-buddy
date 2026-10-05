import { z } from "zod";
import type { PosterCopy } from "./product-poster";

export const POSTER_LAYOUT_LABELS = { editorial: "文案与实拍", split: "图文并排", showcase: "商品大图" } as const;
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "颜色需为六位色值");

const PosterRegionSchema = z.object({
  x: z.number().min(24).max(920), y: z.number().min(24).max(940),
  width: z.number().min(120).max(952), height: z.number().min(60).max(700),
}).refine((region) => region.x + region.width <= 976 && region.y + region.height <= 968, "元素不能超出海报安全区");

/** 坐标按画布宽高各 1000 份计算，模型可决定元素位置，保留程序对图片和文字的控制。 */
export const PosterCompositionSchema = z.object({
  title: PosterRegionSchema, subtitle: PosterRegionSchema, photo: PosterRegionSchema,
  sellingPoints: PosterRegionSchema, price: PosterRegionSchema, cta: PosterRegionSchema,
  headlineSize: z.number().min(48).max(112),
  photoFrame: z.enum(["none", "soft", "paper"]),
  priceStyle: z.enum(["plain", "accent", "ticket"]),
  sellingPointStyle: z.enum(["list", "inline", "cards"]),
}).superRefine((composition, context) => {
  const names = ["title", "subtitle", "photo", "sellingPoints", "price", "cta"] as const;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = composition[names[i]], b = composition[names[j]];
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        context.addIssue({ code: "custom", path: [names[j]], message: `${names[i]} 与 ${names[j]} 的区域重叠` });
      }
    }
  }
});
export type PosterComposition = z.infer<typeof PosterCompositionSchema>;

/** 模型只决定设计参数；商品事实和文案由商户保留并核对。 */
export const PosterDesignSchema = z.object({
  name: z.string().trim().min(1).max(24),
  rationale: z.string().trim().min(1).max(160),
  layout: z.enum(["editorial", "split", "showcase"]),
  palette: z.object({ background: hex, foreground: hex, accent: hex, surface: hex }),
  typography: z.enum(["bold", "elegant", "clean"]),
  titleAlign: z.enum(["left", "center"]),
  photoScale: z.number().min(0.8).max(1),
  emphasis: z.enum(["product", "price", "balanced"]),
  decoration: z.enum(["waves", "circles", "minimal"]),
  showSubtitle: z.boolean(),
  showSellingPoints: z.boolean(),
  backgroundPrompt: z.string().trim().min(10).max(480),
  composition: PosterCompositionSchema.optional(),
});
export type PosterDesign = z.infer<typeof PosterDesignSchema>;
export interface PosterDesignResult { design: PosterDesign; isMock: boolean; providerLabel: string }

export const PosterDesignRequestSchema = z.object({
  slot: z.object({ productId: z.string().min(1).max(120), platform: z.enum(["douyin", "xiaohongshu", "wechat", "shipinhao", "detail", "ads"]), format: z.enum(["short-video", "article", "poster-copy", "voiceover"]) }),
  copy: z.object({ title: z.string().trim().min(1).max(60), subtitle: z.string().trim().max(120), sellingPoints: z.array(z.string().trim().min(1).max(36)).min(1).max(3), cta: z.string().trim().min(1).max(80) }),
  sourceCopy: z.object({ title: z.string().trim().min(1).max(60), hook: z.string().trim().max(120), body: z.string().trim().max(5000), cta: z.string().trim().max(80) }).optional(),
  instruction: z.string().trim().max(240),
  previous: PosterDesignSchema.nullable(),
  size: z.enum(["portrait", "square"]),
  photoAspectRatio: z.number().min(0.1).max(10).optional(),
});
export type PosterDesignRequest = z.infer<typeof PosterDesignRequestSchema>;

export function posterCopyKey(copy: PosterCopy): string {
  return JSON.stringify([copy.title, copy.subtitle, copy.sellingPoints, copy.cta]);
}

export function starterComposition(layout: PosterDesign["layout"]): PosterComposition {
  const shared = { headlineSize: 92, photoFrame: "soft" as const, priceStyle: "ticket" as const, sellingPointStyle: "inline" as const };
  if (layout === "split") return {
    ...shared, title: { x: 580, y: 120, width: 370, height: 160 }, subtitle: { x: 580, y: 300, width: 370, height: 150 },
    photo: { x: 40, y: 130, width: 500, height: 610 }, sellingPoints: { x: 580, y: 470, width: 370, height: 220 },
    price: { x: 54, y: 770, width: 430, height: 120 }, cta: { x: 534, y: 796, width: 414, height: 86 }, sellingPointStyle: "list",
  };
  if (layout === "showcase") return {
    ...shared, photo: { x: 36, y: 44, width: 928, height: 465 }, title: { x: 54, y: 532, width: 890, height: 120 },
    subtitle: { x: 54, y: 668, width: 890, height: 70 }, sellingPoints: { x: 54, y: 753, width: 890, height: 78 },
    price: { x: 54, y: 849, width: 430, height: 100 }, cta: { x: 520, y: 865, width: 424, height: 72 },
  };
  return {
    ...shared, title: { x: 54, y: 68, width: 890, height: 128 }, subtitle: { x: 54, y: 210, width: 890, height: 76 },
    photo: { x: 36, y: 302, width: 928, height: 365 }, sellingPoints: { x: 54, y: 684, width: 890, height: 86 },
    price: { x: 54, y: 790, width: 440, height: 105 }, cta: { x: 532, y: 805, width: 414, height: 85 },
  };
}

/** 免费的初始排版预览；明确区别于模型设计结果。 */
export function createPosterPreviewDesign(copy: PosterCopy, hints: string, palette?: "fresh" | "warm" | "ocean"): PosterDesign {
  const text = `${copy.title} ${copy.subtitle} ${hints}`;
  const tone = palette ?? (/温馨|家庭|家常|晚餐|餐桌|煮汤|烟火/.test(text) ? "warm" : /深蓝|深海|高级|质感/.test(text) ? "ocean" : "fresh");
  const layout = /左右|并排/.test(hints) ? "split" : /实拍|大图|食欲|商品.*突出/.test(hints) ? "showcase" : "editorial";
  return {
    name: "文案排版预览", rationale: "根据当前文案与创意建议形成初始预览，点击设计按钮后由 AI 制定设计方案。", layout,
    palette: tone === "warm" ? { background: "#fff6e9", foreground: "#392c23", accent: "#b5482c", surface: "#fffaf2" } : tone === "ocean" ? { background: "#102e45", foreground: "#edf8fc", accent: "#66d6e4", surface: "#173c50" } : { background: "#f2f8f3", foreground: "#203f3b", accent: "#16877e", surface: "#ffffff" },
    typography: "bold", titleAlign: "left", photoScale: 1, emphasis: "product", decoration: tone === "warm" ? "circles" : "waves", showSubtitle: true, showSellingPoints: true,
    backgroundPrompt: "纯环境氛围背景，留白充足，无商品，无人物，无文字，无标志。", composition: starterComposition(layout),
  };
}

function rgb(hex: string): number[] { return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255); }
function luminance(color: string): number {
  const channels = rgb(color).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
export function readablePosterInk(background: string, preferred: string): string {
  const a = luminance(background), b = luminance(preferred);
  if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5) return preferred;
  return a > 0.179 ? "#102630" : "#ffffff";
}
export function mixPosterColor(a: string, b: string, amount: number): string {
  const x = rgb(a), y = rgb(b);
  return "#" + x.map((v, i) => Math.round((v * (1 - amount) + y[i] * amount) * 255).toString(16).padStart(2, "0")).join("");
}
