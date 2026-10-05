import { MAX_SALES_CSV_BYTES, MAX_SALES_IMPORT_ROWS, parseDelimitedCells, type SalesParseResult } from "./sales-csv";
import { parseSaleDraft } from "./sales-entry";

export type SalesCell = string | number | boolean | Date | null;
export type SalesTable = SalesCell[][];
export const SALES_COLUMNS = [
  { key: "saleDate", label: "销售日期", required: true, aliases: ["日期", "销售日期", "交易日期", "交易时间", "支付时间", "成交时间"] },
  { key: "productName", label: "商品名称", required: true, aliases: ["商品", "商品名称", "产品名称", "品名", "商品名"] },
  { key: "quantity", label: "数量", required: true, aliases: ["数量", "销售数量", "售出数量", "件数", "购买数量"] },
  { key: "revenue", label: "实收金额", required: true, aliases: ["实收", "实收金额", "实付金额", "实际收入", "收款金额", "收入金额"] },
  { key: "channel", label: "销售渠道", required: false, aliases: ["渠道", "销售渠道", "平台", "来源", "销售平台"] },
  { key: "cost", label: "成本金额", required: false, aliases: ["成本", "成本金额", "商品成本", "进货成本"] },
  { key: "recordNo", label: "记录编号", required: false, aliases: ["记录编号", "流水号", "记录号", "交易号", "编号", "订单编号", "订单号"] },
] as const;
export type SalesColumnKey = typeof SALES_COLUMNS[number]["key"];
export type SalesColumnMapping = Record<SalesColumnKey, number>;
const headerKey = (cell: SalesCell) => String(cell ?? "").trim().replace(/\s|[（(](?:元|人民币|RMB)[)）]/g, "");

export function parseSalesTableText(raw: string): SalesTable {
  if (new TextEncoder().encode(raw).length > MAX_SALES_CSV_BYTES) throw new Error("表格内容较多，请分批导入，每批最多 500 条。");
  return parseDelimitedCells(raw.replace(/^\uFEFF/, ""), raw.split(/\r?\n/, 1)[0].includes("\t") ? "\t" : ",");
}

export function normalizeSalesTable(table: SalesTable): SalesTable {
  const rows = table.filter(row => row.some(cell => cell !== null && String(cell).trim() !== ""));
  const header = rows.slice(0, 6).findIndex(row => SALES_COLUMNS.filter(column => row.some(cell => (column.aliases as readonly string[]).includes(headerKey(cell)))).length >= 3);
  return rows.slice(Math.max(0, header));
}

export function guessSalesColumns(header: readonly SalesCell[]): SalesColumnMapping {
  return Object.fromEntries(SALES_COLUMNS.map(column => [column.key, header.findIndex(cell => (column.aliases as readonly string[]).includes(headerKey(cell)))])) as SalesColumnMapping;
}

function dateText(cell: SalesCell | undefined): string {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? "" : cell.toISOString().slice(0, 10);
  const text = String(cell ?? "").trim();
  const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|\s.*|T.*)?$/.exec(text);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : text;
}

function amountText(cell: SalesCell | undefined): string {
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
  return String(cell ?? "").trim().replace(/^[¥￥]\s*/, "").replace(/元$/, "").replace(/,/g, "").trim();
}

/** 无编号的表格生成稳定编号，重复上传/粘贴不会再次记账；同批相同行保留各自序号。 */
export async function prepareSalesTable(table: SalesTable, mapping: SalesColumnMapping, defaultChannel: string): Promise<SalesParseResult> {
  const missing = SALES_COLUMNS.filter(column => column.required && mapping[column.key] < 0);
  if (missing.length) return { ok: false, errors: [`请为${missing.map(column => column.label).join("、")}选择对应的表格列。`] };
  const indices = Object.values(mapping).filter(index => index >= 0);
  if (new Set(indices).size !== indices.length) return { ok: false, errors: ["同一列不能对应两个不同字段，请检查列对应关系。"] };
  if (table.length < 2) return { ok: false, errors: ["表格里还没有销售记录，请保留表头并填入销售数据。"] };
  if (table.length - 1 > MAX_SALES_IMPORT_ROWS) return { ok: false, errors: ["每次最多导入 500 条，请分批导入。"] };
  const rows = [], errors: string[] = [], seen = new Map<string, number>();
  for (const [index, row] of table.slice(1).entries()) {
    const value = (key: SalesColumnKey) => mapping[key] >= 0 ? row[mapping[key]] : undefined;
    const fields = {
      saleDate: dateText(value("saleDate")), productName: String(value("productName") ?? "").trim(),
      channel: mapping.channel < 0 ? defaultChannel.trim() : String(value("channel") ?? "").trim(),
      quantity: String(value("quantity") ?? "").trim(), revenue: amountText(value("revenue")), cost: amountText(value("cost")),
    };
    const rawNo = value("recordNo");
    if (typeof rawNo === "number" && !Number.isSafeInteger(rawNo)) {
      errors.push(`第 ${index + 2} 行：记录编号过长或不是整数，请在原表格中把编号设为文本后再导入。`);
      continue;
    }
    const originalNo = String(rawNo ?? "").trim();
    const parsed = parseSaleDraft({ ...fields, recordNo: originalNo || "AUTO" });
    if (!parsed.ok) { errors.push(...parsed.errors.map(error => error.replace("第 2 行", `第 ${index + 2} 行`))); continue; }
    const item = parsed.rows[0];
    if (!originalNo) {
      const canonical = JSON.stringify([item.saleDate, item.productName, item.channel, item.quantity, item.revenueCents, item.costCents]);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
      const occurrence = (seen.get(key) ?? 0) + 1; seen.set(key, occurrence);
      item.recordNo = `IMPORT-${key}-${occurrence}`;
    }
    rows.push(item);
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 8) };
  if (new Set(rows.map(row => row.recordNo)).size !== rows.length) return { ok: false, errors: ["表格中有重复编号；一条商品销售明细需使用独立编号，请核对后导入。"] };
  return { ok: true, rows };
}
