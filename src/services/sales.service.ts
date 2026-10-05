import { parseSalesCsv } from "@/lib/sales-csv";
import { validateSaleRows, type SaleRecordChanges } from "@/lib/sales-entry";
import type { ParsedSaleRow } from "@/lib/sales-csv";
import { salesRecordsFingerprint } from "@/analytics/sales-review";
import { attempt, fail, ok, type Result } from "@/lib/result";
import { getRepositories } from "@/repositories";
import type { NewSaleRecord, SaleRecord, SalesSummary } from "@/types";
import { getCurrentAuthUser } from "./auth.service";

const emptySummary = (isDemo: boolean): SalesSummary => ({
  isDemo, count: 0, revenueCents: 0, quantity: 0, grossProfitCents: null,
  missingCostCount: 0, recentSevenDaysCents: 0, previousSevenDaysCents: 0,
  byProduct: [], byChannel: [], daily: [],
});

function chinaDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function offsetDate(now: Date, days: number): string {
  return chinaDate(new Date(now.getTime() + days * 86_400_000));
}

/** 全部指标只从导入的原始记录按整数分汇总；演示与真实记录分别计算。 */
export function summarizeSales(records: readonly SaleRecord[], isDemo: boolean, now = new Date()): SalesSummary {
  if (!records.length) return emptySummary(isDemo);
  const products = new Map<string, { name: string; revenueCents: number; quantity: number }>();
  const channels = new Map<string, { name: string; revenueCents: number }>();
  const days = new Map<string, number>();
  const recentStart = offsetDate(now, -6);
  const previousStart = offsetDate(now, -13);
  const today = offsetDate(now, 0);
  let revenueCents = 0, quantity = 0, costCents = 0, missingCostCount = 0;
  let recentSevenDaysCents = 0, previousSevenDaysCents = 0;
  for (const row of records) {
    revenueCents += row.revenueCents;
    quantity += row.quantity;
    if (row.costCents === null) missingCostCount += 1;
    else costCents += row.costCents;
    const product = products.get(row.productName) ?? { name: row.productName, revenueCents: 0, quantity: 0 };
    product.revenueCents += row.revenueCents;
    product.quantity += row.quantity;
    products.set(row.productName, product);
    const channel = channels.get(row.channel) ?? { name: row.channel, revenueCents: 0 };
    channel.revenueCents += row.revenueCents;
    channels.set(row.channel, channel);
    days.set(row.saleDate, (days.get(row.saleDate) ?? 0) + row.revenueCents);
    if (row.saleDate >= recentStart && row.saleDate <= today) recentSevenDaysCents += row.revenueCents;
    else if (row.saleDate >= previousStart && row.saleDate < recentStart) previousSevenDaysCents += row.revenueCents;
  }
  return {
    isDemo, count: records.length, revenueCents, quantity,
    grossProfitCents: missingCostCount ? null : revenueCents - costCents,
    missingCostCount, recentSevenDaysCents, previousSevenDaysCents,
    byProduct: [...products.values()].sort((a, b) => b.revenueCents - a.revenueCents),
    byChannel: [...channels.values()].sort((a, b) => b.revenueCents - a.revenueCents),
    daily: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, revenueCents: amount })),
  };
}

export interface SalesOverview {
  real: SalesSummary;
  demo: SalesSummary;
  realRecords: SaleRecord[];
  demoRecords: SaleRecord[];
  fingerprints: { real: string; demo: string };
  comparisonWindows: { recentStart: string; previousStart: string; today: string };
  productOptions?: { name: string; price: number; unit: string }[];
}

export async function getSalesOverview(): Promise<Result<SalesOverview>> {
  const user = await getCurrentAuthUser();
  if (!user) return fail("UNAUTHORIZED", "请先登录");
  return attempt(async () => {
    const repositories = getRepositories();
    const [all, products] = await Promise.all([repositories.sales.list(user.businessId), repositories.products.list()]);
    const realRecords = all.filter((row) => !row.isDemo);
    const demoRecords = all.filter((row) => row.isDemo);
    const now = new Date();
    return {
      real: summarizeSales(realRecords, false, now), demo: summarizeSales(demoRecords, true, now),
      realRecords, demoRecords,
      fingerprints: { real: salesRecordsFingerprint(realRecords, "real", now), demo: salesRecordsFingerprint(demoRecords, "demo", now) },
      comparisonWindows: { recentStart: offsetDate(now, -6), previousStart: offsetDate(now, -13), today: chinaDate(now) },
      productOptions: products.map(({ name, price, unit }) => ({ name, price, unit })),
    };
  });
}

