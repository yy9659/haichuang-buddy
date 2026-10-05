"use server";

import { revalidatePath } from "next/cache";
import type { Result } from "@/lib/result";
import { addDemoSales, clearDemoSales, deleteSaleRecord, importSalesCsv, saveSaleRecords, updateSaleRecord } from "@/services/sales.service";
import type { ParsedSaleRow } from "@/lib/sales-csv";
import type { SaleRecordChanges } from "@/lib/sales-entry";
import type { SaleRecord } from "@/types";

export async function saveSaleRecordsAction(rows: ParsedSaleRow[]): Promise<Result<{ inserted: number; skipped: number }>> {
  const result = await saveSaleRecords(rows);
  if (result.ok) revalidatePath("/analytics");
  return result;
}

export async function updateSaleRecordAction(id: string, changes: SaleRecordChanges): Promise<Result<SaleRecord>> {
  const result = await updateSaleRecord(id, changes);
  if (result.ok) revalidatePath("/analytics");
  return result;
}

export async function importSalesCsvAction(csv: string): Promise<Result<{ inserted: number; skipped: number }>> {
  const result = await importSalesCsv(csv);
  if (result.ok) revalidatePath("/analytics");
  return result;
}

export async function addDemoSalesAction(): Promise<Result<{ inserted: number }>> {
  const result = await addDemoSales();
  if (result.ok) revalidatePath("/analytics");
  return result;
}

export async function clearDemoSalesAction(): Promise<Result<{ deleted: number }>> {
  const result = await clearDemoSales();
  if (result.ok) revalidatePath("/analytics");
  return result;
}

export async function deleteSaleRecordAction(id: string): Promise<Result<{ deleted: boolean }>> {
  const result = await deleteSaleRecord(id);
  if (result.ok) revalidatePath("/analytics");
  return result;
}
