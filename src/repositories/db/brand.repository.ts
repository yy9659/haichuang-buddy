/**
 * 品牌档案仓储 · 数据库实现（S3-1）
 *
 * 表约束：`brand_profiles.business_id` 上有唯一索引，一个商家同时只保留一份品牌档案。
 * 因此「重新生成」走 update，「首次生成」走 create —— 顺序写错时立刻报错，
 * 而不是悄悄留下两份互相矛盾的品牌档案。
 *
 * 关于 completeness：它是**派生量**（由档案内容现算，见 `../brand-profile`），
 * 因此不进数据库、也不接受调用方传入；映射时统一由 `mapBrandProfileRow` 现算，
 * 这样「改了完整性算法」不需要回填历史数据，也不会出现库里与界面上的数字不一致。
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { brandProfiles } from "@/db/schema";
import { AppError } from "@/lib/result";
import type { BrandProfile } from "@/types";

import type {
  BrandRepository,
  NewBrandProfileInput,
  UpdateBrandProfileInput,
} from "../types";
import { mapDatabaseError } from "./errors";
import { mapBrandProfileRow } from "./mappers";
import { findPrimaryBusinessIdOrNull, resolvePrimaryBusinessId } from "./shared";

/** 领域字段 → 数据库列 的公共映射（不含归属商家） */
function toBrandColumns(input: Omit<NewBrandProfileInput, "businessId">) {
  return {
    positioning: input.positioning,
    brandStory: input.brandStory,
    slogan: input.slogan,
    ipConcept: input.ipConcept,
    brandValues: input.brandValues,
    targetAudience: input.targetAudience,
    brandPersonality: input.brandPersonality,
    toneOfVoice: input.toneOfVoice,
    visualKeywords: input.visualKeywords,
    riskNotes: input.riskNotes,
    sourceProductId: input.sourceProductId ?? null,
    aiVersion: input.aiVersion,
    confidence: input.confidence,
    approved: input.approved,
  };
}

export function createDbBrandRepository(): BrandRepository {
  return {
    async getProfile(): Promise<BrandProfile | null> {
      try {
        // 商家表为空时直接视为「尚未生成」而不是报错：
        // 否则一个空库会让整个品牌页面变成错误页，而不是可操作的 empty 态。
        const businessId = await findPrimaryBusinessIdOrNull();
        if (!businessId) {
          return null;
        }
        const rows = await getDb()
          .select()
          .from(brandProfiles)
          .where(eq(brandProfiles.businessId, businessId))
          .limit(1);
        const row = rows[0];
        return row ? mapBrandProfileRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载品牌档案");
      }
    },

    async create(input: NewBrandProfileInput): Promise<BrandProfile> {
      try {
        const businessId = input.businessId ?? (await resolvePrimaryBusinessId());

        const rows = await getDb()
          .insert(brandProfiles)
          .values({ businessId, ...toBrandColumns(input) })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "品牌档案保存失败：数据库未返回记录",
          });
        }
        return mapBrandProfileRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "保存品牌档案");
      }
    },

    async update(patch: UpdateBrandProfileInput): Promise<BrandProfile> {
      try {
        const businessId = await resolvePrimaryBusinessId();

        const values: Partial<typeof brandProfiles.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (patch.positioning !== undefined) values.positioning = patch.positioning;
        if (patch.brandStory !== undefined) values.brandStory = patch.brandStory;
        if (patch.slogan !== undefined) values.slogan = patch.slogan;
        if (patch.ipConcept !== undefined) values.ipConcept = patch.ipConcept;
        if (patch.brandValues !== undefined) values.brandValues = patch.brandValues;
        if (patch.targetAudience !== undefined) {
          values.targetAudience = patch.targetAudience;
        }
        if (patch.brandPersonality !== undefined) {
          values.brandPersonality = patch.brandPersonality;
        }
        if (patch.toneOfVoice !== undefined) values.toneOfVoice = patch.toneOfVoice;
        if (patch.visualKeywords !== undefined) {
          values.visualKeywords = patch.visualKeywords;
        }
        if (patch.riskNotes !== undefined) values.riskNotes = patch.riskNotes;
        if (patch.sourceProductId !== undefined) {
          values.sourceProductId = patch.sourceProductId;
        }
        if (patch.aiVersion !== undefined) values.aiVersion = patch.aiVersion;
        if (patch.confidence !== undefined) values.confidence = patch.confidence;
        if (patch.approved !== undefined) values.approved = patch.approved;

        const rows = await getDb()
          .update(brandProfiles)
          .set(values)
          .where(eq(brandProfiles.businessId, businessId))
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "该商家尚未生成品牌档案",
            detail: `businessId=${businessId}`,
          });
        }
        return mapBrandProfileRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新品牌档案");
      }
    },
  };
}
