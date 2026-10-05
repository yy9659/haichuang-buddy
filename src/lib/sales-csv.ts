import type { NewSaleRecord } from "@/types";

export const SALES_CSV_HEADER = "记录编号,销售日期,商品名称,销售渠道,数量,实收金额,成本金额";
export const SALES_CSV_TEMPLATE = `${SALES_CSV_HEADER}\r\n`;
/** 留足 Server Action 请求信封空间；500 行正常模板远低于此上限。 */
export const MAX_SALES_CSV_BYTES = 256 * 1024;
export const MAX_SALES_IMPORT_ROWS = 500;

export type ParsedSaleRow = Omit<NewSaleRecord, "businessId" | "isDemo">;
export type SalesParseResult =
  | { ok: true; rows: ParsedSaleRow[] }
  | { ok: false; errors: string[] };

/** 解析标准 CSV 引号与逗号；拒绝未闭合引号，避免静默错列。 */
export function parseDelimitedCells(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (quoted) quoted = false;
      else if (cell.length === 0) quoted = true;
      else throw new Error("CSV 引号位置不正确");
    } else if (char === delimiter && !quoted) {
      cells.push(cell.trim()); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      cells.push(cell.trim());
      if (cells.some(Boolean)) rows.push(cells);
      cells = []; cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("CSV 存在未闭合的引号");
  cells.push(cell.trim());
  if (cells.some(Boolean)) rows.push(cells);
  return rows;
}

function parseMoney(value: string, optional: boolean): number | null {
  if (optional && value === "") return null;
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) return NaN;
  const [yuan, cents = ""] = value.split(".");
  return Number(yuan) * 100 + Number(cents.padEnd(2, "0"));
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseSalesCsv(raw: string): SalesParseResult {
  if (new TextEncoder().encode(raw).length > MAX_SALES_CSV_BYTES) {
    return { ok: false, errors: ["CSV 文件不能超过 256 KB"] };
  }
  let cells: string[][];
  try { cells = parseDelimitedCells(raw.replace(/^\uFEFF/, "")); }
  catch (error) { return { ok: false, errors: [(error as Error).message] }; }
  if (cells[0]?.join(",") !== SALES_CSV_HEADER) {
    return { ok: false, errors: [`表头须为：${SALES_CSV_HEADER}`] };
  }
  if (cells.length < 2) return { ok: false, errors: ["表格里还没有销售记录"] };
  if (cells.length - 1 > MAX_SALES_IMPORT_ROWS) {
    return { ok: false, errors: [`每次最多导入 ${MAX_SALES_IMPORT_ROWS} 行，请拆分文件`] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  const rows: ParsedSaleRow[] = [];
  cells.slice(1).forEach((line, index) => {
    const number = index + 2;
    if (line.length !== 7) { errors.push(`第 ${number} 行：列数应为 7`); return; }
    const [recordNo, saleDate, productName, channel, quantityText, revenueText, costText] = line;
    const quantity = Number(quantityText);
    const revenueCents = parseMoney(revenueText, false);
    const costCents = parseMoney(costText, true);
    if (!recordNo || recordNo.length > 80 || !/^[\p{L}\p{N}_-]+$/u.test(recordNo)) errors.push(`第 ${number} 行：记录编号只能用文字、数字、- 或 _，最多 80 字`);
    if (seen.has(recordNo)) errors.push(`第 ${number} 行：记录编号在文件内重复`);
    seen.add(recordNo);
    if (!validDate(saleDate)) errors.push(`第 ${number} 行：销售日期须为有效的 YYYY-MM-DD`);
    if (!productName || productName.length > 100) errors.push(`第 ${number} 行：商品名称必填，最多 100 字`);
    if (!channel || channel.length > 40) errors.push(`第 ${number} 行：销售渠道必填，最多 40 字`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) errors.push(`第 ${number} 行：数量须为 1 到 100000 的整数`);
    if (revenueCents === null || !Number.isFinite(revenueCents) || revenueCents <= 0) errors.push(`第 ${number} 行：实收金额须大于 0，且不超过 999999.99 元`);
    if (costCents !== null && (!Number.isFinite(costCents) || costCents < 0)) errors.push(`第 ${number} 行：成本金额须为非负数，且不超过 999999.99 元`);
    if (errors.length === 0 || !errors.some((item) => item.startsWith(`第 ${number} 行`))) {
      rows.push({ recordNo, saleDate, productName, channel, quantity, revenueCents: revenueCents!, costCents });
    }
  });
  return errors.length ? { ok: false, errors: errors.slice(0, 8) } : { ok: true, rows };
}
