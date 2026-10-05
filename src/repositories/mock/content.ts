/**
 * 内容仓储 · Mock 实现
 *
 * 与数据库实现保持同一套语义（这是「切数据源不改上层」的前提）：
 * - 一个「商品 × 平台 × 内容形态」槽位同时只保留一条内容
 *   （对应 `contents_slot_unique`），已存在时 create 直接报错，重新生成走 updateBySlot；
 * - 列表顺序为「最新在前」，与数据库的 `ORDER BY created_at DESC` 一致；
 * - 商品被删除时其内容一并清理（对应 `contents.product_id ON DELETE CASCADE`）。
 *
 * 初始值是 Mock 演示内容（与商品一致，与品牌档案刻意不同），理由写在 `./store.ts`。
 * 新生成的内容会带 `aiVersion` / `confidence`，界面据此标出「AI 生成」。
 */

import { formatDateTime } from "@/lib/datetime";
import { createLocalId } from "@/lib/id";
import { AppError } from "@/lib/result";
import { MOCK_CONTENT_PLAN } from "@/lib/mock";
import type { ContentItem, ContentSlot } from "@/types";

import { applyContentPatch, toContentItem } from "../content-item";
import type {
  ContentRepository,
  NewContentInput,
  UpdateContentInput,
} from "../types";
import {
  findStoredContentBySlot,
  listStoredContents,
  putStoredContent,
  replaceStoredContent,
} from "./store";

export function createMockContentRepository(): ContentRepository {
  return {
    async list(): Promise<ContentItem[]> {
      // 返回浅拷贝数组：调用方排序 / 截断不应影响 store 的内部顺序
      return [...listStoredContents()];
    },

    async getPlan() {
      return [...MOCK_CONTENT_PLAN];
    },

    async findBySlot(slot: ContentSlot): Promise<ContentItem | null> {
      return findStoredContentBySlot(slot) ?? null;
    },

    async create(input: NewContentInput): Promise<ContentItem> {
      if (findStoredContentBySlot(input)) {
        throw new AppError({
          code: "DB_ERROR",
          message: "该「商品 × 平台 × 内容形态」下已存在内容",
          detail: "如需覆盖请调用 updateBySlot（重新生成内容）",
        });
      }
      const now = new Date();
      const stamp = formatDateTime(now);
      const content = toContentItem(input, {
        id: createLocalId("content"),
        createdAt: stamp,
        updatedAt: stamp,
      });
      putStoredContent(content);
      return content;
    },

    async updateBySlot(
      slot: ContentSlot,
      patch: UpdateContentInput,
    ): Promise<ContentItem> {
      const current = findStoredContentBySlot(slot);
      if (!current) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "该「商品 × 平台 × 内容形态」下尚未生成内容",
          detail: `productId=${slot.productId} platform=${slot.platform} format=${slot.format}`,
        });
      }
      const next = applyContentPatch(current, patch, {
        updatedAt: formatDateTime(new Date()),
      });
      replaceStoredContent(next);
      return next;
    },
  };
}
