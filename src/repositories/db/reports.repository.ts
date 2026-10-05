/**
 * 经营日报仓储 · 数据库实现（S7 补齐）
 *
 * 与 Mock 实现保持同一套语义：
 * - 列表按创建时间倒序（`findLatest` 即列表首项）；
 * - `findById` 目标不存在时返回 null。
 *
 * 多租户：日报归属商家，读取按「当前会话的商家」过滤。
 */

import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { businessReports } from "@/db/schema";
import { AppError } from "@/lib/result";
import type { BusinessReport } from "@/types";

import type { AnalyticsReportRepository, NewBusinessReportInput } from "../types";
import { mapDatabaseError } from "./errors";
import { mapBusinessReportRow } from "./mappers";
import { resolvePrimaryBusinessId } from "./shared";

export function createDbAnalyticsReportRepository(): AnalyticsReportRepository {
  return {
    async create(input: NewBusinessReportInput): Promise<BusinessReport> {
      try {
        const rows = await getDb()
          .insert(businessReports)
          .values({
            businessId: input.businessId,
            snapshot: input.snapshot,
            report: input.report,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "保存经营日报失败：数据库未返回记录",
          });
        }
        return mapBusinessReportRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "保存经营日报");
      }
    },

    async findLatest() {
      try {
        const businessId = await resolvePrimaryBusinessId();
        const rows = await getDb()
          .select()
          .from(businessReports)
          .where(eq(businessReports.businessId, businessId))
          .orderBy(desc(businessReports.createdAt))
          .limit(1);
        const row = rows[0];
        return row ? mapBusinessReportRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "读取经营日报");
      }
    },

    async listRecent(limit) {
      try {
        const businessId = await resolvePrimaryBusinessId();
        const base = getDb()
          .select()
          .from(businessReports)
          .where(eq(businessReports.businessId, businessId))
          .orderBy(desc(businessReports.createdAt))
          .$dynamic();
        const rows = await (limit === undefined ? base : base.limit(limit));
        return rows.map(mapBusinessReportRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "读取经营日报列表");
      }
    },

    async findById(id: string) {
      try {
        const businessId = await resolvePrimaryBusinessId();
        const rows = await getDb()
          .select()
          .from(businessReports)
          .where(eq(businessReports.id, id))
          .limit(1);
        const row = rows[0];
        // 归属校验：不属于当前商家视同不存在（防 id 枚举）
        if (!row || row.businessId !== businessId) {
          return null;
        }
        return mapBusinessReportRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "读取经营日报");
      }
    },
  };
}
