import { describe, expect, it } from "vitest";
import { guessSalesColumns, normalizeSalesTable, parseSalesTableText, prepareSalesTable, type SalesTable } from "./sales-table";
import { validateSaleRows } from "./sales-entry";

const table: SalesTable = [["日期", "商品", "件数", "实收金额（元）", "来源", "成本"], ["2026/10/3", "鱼丸", 2, "￥96.00", "微信", "58"], ["2026-10-03", "海带", 1, 29.90, "线下", null]];
describe("多方式销售表格录入", () => {
  it("支持Excel复制的制表符、多种表头与日期，成本空值仍未知", async () => {
    const parsed = parseSalesTableText("日期\t商品\t数量\t实收\t渠道\t成本\n2026/10/3\t鱼丸\t2\t96\t微信\t58\n2026-10-03\t海带\t1\t29.90\t线下\t");
    const result = await prepareSalesTable(parsed, guessSalesColumns(parsed[0]), "线下");
    expect(result.ok).toBe(true); if (!result.ok) throw result.errors;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ saleDate: "2026-10-03", revenueCents: 9600, costCents: 5800 });
    expect(result.rows[1]).toMatchObject({ revenueCents: 2990, costCents: null });
    expect(validateSaleRows(result.rows).ok).toBe(true);
  });
  it("日期单元格、标题行和空行处理后仍能正确对应数据", async () => {
    const rows = normalizeSalesTable([["今日销售账本"], [], ...table]);
    rows[1][0] = new Date("2026-10-03T00:00:00Z");
    const result = await prepareSalesTable(rows, guessSalesColumns(rows[0]), "线下");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].saleDate).toBe("2026-10-03");
  });
  it("自动编号稳定，重复文件不重复记账，同批相同销售各自保留", async () => {
    const rows = [table[0], table[1], table[1]];
    const mapping = guessSalesColumns(table[0]);
    const first = await prepareSalesTable(rows, mapping, "线下");
    const second = await prepareSalesTable(rows, mapping, "线下");
    expect(first).toEqual(second);
    if (!first.ok) throw first.errors;
    expect(first.rows[0].recordNo).not.toBe(first.rows[1].recordNo);
    expect(first.rows[0].recordNo).toMatch(/^IMPORT-/);
  });
  it("保留原始编号，拒绝一个订单号重复用于多条商品明细", async () => {
    const rows = [[...table[0], "订单编号"], [...table[1], "A-001"], [...table[2], "A-001"]];
    const result = await prepareSalesTable(rows, guessSalesColumns(rows[0]), "线下");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("重复编号");
  });
  it("未知列可以手动匹配，缺渠道时只使用商户明确选择的渠道", async () => {
    const rows = [["业务时间", "卖的东西", "件数", "付款"], ["2026.10.3", "鱼丸", "2", "1,250.50"]];
    const result = await prepareSalesTable(rows, { saleDate: 0, productName: 1, quantity: 2, revenue: 3, channel: -1, cost: -1, recordNo: -1 }, "视频号");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0]).toMatchObject({ channel: "视频号", revenueCents: 125050, costCents: null });
  });
  it("拒绝 Excel 中精度已经不可靠的长数字编号，文本长编号仍可保存", async () => {
    const rows = [[...table[0], "订单号"], [...table[1], 123456789012345678]];
    const result = await prepareSalesTable(rows, guessSalesColumns(rows[0]), "线下");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("设为文本");
    rows[1][rows[1].length - 1] = "123456789012345678";
    const textResult = await prepareSalesTable(rows, guessSalesColumns(rows[0]), "线下");
    expect(textResult.ok).toBe(true);
    if (textResult.ok) expect(textResult.rows[0].recordNo).toBe("123456789012345678");
  });
  it("无效日期、非整数数量或金额错误时，整批不提交部分有效行", async () => {
    const rows = [...table, ["2026-02-30", "海带", 1.5, "29.999", "微信", null]];
    const result = await prepareSalesTable(rows, guessSalesColumns(rows[0]), "线下");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/日期|数量|金额/);
  });
  it("必需列未匹配或重复映射时拒绝保存", async () => {
    const missing = { ...guessSalesColumns(table[0]), revenue: -1 };
    expect((await prepareSalesTable(table, missing, "线下")).ok).toBe(false);
    expect((await prepareSalesTable(table, { ...missing, revenue: missing.quantity }, "线下")).ok).toBe(false);
  });
  it("服务端不接受伪造商户、演示标志或非整数分", () => {
    const row = { recordNo: "A1", saleDate: "2026-10-03", productName: "鱼丸", channel: "微信", quantity: 1, revenueCents: 9600, costCents: null };
    expect(validateSaleRows([{ ...row, businessId: "other-shop", isDemo: true }]).ok).toBe(false);
    expect(validateSaleRows([{ ...row, revenueCents: 9600.1 }]).ok).toBe(false);
  });
});