export async function importSalesCsv(csv: string): Promise<Result<{ inserted: number; skipped: number }>> {
  const user = await getCurrentAuthUser();
  if (!user) return fail("UNAUTHORIZED", "请先登录");
  const parsed = parseSalesCsv(csv);
  if (!parsed.ok) return fail("VALIDATION_FAILED", parsed.errors.join("；"));
  return attempt(async () => {
    const records: NewSaleRecord[] = parsed.rows.map((row) => ({ ...row, businessId: user.businessId, isDemo: false }));
    const inserted = await getRepositories().sales.import(records);
    return { inserted, skipped: records.length - inserted };
  });
}

/** 随手记账与表格预览共用真实销售写入，编号保证重复提交不重复计账。 */
export async function saveSaleRecords(rows: ParsedSaleRow[]): Promise<Result<{ inserted: number; skipped: number }>> {
  const user = await getCurrentAuthUser();
  if (!user) return fail("UNAUTHORIZED", "请先登录");
  const parsed = validateSaleRows(rows);
  if (!parsed.ok) return fail("VALIDATION_FAILED", parsed.errors.join("；"));
  return attempt(async () => {
    const inserted = await getRepositories().sales.import(parsed.rows.map(row => ({ ...row, businessId: user.businessId, isDemo: false })));
    return { inserted, skipped: parsed.rows.length - inserted };
  });
}

export async function updateSaleRecord(id: string, changes: SaleRecordChanges): Promise<Result<SaleRecord>> {
  const user = await getCurrentAuthUser();
  if (!user) return fail("UNAUTHORIZED", "请先登录");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return fail("VALIDATION_FAILED", "记录编号不正确，请刷新后重试");
  const parsed = validateSaleRows([{ recordNo: "EDIT", ...changes }]);
  if (!parsed.ok) return fail("VALIDATION_FAILED", parsed.errors.join("；"));
  const { recordNo: _recordNo, ...fields } = parsed.rows[0];
  void _recordNo;
  const saved = await attempt(() => getRepositories().sales.update(user.businessId, id, fields));
  if (!saved.ok) return saved;
  return saved.data ? ok(saved.data) : fail("NOT_FOUND", "记录已不存在，请刷新后重试");
}

/** 一键演示数据只在商户主动操作时写入；有明显标识，且不参与真实汇总。 */
export async function addDemoSales(): Promise<Result<{ inserted: number }>> {
  const user = await getCurrentAuthUser();
  if (!user) return fail("UNAUTHORIZED", "请先登录");
  return attempt(async () => {
    const today = new Date();
    const examples = [
      [0, "连江手工鱼丸", "微信", 2, 9600, 5800],
      [-1, "黄岐海带", "线下", 3, 8970, 4500],
      [-2, "连江鲜活鲍鱼", "微信", 1, 12900, 8200],
      [-3, "连江手工鱼丸", "抖音", 4, 19200, 11600],
      [-4, "黄岐海带", "微信", 2, 5980, 3000],
      [-5, "连江鲜活鲍鱼", "线下", 2, 25800, 16400],
      [-7, "连江手工鱼丸", "微信", 1, 4800, 2900],
      [-8, "黄岐海带", "抖音", 2, 5980, 3000],
      [-10, "连江鲜活鲍鱼", "微信", 1, 12900, 8200],
      [-12, "连江手工鱼丸", "线下", 3, 14400, 8700],
    ] as const;
    const rows: NewSaleRecord[] = examples.map(([days, productName, channel, quantity, revenueCents, costCents], index) => ({
      businessId: user.businessId, recordNo: `DEMO-SALE-${index + 1}`,
      saleDate: offsetDate(today, days), productName, channel, quantity, revenueCents, costCents, isDemo: true,
    }));
    await getRepositories().sales.deleteDemo(user.businessId);
    return { inserted: await getRepositories().sales.import(rows) };
  });
}

export async function clearDemoSales(): Promise<Result<{ deleted: number }>> {
  const user = await getCurrentAuthUser();
  if (!user) return fail("UNAUTHORIZED", "请先登录");
  return attempt(async () => ({ deleted: await getRepositories().sales.deleteDemo(user.businessId) }));
}

export async function deleteSaleRecord(id: string): Promise<Result<{ deleted: boolean }>> {
  const user = await getCurrentAuthUser();
  if (!user) return fail("UNAUTHORIZED", "请先登录");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return fail("VALIDATION_FAILED", "销售记录编号无效");
  return attempt(async () => ({ deleted: await getRepositories().sales.deleteOne(user.businessId, id) }));
}
