import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockAIProvider } from "@/ai/provider/mock";
import { AppError } from "@/lib/result";
import { salesRecordsFingerprint } from "@/analytics/sales-review";
import { resetServerEnvCache } from "@/lib/env";
import { getRepositories } from "@/repositories";
import { clearStoredAgentTasks, resetStoredBusinessReports } from "@/repositories/mock/store";
import { generateBusinessReport, getAnalyticsReportState } from "./analytics.service";

process.env.DATA_SOURCE = "mock";
process.env.AI_PROVIDER = "mock";
resetServerEnvCache();
const repos = getRepositories();
let businessId: string;
async function clean() {
  for (const id of [businessId, "other-sales-shop"].filter(Boolean)) for (const row of await repos.sales.list(id)) await repos.sales.deleteOne(id, row.id);
  resetStoredBusinessReports(); clearStoredAgentTasks();
}
beforeEach(async () => { businessId = (await repos.business.getProfile())!.id; await clean(); });
afterEach(clean);

describe("销售与经营复盘联动", () => {
  it("真实、演示及其他商户记录不混算，报告保存自己的依据", async () => {
    const base = { businessId, recordNo: "real1", saleDate: "2026-10-03", productName: "连江手工鱼丸", channel: "微信", quantity: 2, revenueCents: 9000, costCents: null, isDemo: false };
    await repos.sales.import([base, { ...base, recordNo: "demo1", revenueCents: 30000, isDemo: true }, { ...base, businessId: "other-sales-shop", revenueCents: 999999 }]);
    const real = await generateBusinessReport({ provider: createMockAIProvider(), salesMode: "real" });
    expect(real.ok).toBe(true); if (!real.ok) throw real.error;
    expect(real.data.report.snapshot.sales?.summary).toMatchObject({ count: 1, revenueCents: 9000, grossProfitCents: null, isDemo: false });
    expect(real.data.report.report.salesReview).toMatchObject({ isMock: true, providerId: "mock" });
    const demo = await generateBusinessReport({ provider: createMockAIProvider(), salesMode: "demo" });
    expect(demo.ok).toBe(true); if (!demo.ok) throw demo.error;
    expect(demo.data.report.snapshot.sales?.summary.revenueCents).toBe(30000);
    expect(demo.data.report.snapshot.sales?.mode).toBe("demo");
    expect((await repos.reports.listRecent(20)).map(report => report.snapshot.sales?.mode)).toContain("real");
    await repos.sales.import([{ ...base, recordNo: "real2" }]);
    expect(salesRecordsFingerprint((await repos.sales.list(businessId)).filter(row => !row.isDemo), "real", new Date(real.data.report.snapshot.generatedAt))).not.toBe(real.data.report.snapshot.sales?.fingerprint);
  });
  it("没有销售记录时不调用模型、不创建新任务", async () => {
    const result = await generateBusinessReport({ provider: createMockAIProvider(), salesMode: "real" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(await repos.agentTasks.findLatestByType("analytics_agent")).toBeNull();
  });
  it("有旧报告也能正确显示新任务正在生成", async () => {
    await generateBusinessReport({ provider: createMockAIProvider() });
    await repos.agentTasks.create({ agentType: "analytics_agent", title: "销售分析", status: "running", progress: 10, input: {} });
    const state = await getAnalyticsReportState();
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.data.status).toBe("generating");
  });
  it("销售模型失败不覆盖已保存的成功建议", async () => {
    await repos.sales.import([{ businessId, recordNo: "keep1", saleDate: "2026-10-03", productName: "连江手工鱼丸", channel: "微信", quantity: 1, revenueCents: 4500, costCents: 2500, isDemo: false }]);
    const previous = await generateBusinessReport({ provider: createMockAIProvider(), salesMode: "real" });
    expect(previous.ok).toBe(true); if (!previous.ok) throw previous.error;
    const failing = createMockAIProvider();
    failing.generateText = async () => { throw new AppError({ code: "QUOTA_EXCEEDED", message: "测试配额用尽" }); };
    const failed = await generateBusinessReport({ provider: failing, salesMode: "real" });
    expect(failed.ok).toBe(false);
    expect((await repos.reports.findLatest())?.id).toBe(previous.data.report.id);
    const state = await getAnalyticsReportState();
    if (state.ok) expect(state.data.lastRunFailed).toBe(true);
  });
});
