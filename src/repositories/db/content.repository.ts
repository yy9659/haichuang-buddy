/**
 * 内容仓储 · 数据库实现（S3-2）
 *
 * 表约束：`contents_slot_unique`（product_id, platform, format）唯一，
 * 一个槽位同时只保留一条内容。因此「重新生成」走 updateBySlot、「首次生成」走 create ——
 * 顺序写错时立刻报错，而不是悄悄堆出两份互相矛盾的内容。
 *
 * `metrics` 刻意不由本仓储写入：经营数据来自平台回流（S6 Analytics），
 * 新建时用建表默认值（全 0），更新时保持原值。
 */

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { contents } from "@/db/schema";
import { AppError } from "@/lib/result";
import type { ContentItem, ContentPlanItem, ContentSlot } from "@/types";

import type {
  ContentRepository,
  NewContentInput,
  UpdateContentInput,
} from "../types";
import { mapDatabaseError } from "./errors";
import { mapContentRow } from "./mappers";
import { resolvePrimaryBusinessId } from "./shared";

/** 领域字段 → 数据库列（槽位三列与归属商家单独处理） */
function toContentColumns(input: Omit<NewContentInput, "businessId">) {
  return {
    productId: input.productId,
    productName: input.productName,
    platform: input.platform,
    format: input.format,
    status: input.status,
    title: input.title,
    hook: input.hook,
    body: input.body,
    cta: input.cta,
    hashtags: input.hashtags,
    visualSuggestions: input.visualSuggestions,
    shotList: input.shotList,
    voiceover: input.voiceover,
    riskNotes: input.riskNotes,
    aiVersion: input.aiVersion,
    confidence: input.confidence,
  };
}

/** 槽位 → where 条件（与唯一索引的三列保持同一口径） */
function slotCondition(slot: ContentSlot) {
  return and(
    eq(contents.productId, slot.productId),
    eq(contents.platform, slot.platform),
    eq(contents.format, slot.format),
  );
}

export function createDbContentRepository(): ContentRepository {
  return {
    /**
     * 列表按创建时间倒序（最新在前）。
     * 与 Mock 实现的「新生成的插到最前」同一语义 —— 两套数据源的顺序口径必须一致。
     */
    async list(): Promise<ContentItem[]> {
      try {
        const businessId = await resolvePrimaryBusinessId();
        const rows = await getDb()
          .select()
          .from(contents)
          .where(eq(contents.businessId, businessId))
          .orderBy(desc(contents.createdAt));
        return rows.map(mapContentRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载内容资产");
      }
    },

    /**
     * 「今日排期」在数据库里**还没有表** —— 它属于 Agent Workflow（S4）范围：
     * 排期是「工作流给内容排的时间」，不是内容本身。
     *
     * 这里返回空数组而不是抛 NOT_IMPLEMENTED，原因很具体：内容工厂的**核心能力**
     * （生成内容 + 查看内容资产）在 db 模式下必须可用，不能因为一个附属区块未落库
     * 就让整页报错。服务层会一并返回 `dataSource`，界面据此如实说明
     * 「今日排期尚未接入数据源」，因此这不是静默降级。
     */
    async getPlan(): Promise<ContentPlanItem[]> {
      return [];
    },

    async findBySlot(slot: ContentSlot): Promise<ContentItem | null> {
      try {
        const businessId = await resolvePrimaryBusinessId();
        const rows = await getDb()
          .select()
          .from(contents)
          .where(and(eq(contents.businessId, businessId), slotCondition(slot)))
          .limit(1);
        const row = rows[0];
        return row ? mapContentRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "读取内容");
      }
    },

    async create(input: NewContentInput): Promise<ContentItem> {
      try {
        const businessId = input.businessId ?? (await resolvePrimaryBusinessId());

        const rows = await getDb()
          .insert(contents)
          .values({ businessId, ...toContentColumns(input) })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "内容保存失败：数据库未返回记录",
          });
        }
        return mapContentRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "保存内容");
      }
    },

    async updateBySlot(
      slot: ContentSlot,
      patch: UpdateContentInput,
    ): Promise<ContentItem> {
      try {
        const businessId = await resolvePrimaryBusinessId();
        const values: Partial<typeof contents.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (patch.productName !== undefined) values.productName = patch.productName;
        if (patch.status !== undefined) values.status = patch.status;
        if (patch.title !== undefined) values.title = patch.title;
        if (patch.hook !== undefined) values.hook = patch.hook;
        if (patch.body !== undefined) values.body = patch.body;
        if (patch.cta !== undefined) values.cta = patch.cta;
        if (patch.hashtags !== undefined) values.hashtags = patch.hashtags;
        if (patch.visualSuggestions !== undefined) {
          values.visualSuggestions = patch.visualSuggestions;
        }
        if (patch.shotList !== undefined) values.shotList = patch.shotList;
        if (patch.voiceover !== undefined) values.voiceover = patch.voiceover;
        if (patch.riskNotes !== undefined) values.riskNotes = patch.riskNotes;
        if (patch.aiVersion !== undefined) values.aiVersion = patch.aiVersion;
        if (patch.confidence !== undefined) values.confidence = patch.confidence;

        const rows = await getDb()
          .update(contents)
          .set(values)
          .where(and(eq(contents.businessId, businessId), slotCondition(slot)))
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "该「商品 × 平台 × 内容形态」下尚未生成内容",
            detail: `productId=${slot.productId} platform=${slot.platform} format=${slot.format}`,
          });
        }
        return mapContentRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新内容");
      }
    },
  };
}
