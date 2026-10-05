import { createHash } from "node:crypto";
import type { SaleRecord, SalesReviewMode, SalesReviewSnapshot, SalesSummary } from "@/types";

const money = (cents: number) => `¥${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const chinaDay = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

export function salesRecordsFingerprint(records: readonly SaleRecord[], mode: SalesReviewMode, now = new Date()): string {
  const values = [...records].sort((a, b) => a.id.localeCompare(b.id)).map(row => [row.id, row.saleDate, row.productName, row.channel, row.quantity, row.revenueCents, row.costCents, row.isDemo]);
  return createHash("sha256").update(JSON.stringify([chinaDay(now), mode, values])).digest("hex");
}

export function buildSalesReviewSnapshot(records: readonly SaleRecord[], summary: SalesSummary, products: readonly { id: string; name: string }[], now = new Date()): SalesReviewSnapshot {
  const mode = summary.isDemo ? "demo" : "real";
  const today = chinaDay(now), recentStart = chinaDay(new Date(now.getTime() - 6 * 86400000)), previousStart = chinaDay(new Date(now.getTime() - 13 * 86400000));
  const dates = [...new Set(records.map(row => row.saleDate))].sort();
  const ranked = summary.byProduct.slice(0, 5).map(item => {
    const rows = records.filter(row => row.productName === item.name);
    const channels = new Map<string, number>();
    rows.forEach(row => channels.set(row.channel, (channels.get(row.channel) ?? 0) + row.revenueCents));
    const primaryChannel = [...channels].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { name: item.name, productId: products.find(product => product.name === item.name)?.id ?? null, revenueCents: item.revenueCents, grossProfitCents: rows.some(row => row.costCents === null) ? null : item.revenueCents - rows.reduce((sum, row) => sum + row.costCents!, 0), primaryChannel };
  });
  const recentRecordedDays = dates.filter(date => date >= recentStart && date <= today).length;
  const previousRecordedDays = dates.filter(date => date >= previousStart && date < recentStart).length;
  const futureRecordCount = records.filter(row => row.saleDate > today).length;
  const facts: SalesReviewSnapshot["facts"] = [
    { id: "revenue", label: "已记录实收", display: money(summary.revenueCents) },
    { id: "records", label: "销售明细", display: `${summary.count} 条明细，不能当作订单数` },
    { id: "quantity", label: "已售数量", display: `${summary.quantity} 件` },
    { id: "grossProfit", label: "毛利估算", display: summary.grossProfitCents === null ? "成本未补齐，暂不能计算整批毛利" : `${money(summary.grossProfitCents)}，不含运费、租金等未录入费用` },
    { id: "costMissing", label: "待核对成本", display: `${summary.missingCostCount} 条明细未填成本` },
    { id: "recentRevenue", label: "最近七天已记录实收", display: money(summary.recentSevenDaysCents) },
    { id: "previousRevenue", label: "此前七天已记录实收", display: money(summary.previousSevenDaysCents) },
    { id: "coverage", label: "比较依据", display: `最近七天有 ${recentRecordedDays} 个记录日期，此前七天有 ${previousRecordedDays} 个；日期无记录不等于没有销售，仍需商户确认是否导齐` },
    { id: "futureDates", label: "日期核对", display: `${futureRecordCount} 条记录日期晚于今天；这些记录未计入最近七天比较` },
  ];
  if (summary.previousSevenDaysCents > 0 && recentRecordedDays > 0) {
    const change = summary.recentSevenDaysCents - summary.previousSevenDaysCents;
    facts.push({ id: "periodChange", label: "已记录实收变化", display: `${change >= 0 ? "增加" : "减少"} ${money(Math.abs(change))}（${(Math.abs(change) / summary.previousSevenDaysCents * 100).toFixed(1)}%），需确认两段记录都已导齐` });
  }
  const revenueShare = (cents: number) => summary.revenueCents > 0
    ? ` · 占本批已记录实收 ${(cents / summary.revenueCents * 100).toFixed(1)}%`
    : "";
  ranked.forEach((product, i) => facts.push({ id: `product:${i}`, label: i === 0 ? "实收最多的商品" : "商品表现", display: `${product.name} · 实收 ${money(product.revenueCents)}${revenueShare(product.revenueCents)} · ${product.grossProfitCents === null ? "成本未补齐" : `毛利估算 ${money(product.grossProfitCents)}`}` }));
  ranked.forEach((product, i) => {
    const channelRevenue = records.filter(row => row.productName === product.name && row.channel === product.primaryChannel).reduce((sum, row) => sum + row.revenueCents, 0);
    if (product.primaryChannel) facts.push({ id: `productChannel:${i}`, label: "商品的主要销售渠道", display: `${product.name} · ${product.primaryChannel} · 已记录实收 ${money(channelRevenue)}` });
  });
  summary.byChannel.slice(0, 3).forEach((channel, i) => facts.push({ id: `channel:${i}`, label: i === 0 ? "实收最多的渠道" : "渠道表现", display: `${channel.name} · 已记录实收 ${money(channel.revenueCents)}${revenueShare(channel.revenueCents)}` }));
  return { mode, fingerprint: salesRecordsFingerprint(records, mode, now), asOf: now.toISOString(), dateRange: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null, summary, facts, products: ranked, recentRecordedDays, previousRecordedDays, futureRecordCount };
}
