import { describe, expect, it } from "vitest";
import { buildDemoSalesReview } from "@/ai/prompts/analytics-agent";
import { buildSalesReviewSnapshot } from "@/analytics/sales-review";
import { summarizeSales } from "@/services/sales.service";
import type { SaleRecord } from "@/types";
import { createSalesReviewSchema } from "./sales-review";

const now = new Date("2026-10-03T10:00:00+08:00");
const rows: SaleRecord[] = [{ id: "a", businessId: "shop", recordNo: "1", saleDate: "2026-10-03", productName: "鱼丸", channel: "微信", quantity: 1, revenueCents: 10000, costCents: null, isDemo: true, createdAt: now.toISOString() }];
const sales = buildSalesReviewSnapshot(rows, summarizeSales(rows, true, now), [{ id: "fish-id", name: "鱼丸" }], now);
const schema = createSalesReviewSchema(sales);
const review = () => buildDemoSalesReview(sales);

describe("销售建议可追溯契约", () => {
  it("接受有依据的小行动以及不同金额写法", () => {
    const result = review();
    result.summary = "当前记录实收100元，先核对成本。";
    expect(schema.safeParse(result).success).toBe(true);
  });
  it("拒绝不存在的依据与商品", () => {
    const result = review(); result.actions[0].evidenceIds = ["fake"];
    expect(schema.safeParse(result).success).toBe(false);
    const other = review(); other.actions[0].productName = "未售商品";
    expect(schema.safeParse(other).success).toBe(false);
  });
  it.each(["实收是101元", "客单价100元", "订单数3单", "已完成3笔订单", "增长1.0%", "毛利率20%"])("拒绝无依据结论：%s", text => {
    const result = review(); result.summary = text;
    expect(schema.safeParse(result).success).toBe(false);
  });
  it("百分比必须完整匹配，不能把11.0%误当1.0%的依据", () => {
    const withPercent = { ...sales, facts: [...sales.facts, { id: "periodChange", label: "变化", display: "增加 ¥11.00（11.0%）" }] };
    const result = review(); result.summary = "已记录实收增加1.0%。";
    expect(createSalesReviewSchema(withPercent).safeParse(result).success).toBe(false);
  });
  it("不接受重复的行动优先级", () => {
    const result = review(); result.actions[1].priority = result.actions[0].priority;
    expect(schema.safeParse(result).success).toBe(false);
  });
  it("允许系统算出的商品占比，继续拦截模型算错或擅自取整的占比", () => {
    const records = [{ ...rows[0], revenueCents: 9600 }, { ...rows[0], id: "b", productName: "海带", revenueCents: 2990 }];
    const snapshot = buildSalesReviewSnapshot(records, summarizeSales(records, true, now), [], now);
    const validate = createSalesReviewSchema(snapshot);
    const result = buildDemoSalesReview(snapshot);
    result.summary = "鱼丸占本批已记录实收76.3%，可以优先准备推广。";
    expect(validate.safeParse(result).success).toBe(true);
    for (const percent of ["76.2", "76", "99.9"]) {
      expect(validate.safeParse({ ...result, summary: `鱼丸占本批已记录实收${percent}%。` }).success).toBe(false);
    }
  });
});
