import { describe, expect, it } from "vitest";
import { parseSalesCsv, SALES_CSV_HEADER, SALES_CSV_TEMPLATE } from "./sales-csv";

describe("销售 CSV 导入校验", () => {
  it("下载模板只有表头，录入金额准确转成分，空成本保持未填写", () => {
    expect(SALES_CSV_TEMPLATE).toBe(`${SALES_CSV_HEADER}\r\n`);
    const result = parseSalesCsv(`${SALES_CSV_HEADER}\r\nDD001,2026-09-30,连江手工鱼丸,微信,2,96.00,58.00\r\nDD002,2026-09-30,黄岐海带,线下,1,29.90,\r\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ revenueCents: 9600, costCents: 5800, quantity: 2 });
    expect(result.rows[1].costCents).toBeNull();
  });

  it("兼容 BOM、带逗号的商品名与引号", () => {
    const csv = `\uFEFF${SALES_CSV_HEADER}\r\nA1,2026-09-30,"鱼丸,""家庭装""",微信,1,12.30,0\r\n`;
    const result = parseSalesCsv(csv);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0]).toMatchObject({ productName: '鱼丸,"家庭装"', revenueCents: 1230, costCents: 0 });
  });

  it("拒绝文件内重复编号、无效日期与非数字金额，不写入部分有效行", () => {
    const csv = `${SALES_CSV_HEADER}\nA1,2026-02-29,鱼丸,微信,1,12.30,\nA1,2026-09-30,海带,线下,2,xx,`;
    const result = parseSalesCsv(csv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/日期|重复|实收金额/);
  });

  it("拒绝超出数据库整数金额范围的单行金额", () => {
    const result = parseSalesCsv(`${SALES_CSV_HEADER}\nA1,2026-09-30,鱼丸,微信,1,1000000.00,`);
    expect(result.ok).toBe(false);
  });
});
