import { z } from "zod";
import { MAX_SALES_IMPORT_ROWS, SALES_CSV_HEADER, parseSalesCsv, type ParsedSaleRow, type SalesParseResult } from "./sales-csv";

export type SaleRecordChanges = Omit<ParsedSaleRow, "recordNo">;
export interface SaleDraft {
  recordNo: string;
  saleDate: string;
  productName: string;
  channel: string;
  quantity: string;
  revenue: string;
  cost: string;
}

export const csvCell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
export const yuan = (cents: number) => (cents / 100).toFixed(2);

export function parseSaleDraft(draft: SaleDraft): SalesParseResult {
  const fields = [draft.recordNo, draft.saleDate, draft.productName, draft.channel, draft.quantity, draft.revenue, draft.cost];
  return parseSalesCsv(`${SALES_CSV_HEADER}\n${fields.map(value => csvCell(value.trim())).join(",")}`);
}

export function saleRowsToCsv(rows: readonly ParsedSaleRow[]): string {
  return [SALES_CSV_HEADER, ...rows.map(row => [row.recordNo, row.saleDate, row.productName, row.channel, String(row.quantity), yuan(row.revenueCents), row.costCents === null ? "" : yuan(row.costCents)].map(csvCell).join(","))].join("\r\n");
}

/** Server Actions 重做形状、金额和日期验证，不信任浏览器预览的结论。 */
export function validateSaleRows(input: unknown): SalesParseResult {
  const shape = z.array(z.object({
    recordNo: z.string().max(80), saleDate: z.string().max(10), productName: z.string().max(100), channel: z.string().max(40),
    quantity: z.number().int().min(1).max(100000),
    revenueCents: z.number().int().positive().max(99_999_999),
    costCents: z.number().int().min(0).max(99_999_999).nullable(),
  }).strict()).min(1).max(MAX_SALES_IMPORT_ROWS).safeParse(input);
  if (!shape.success) return { ok: false, errors: ["请检查销售记录的日期、商品、数量及金额，每次最多保存 500 条。"] };
  return parseSalesCsv(saleRowsToCsv(shape.data));
}
