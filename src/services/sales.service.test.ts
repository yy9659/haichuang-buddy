import { describe, expect, it } from "vitest";
import type { SaleRecord } from "@/types";
import { summarizeSales } from "./sales.service";

function sale(overrides: Partial<SaleRecord>): SaleRecord {
  return { id: crypto.randomUUID(), businessId: "merchant", recordNo: "N1", saleDate: "2026-09-30", productName: "鱼丸", channel: "微信", quantity: 1, revenueCents: 1000, costCents: 600, isDemo: false, createdAt: "2026-09-30T00:00:00Z", ...overrides };
}

describe("销售数据口径", () => {
  const now = new Date("2026-09-30T12:00:00Z");

  it("按商品、渠道和两个七天窗口汇总实收", () => {
    const result = summarizeSales([
      sale({ recordNo: "1", saleDate: "2026-09-30", revenueCents: 1000, costCents: 600 }),
      sale({ recordNo: "2", saleDate: "2026-09-25", revenueCents: 2000, costCents: 1000, channel: "线下" }),
      sale({ recordNo: "3", saleDate: "2026-09-22", revenueCents: 500, costCents: 200, productName: "海带" }),
    ], false, now);
    expect(result.revenueCents).toBe(3500);
    expect(result.grossProfitCents).toBe(1700);
    expect(result.recentSevenDaysCents).toBe(3000);
    expect(result.previousSevenDaysCents).toBe(500);
    expect(result.byProduct[0]).toMatchObject({ name: "鱼丸", revenueCents: 3000 });
  });

  it("任一行缺成本时不展示不完整的总毛利", () => {
    const result = summarizeSales([sale({ costCents: 600 }), sale({ recordNo: "2", costCents: null })], false, now);
    expect(result.grossProfitCents).toBeNull();
    expect(result.missingCostCount).toBe(1);
  });
});
