import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { salesRecords } from "@/db/schema";
import type { NewSaleRecord, SaleRecord } from "@/types";

import type { SalesRepository } from "../types";
import { mapDatabaseError } from "./errors";

function mapRow(row: typeof salesRecords.$inferSelect): SaleRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    recordNo: row.recordNo,
    saleDate: row.saleDate,
    productName: row.productName,
    channel: row.channel,
    quantity: row.quantity,
    revenueCents: row.revenueCents,
    costCents: row.costCents,
    isDemo: row.isDemo,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createDbSalesRepository(): SalesRepository {
  return {
    async list(businessId) {
      try {
        const rows = await getDb().select().from(salesRecords)
          .where(eq(salesRecords.businessId, businessId))
          .orderBy(desc(salesRecords.saleDate), desc(salesRecords.createdAt));
        return rows.map(mapRow);
      } catch (cause) { throw mapDatabaseError(cause, "读取销售记录"); }
    },
    async import(rows: NewSaleRecord[]) {
      if (rows.length === 0) return 0;
      try {
        const inserted = await getDb().insert(salesRecords).values(rows)
          .onConflictDoNothing({ target: [salesRecords.businessId, salesRecords.recordNo] })
          .returning({ id: salesRecords.id });
        return inserted.length;
      } catch (cause) { throw mapDatabaseError(cause, "导入销售记录"); }
    },
    async deleteOne(businessId, id) {
      try {
        const deleted = await getDb().delete(salesRecords)
          .where(and(eq(salesRecords.businessId, businessId), eq(salesRecords.id, id)))
          .returning({ id: salesRecords.id });
        return deleted.length > 0;
      } catch (cause) { throw mapDatabaseError(cause, "删除销售记录"); }
    },
    async update(businessId, id, changes) {
      try {
        const [updated] = await getDb().update(salesRecords).set(changes)
          .where(and(eq(salesRecords.businessId, businessId), eq(salesRecords.id, id))).returning();
        return updated ? mapRow(updated) : null;
      } catch (cause) { throw mapDatabaseError(cause, "修改销售记录"); }
    },
    async deleteDemo(businessId) {
      try {
        const deleted = await getDb().delete(salesRecords)
          .where(and(eq(salesRecords.businessId, businessId), eq(salesRecords.isDemo, true)))
          .returning({ id: salesRecords.id });
        return deleted.length;
      } catch (cause) { throw mapDatabaseError(cause, "清除演示销售记录"); }
    },
  };
}
