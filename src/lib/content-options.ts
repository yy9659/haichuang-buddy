/**
 * 内容工厂的选项常量与类型守卫
 *
 * 单独放这里的理由（与 `product-options.ts` 一致）：
 * - 客户端组件（生成表单的下拉框）与从 URL 解析槽位的 `src/schemas/content.ts`
 *   都需要这些清单，但不应该为了拿一个数组而把 Zod 打进浏览器包；
 * - **数据库行的映射器**也要用同一份清单给非法值兜底。放在 lib 层，
 *   AI 契约、仓储映射、UI 三处共用同一份定义，谁也不会漂移；
 * - 与 `src/types/content.ts` 的联合类型用 `satisfies` 绑定，
 *   任何一边改了而另一边没跟上都会在编译期报错。
 */

import type { ContentFormat, ContentPlatform, ContentStatus } from "@/types";

/** 推广角度只控制表达，不提供新的商品事实。 */
export const CONTENT_ANGLES = ["selling-point", "cooking", "trust", "daily"] as const;
export type ContentAngle = (typeof CONTENT_ANGLES)[number];

export const CONTENT_ANGLE_META: Record<ContentAngle, { label: string; hint: string; instruction: string }> = {
  "selling-point": {
    label: "突出商品卖点",
    hint: "让顾客快速知道好在哪里",
    instruction: "优先解释商品资料中已有的卖点；没有依据的卖点不要补写。",
  },
  cooking: {
    label: "分享吃法",
    hint: "用做法吸引想尝鲜的人",
    instruction: "围绕商品资料中已有的食用场景写；没有做法依据时，不编造火候或时长。",
  },
  trust: {
    label: "解答购买顾虑",
    hint: "说清规格、储存等已知信息",
    instruction: "优先回答资料中可核对的产地、规格、储存问题；没有提供的信息不要承诺。",
  },
  daily: {
    label: "日常推荐",
    hint: "像店主亲自介绍这件商品",
    instruction: "自然介绍当前商品，不制造限时促销、库存紧张或销量等没有依据的事实。",
  },
};

export function isContentAngle(value: unknown): value is ContentAngle {
  return typeof value === "string" && (CONTENT_ANGLES as readonly string[]).includes(value);
}

/** 发布平台（顺序即界面下拉的展示顺序） */
export const CONTENT_PLATFORMS = [
  "douyin",
  "xiaohongshu",
  "wechat",
  "shipinhao",
  "detail",
  "ads",
] as const satisfies readonly ContentPlatform[];

/** 内容形态 */
export const CONTENT_FORMATS = [
  "short-video",
  "article",
  "poster-copy",
  "voiceover",
] as const satisfies readonly ContentFormat[];

/** 内容状态 */
export const CONTENT_STATUSES = [
  "draft",
  "reviewing",
  "approved",
  "published",
  "failed",
] as const satisfies readonly ContentStatus[];

export function isContentPlatform(value: unknown): value is ContentPlatform {
  return (
    typeof value === "string" &&
    (CONTENT_PLATFORMS as readonly string[]).includes(value)
  );
}

export function isContentFormat(value: unknown): value is ContentFormat {
  return (
    typeof value === "string" &&
    (CONTENT_FORMATS as readonly string[]).includes(value)
  );
}

export function isContentStatus(value: unknown): value is ContentStatus {
  return (
    typeof value === "string" &&
    (CONTENT_STATUSES as readonly string[]).includes(value)
  );
}

/** 默认槽位：抖音短视频脚本 —— 海产商家最常见的起手式 */
export const DEFAULT_CONTENT_PLATFORM: ContentPlatform = "douyin";
export const DEFAULT_CONTENT_FORMAT: ContentFormat = "short-video";
