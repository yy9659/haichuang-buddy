import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRepositories } from "@/repositories";
import { resetServerEnvCache } from "@/lib/env";
import { saveSaleRecords, updateSaleRecord } from "./sales.service";
import { buildSalesReviewSnapshot } from "@/analytics/sales-review";
import { summarizeSales } from "./sales.service";

const auth = vi.hoisted(() => ({ businessId: "sales-entry-test-merchant", loggedIn: true }));
vi.mock("./auth.service", () => ({ getCurrentAuthUser: async () => auth.loggedIn ? { id: "test-user", businessId: auth.businessId } : null }));
process.env.DATA_SOURCE = "mock"; resetServerEnvCache();
const repo = getRepositories().sales;
const merchant = "sales-entry-test-merchant", other = "sales-entry-test-other";
const row = { recordNo: "MANUAL-test", saleDate: "2026-10-03", productName: "测试鱼丸", channel: "微信", quantity: 2, revenueCents: 9600, costCents: null };
async function clean() { for (const businessId of [merchant, other]) for (const record of await repo.list(businessId)) await repo.deleteOne(businessId, record.id); }
beforeEach(async () => { auth.businessId = merchant; auth.loggedIn = true; await clean(); });
afterEach(clean);

describe("销售随手记与直接编辑", () => {
  it("记账实际写入、重复提交跳过，金额以分保存且归属当前商户", async () => {
    expect(await saveSaleRecords([row])).toMatchObject({ ok: true, data: { inserted: 1, skipped: 0 } });
    expect(await saveSaleRecords([row])).toMatchObject({ ok: true, data: { inserted: 0, skipped: 1 } });
    expect(await repo.list(merchant)).toHaveLength(1);
    expect((await repo.list(merchant))[0]).toMatchObject({ businessId: merchant, isDemo: false, revenueCents: 9600, costCents: null });
  });
  it("直接补成本与改金额不新增记录，保留编号和演示属性并改变AI依据指纹", async () => {
    await saveSaleRecords([row]);
    const records = await repo.list(merchant), before = buildSalesReviewSnapshot(records, summarizeSales(records, false), []);
    const changed = await updateSaleRecord(records[0].id, { saleDate: row.saleDate, productName: row.productName, channel: "线下", quantity: 2, revenueCents: 9000, costCents: 5800 });
    expect(changed).toMatchObject({ ok: true, data: { recordNo: row.recordNo, revenueCents: 9000, costCents: 5800, isDemo: false } });
    const afterRows = await repo.list(merchant), after = buildSalesReviewSnapshot(afterRows, summarizeSales(afterRows, false), []);
    expect(afterRows).toHaveLength(1); expect(after.summary.grossProfitCents).toBe(3200); expect(after.fingerprint).not.toBe(before.fingerprint);
  });
  it("其他商户不能编辑该记录，演示记录编辑后仍是演示记录", async () => {
    await repo.import([{ ...row, businessId: other, isDemo: true }]);
    const record = (await repo.list(other))[0], changes = { saleDate: row.saleDate, productName: row.productName, channel: row.channel, quantity: 1, revenueCents: 4800, costCents: 2900 };
    const denied = await updateSaleRecord(record.id, changes);
    expect(denied).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect((await repo.list(other))[0].revenueCents).toBe(9600);
    auth.businessId = other;
    expect(await updateSaleRecord(record.id, changes)).toMatchObject({ ok: true, data: { isDemo: true, revenueCents: 4800 } });
  });
  it("未登录或批次包含无效金额时不写入", async () => {
    expect(await saveSaleRecords([row, { ...row, recordNo: "bad", revenueCents: -1 }])).toMatchObject({ ok: false });
    expect(await repo.list(merchant)).toHaveLength(0);
    auth.loggedIn = false;
    expect(await saveSaleRecords([row])).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });
});
