/**
 * 内容工厂的输入校验（用户输入进入系统的唯一闸门）
 *
 * 目前只承担一件事：把 URL 查询参数解析成**页面当前选中的槽位**。
 *
 * 为什么槽位走 URL 而不是组件内部状态：
 * - 「这个商品在抖音要出什么内容」需要一个**可定位的位置**才能回答，
 *   而定位槽位需要知道商品是否存在、有没有 Product DNA —— 这些只有服务层知道，
 *   页面拿不到，因此选择结果必须交回服务端（见 `resolveContentSlot`）；
 * - 顺带让「鲍鱼 × 小红书 × 图文笔记」变成一条可分享、可收藏的地址。
 *
 * 与商品列表查询同一套纪律：**全部字段用 `.catch()` 兜底**。
 * URL 是用户可以随意编辑的输入，一个拼错的 `platform` 不该让整页 500，
 * 而应该退回空串，由服务层补上默认槽位。
 */

import { z } from "zod";

import { CONTENT_FORMATS, CONTENT_PLATFORMS } from "@/lib/content-options";
import { readParam, type RawSearchParams } from "@/lib/search-params";

export const contentSlotQuerySchema = z.object({
  /** 商品 id 的格式合法性交给仓储（DB 是 uuid，Mock 是可读 id），这里只拦明显异常值 */
  productId: z.string().trim().max(64).catch(""),
  /**
   * 空串表示「未指定」，由服务层补默认值；刻意不用 null，
   * 避免和「参数缺失」两种语义混在一起，也让下游只需处理 `string` 一种输入。
   * 用 union 而不是裸 `z.enum(...)`：zod v4 的 `.catch()` 只接受本体的输出类型，
   * 直接 `.catch("")` 会编译不过。
   */
  platform: z.union([z.enum(CONTENT_PLATFORMS), z.literal("")]).catch(""),
  format: z.union([z.enum(CONTENT_FORMATS), z.literal("")]).catch(""),
});

export type ContentSlotQueryInput = z.infer<typeof contentSlotQuerySchema>;

/** 解析内容工厂的槽位查询参数，永不抛错 */
export function parseContentSlotQuery(
  raw: RawSearchParams = {},
): ContentSlotQueryInput {
  return contentSlotQuerySchema.parse({
    productId: readParam(raw, "productId"),
    platform: readParam(raw, "platform"),
    format: readParam(raw, "format"),
  });
}
