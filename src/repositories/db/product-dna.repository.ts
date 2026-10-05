/**
 * Product DNA 仓储 · 数据库实现
 *
 * 表约束：product_dna.product_id 上有唯一索引，一个商品同时只保留一份 DNA。
 * 因此「重新分析」走 update，「首次生成」走 create —— 顺序被写错时能立刻发现，
 * 而不是悄悄产生两份互相矛盾的 DNA。
 *
 * 本阶段（S1-1）只提供读写能力，不调用任何模型；DNA 内容由后续 Product Agent 产出。
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { productDna } from "@/db/schema";
import { isUuid } from "@/lib/id";
import { AppError } from "@/lib/result";
import type { ProductDNA } from "@/types";

import type {
  NewProductDnaInput,
  ProductDnaRepository,
  UpdateProductDnaInput,
} from "../types";
import { mapDatabaseError } from "./errors";
import { mapProductDnaRow } from "./mappers";

/** 领域字段 → 数据库列 的公共映射（不含归属商品） */
function toDnaColumns(input: NewProductDnaInput) {
  return {
    category: input.category,
    subCategory: input.subCategory,
    visualFeatures: input.visualFeatures,
    coreFeatures: input.coreFeatures,
    sellingPoints: input.sellingPoints,
    targetUsers: input.targetUsers,
    scenarios: input.consumptionScenarios,
    painPoints: input.userPainPoints,
    marketingAngles: input.marketingAngles,
    riskNotes: input.riskNotes,
    aiVersion: input.aiVersion,
    confidence: input.confidence,
    approved: input.approved,
  };
}

export function createDbProductDnaRepository(): ProductDnaRepository {
  return {
    async getByProductId(productId) {
      if (!isUuid(productId)) {
        return null;
      }
      try {
        const rows = await getDb()
          .select()
          .from(productDna)
          .where(eq(productDna.productId, productId))
          .limit(1);
        const row = rows[0];
        return row ? mapProductDnaRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载 Product DNA");
      }
    },

    async create(input: NewProductDnaInput): Promise<ProductDNA> {
      if (!isUuid(input.productId)) {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: "Product DNA 生成失败：商品 ID 不合法",
          detail: `productId=${input.productId}`,
          retryable: false,
        });
      }
      try {
        const rows = await getDb()
          .insert(productDna)
          .values({ productId: input.productId, ...toDnaColumns(input) })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "Product DNA 保存失败：数据库未返回记录",
          });
        }
        return mapProductDnaRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "保存 Product DNA");
      }
    },

    async update(productId: string, patch: UpdateProductDnaInput): Promise<ProductDNA> {
      if (!isUuid(productId)) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "该商品尚未生成 Product DNA",
          detail: `productId=${productId}`,
        });
      }
      try {
        const values: Partial<typeof productDna.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (patch.category !== undefined) values.category = patch.category;
        if (patch.subCategory !== undefined) values.subCategory = patch.subCategory;
        if (patch.visualFeatures !== undefined) {
          values.visualFeatures = patch.visualFeatures;
        }
        if (patch.coreFeatures !== undefined) values.coreFeatures = patch.coreFeatures;
        if (patch.sellingPoints !== undefined) values.sellingPoints = patch.sellingPoints;
        if (patch.targetUsers !== undefined) values.targetUsers = patch.targetUsers;
        if (patch.consumptionScenarios !== undefined) {
          values.scenarios = patch.consumptionScenarios;
        }
        if (patch.userPainPoints !== undefined) values.painPoints = patch.userPainPoints;
        if (patch.marketingAngles !== undefined) {
          values.marketingAngles = patch.marketingAngles;
        }
        if (patch.riskNotes !== undefined) values.riskNotes = patch.riskNotes;
        if (patch.aiVersion !== undefined) values.aiVersion = patch.aiVersion;
        if (patch.confidence !== undefined) values.confidence = patch.confidence;
        if (patch.approved !== undefined) values.approved = patch.approved;

        const rows = await getDb()
          .update(productDna)
          .set(values)
          .where(eq(productDna.productId, productId))
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "该商品尚未生成 Product DNA",
            detail: `productId=${productId}`,
          });
        }
        return mapProductDnaRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新 Product DNA");
      }
    },
  };
}
