import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getDb } from "@/db";
import { businesses } from "@/db/schema";
import { createDbSalesRepository } from "./sales.repository";
import { describeDbSuite, prepareDbForTests } from "./db-integration";

describeDbSuite("销售导入仓储（集成测试）", () => {
  const repo = createDbSalesRepository();
  let first = "", second = "";
  beforeAll(async () => {
    await prepareDbForTests();
    const merchants = await getDb().insert(businesses).values([
      { name: "销售测试甲", shortName: "甲" },
      { name: "销售测试乙", shortName: "乙" },
    ]).returning({ id: businesses.id });
    first = merchants[0].id; second = merchants[1].id;
  });
  afterAll(async () => {
    if (first) await getDb().delete(businesses).where(eq(businesses.id, first));
    if (second) await getDb().delete(businesses).where(eq(businesses.id, second));
  });

  it("重复导入跳过同编号，租户隔离且仅删除自己的演示数据", async () => {
    const recordNo = randomUUID();
    const row = { recordNo, saleDate: "2026-09-30", productName: "鱼丸", channel: "微信", quantity: 1, revenueCents: 1200, costCents: 700, isDemo: false };
    expect(await repo.import([{ ...row, businessId: first }])).toBe(1);
    expect(await repo.import([{ ...row, businessId: first }])).toBe(0);
    expect(await repo.import([{ ...row, businessId: second }])).toBe(1);
    expect(await repo.import([{ ...row, businessId: first, recordNo: `DEMO-${recordNo}`, isDemo: true }])).toBe(1);
    expect(await repo.deleteDemo(first)).toBe(1);
    expect((await repo.list(first)).map((item) => item.recordNo)).toEqual([recordNo]);
    const other = await repo.list(second);
    expect(other).toHaveLength(1);
    expect(await repo.deleteOne(first, other[0].id)).toBe(false);
    expect(await repo.deleteOne(second, other[0].id)).toBe(true);
  });
  it("编辑在数据库中持久化，保留编号及演示标志，并严格限定所属商户", async () => {
    const recordNo = `EDIT-${randomUUID()}`;
    await repo.import([{ businessId: first, recordNo, saleDate: "2026-10-03", productName: "测试鱼丸", channel: "微信", quantity: 2, revenueCents: 9600, costCents: null, isDemo: true }]);
    const record = (await repo.list(first)).find(row => row.recordNo === recordNo)!;
    const changes = { saleDate: "2026-10-02", productName: "测试鱼丸", channel: "线下", quantity: 2, revenueCents: 9000, costCents: 5800 };
    expect(await repo.update(second, record.id, changes)).toBeNull();
    expect(await repo.update(first, record.id, changes)).toMatchObject({ ...changes, recordNo, businessId: first, isDemo: true });
    const reread = (await repo.list(first)).filter(row => row.recordNo === recordNo);
    expect(reread).toHaveLength(1);
    expect(reread[0]).toMatchObject({ revenueCents: 9000, costCents: 5800, channel: "线下", isDemo: true });
  });
});
