import { describe, expect, it } from "vitest";
import { buildDemoSalesReview } from "@/ai/prompts/analytics-agent";
import { salesReviewActionLink } from "@/lib/sales-review-links";
import { summarizeSales } from "@/services/sales.service";
import type { SaleRecord } from "@/types";
import { buildSalesReviewSnapshot, salesRecordsFingerprint } from "./sales-review";

const now = new Date("2026-10-03T10:00:00+08:00");
const row = (changes: Partial<SaleRecord> = {}): SaleRecord => ({ id: "a", businessId: "shop", recordNo: "1", saleDate: "2026-10-03", productName: "鱼丸", channel: "抖音", quantity: 2, revenueCents: 9000, costCents: 5000, isDemo: false, createdAt: now.toISOString(), ...changes });
const snapshot = (rows: SaleRecord[]) => buildSalesReviewSnapshot(rows, summarizeSales(rows, false, now), [{ id: "fish-id", name: "鱼丸" }], now);

describe("销售 AI 依据与操作入口", () => {
  it("整数分汇总、独立商品成本和未知总毛利", () => {
    const sales = snapshot([row(), row({ id: "b", productName: "海带", revenueCents: 3011, costCents: null })]);
    expect(sales.summary.revenueCents).toBe(12011);
    expect(sales.summary.grossProfitCents).toBeNull();
    expect(sales.products[0]).toMatchObject({ productId: "fish-id", grossProfitCents: 4000 });
    expect(sales.products[1]).toMatchObject({ productId: null, grossProfitCents: null });
    expect(sales.facts.find(fact => fact.id === "revenue")?.display).toBe("¥120.11");
  });
  it("没有近期记录不产生下降百分比，未来记录不进入最近七天", () => {
    const sales = snapshot([row({ saleDate: "2026-09-24" }), row({ id: "b", saleDate: "2026-10-05" })]);
    expect(sales.recentRecordedDays).toBe(0);
    expect(sales.previousRecordedDays).toBe(1);
    expect(sales.futureRecordCount).toBe(1);
    expect(sales.summary.recentSevenDaysCents).toBe(0);
    expect(sales.facts.some(fact => fact.id === "periodChange")).toBe(false);
    expect(sales.facts.find(fact => fact.id === "coverage")?.display).toContain("无记录不等于没有销售");
  });
  it("指纹忽略行序，但对成本、销售来源和日期窗口变化敏感", () => {
    const rows = [row(), row({ id: "b", costCents: null })];
    const hash = salesRecordsFingerprint(rows, "real", now);
    expect(salesRecordsFingerprint([...rows].reverse(), "real", now)).toBe(hash);
    expect(salesRecordsFingerprint([row(), row({ id: "b", costCents: 10 })], "real", now)).not.toBe(hash);
    expect(salesRecordsFingerprint(rows, "demo", now)).not.toBe(hash);
    expect(salesRecordsFingerprint(rows, "real", new Date("2026-10-04T10:00:00+08:00"))).not.toBe(hash);
  });
  it("商品与渠道占比由整数分计算，保留一位小数且限定为本批记录", () => {
    const sales = snapshot([row({ revenueCents: 9600, channel: "微信" }), row({ id: "b", productName: "海带", revenueCents: 2990, channel: "线下" })]);
    expect(sales.facts.find(fact => fact.id === "product:0")?.display).toContain("占本批已记录实收 76.3%");
    expect(sales.facts.find(fact => fact.id === "channel:0")?.display).toContain("占本批已记录实收 76.3%");
    expect(sales.facts.find(fact => fact.id === "product:1")?.display).toContain("23.7%");
  });
  it("零实收不产生占比，不能出现NaN或Infinity", () => {
    const sales = snapshot([row({ revenueCents: 0, costCents: 0 })]);
    expect(sales.facts.filter(fact => /^(product|channel):/.test(fact.id)).map(fact => fact.display).join(" ")).not.toMatch(/%|NaN|Infinity/);
  });
  it("推广入口带入已知商品和主渠道，未知商品先补档案", () => {
    const sales = snapshot([row()]);
    const action = buildDemoSalesReview(sales).actions.find(item => item.destination === "content")!;
    const link = salesReviewActionLink(action, sales);
    const query = new URL(link.href, "http://localhost");
    expect(query.pathname).toBe("/content");
    expect(Object.fromEntries(query.searchParams)).toEqual({ productId: "fish-id", platform: "douyin", format: "short-video" });
    expect(salesReviewActionLink(action, { ...sales, products: [{ ...sales.products[0], productId: null }] }).href).toBe("/products");
  });
  it("商品推广依据来自它自己的渠道，不把全店渠道当成交叉统计", () => {
    const sales = snapshot([row({ channel: "抖音" }), row({ id: "b", productName: "海带", revenueCents: 50000, channel: "微信" })]);
    const fish = sales.products.find(product => product.name === "鱼丸")!;
    expect(sales.summary.byChannel[0].name).toBe("微信");
    expect(fish.primaryChannel).toBe("抖音");
    expect(sales.facts.find(fact => fact.id === "productChannel:1")?.display).toBe("鱼丸 · 抖音 · 已记录实收 ¥90.00");
    const action = { ...buildDemoSalesReview(sales).actions[0], destination: "content" as const, productName: "鱼丸" };
    expect(new URL(salesReviewActionLink(action, sales).href, "http://localhost").searchParams.get("platform")).toBe("douyin");
  });
});
