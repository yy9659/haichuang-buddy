import type { NewSaleRecord, SaleRecord } from "@/types";
import type { SalesRepository } from "../types";

const records: SaleRecord[] = [];

export function createMockSalesRepository(): SalesRepository {
  return {
    async list(businessId) {
      return records.filter((row) => row.businessId === businessId)
        .sort((a, b) => b.saleDate.localeCompare(a.saleDate));
    },
    async import(rows: NewSaleRecord[]) {
      let added = 0;
      for (const row of rows) {
        if (records.some((item) => item.businessId === row.businessId && item.recordNo === row.recordNo)) continue;
        records.push({ ...row, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
        added += 1;
      }
      return added;
    },
    async deleteOne(businessId, id) {
      const index = records.findIndex((row) => row.businessId === businessId && row.id === id);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    },
    async update(businessId, id, changes) {
      const index = records.findIndex(row => row.businessId === businessId && row.id === id);
      if (index < 0) return null;
      records[index] = { ...records[index], ...changes };
      return { ...records[index] };
    },
    async deleteDemo(businessId) {
      let removed = 0;
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].businessId === businessId && records[i].isDemo) { records.splice(i, 1); removed += 1; }
      }
      return removed;
    },
  };
}
