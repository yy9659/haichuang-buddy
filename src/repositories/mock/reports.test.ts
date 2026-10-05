/**
 * 经营日报 Mock 仓储单测（S6-B · 任务书第十七 / 十八节）
 *
 * 这个仓储有三条必须守住的语义，它们直接决定界面对不对：
 *
 * 1. **没有种子。** 日报是 AI 的产出，预置一份固定日报等于让页面显示一份
 *    「看起来是 AI 生成的常量」（§18 明令禁止）。
 * 2. **最近在前。** `findLatest()` 就是列表首项，与 DB 的
 *    `ORDER BY created_at DESC` 同一口径。
 * 3. **写入即隔离。** 快照与结论都要深拷贝 —— 调用方随后改自己那份对象，
 *    不该篡改已经落库的历史。
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { BusinessReport } from "@/types";

import { createMockAnalyticsReportRepository } from "./reports";
import { putStoredBusinessReport, resetStoredBusinessReports } from "./store";

import { buildAnalyticsSnapshot } from "@/analytics/snapshot";

function makeSnapshot(products = 0) {
  return buildAnalyticsSnapshot({
    now: new Date("2026-09-27T10:00:00"),
    products: [],
    contents: [],
    workflows: [],
    agentTasks: [],
    customerService: {
      answeredCount: products,
      groundedCount: products,
      needsHumanCount: 0,
      openKnowledgeGapCount: 0,
      openGaps: [],
    },
    live: { sessions: [], comments: [], suggestions: [] },
  });
}

function makeReportInput(summary: string) {
  return {
    businessId: "biz_demo_001",
    snapshot: makeSnapshot(),
    report: {
      executiveSummary: summary,
      health: "good" as const,
      highlights: [
        {
          title: "经营平稳",
          evidence: "各项信号正常。",
          metricKeys: ["product.totalProducts"],
        },
      ],
      issues: [],
      actions: [
        {
          priority: 1,
          title: "继续补商品",
          reason: "商品还很少。",
          actionType: "product" as const,
          recommendedAction: "添加一件商品。",
        },
      ],
      tomorrowFocus: ["补商品"],
      confidence: 0.4,
    },
  };
}

beforeEach(() => {
  resetStoredBusinessReports();
});

describe("MockAnalyticsReportRepository", () => {
  it("初始为空 —— 日报没有种子（绝不预置一份「像 AI 写的」常量）", async () => {
    const repo = createMockAnalyticsReportRepository();

    expect(await repo.findLatest()).toBeNull();
    expect(await repo.listRecent()).toEqual([]);
  });

  it("create 之后 findLatest 能读到它，且带上 id 与创建时间", async () => {
    const repo = createMockAnalyticsReportRepository();

    const created = await repo.create(makeReportInput("第一天复盘"));

    expect(created.id).toMatch(/^report_/);
    expect(created.businessId).toBe("biz_demo_001");
    expect(created.createdAt.length).toBeGreaterThan(0);

    const latest = await repo.findLatest();
    expect(latest?.id).toBe(created.id);
    expect(latest?.report.executiveSummary).toBe("第一天复盘");
    // 快照与结论一起落库，历史才可回溯
    expect(latest?.snapshot.product.totalProducts).toBe(0);
  });

  it("findLatest 返回最近一条，listRecent 按时间倒序", async () => {
    const repo = createMockAnalyticsReportRepository();

    // 用 store 直接写入三条时间明确的记录，避免同一秒创建导致排序不可断言
    const base: Omit<BusinessReport, "id" | "createdAt"> = {
      businessId: "biz_demo_001",
      snapshot: makeSnapshot(),
      report: makeReportInput("x").report,
    };
    putStoredBusinessReport({ ...base, id: "report_old", createdAt: "2026-09-25 09:00" });
    putStoredBusinessReport({ ...base, id: "report_mid", createdAt: "2026-09-26 09:00" });
    putStoredBusinessReport({ ...base, id: "report_new", createdAt: "2026-09-27 09:00" });

    expect((await repo.findLatest())?.id).toBe("report_new");
    expect((await repo.listRecent()).map((item) => item.id)).toEqual([
      "report_new",
      "report_mid",
      "report_old",
    ]);
    expect((await repo.listRecent(2)).map((item) => item.id)).toEqual([
      "report_new",
      "report_mid",
    ]);
    expect(await repo.listRecent(0)).toEqual([]);
  });

  it("findById 找不到时返回 null（沿用其它仓储「找不到就 null」的约定）", async () => {
    const repo = createMockAnalyticsReportRepository();
    const created = await repo.create(makeReportInput("第一天复盘"));

    expect((await repo.findById(created.id))?.id).toBe(created.id);
    expect(await repo.findById("report_不存在")).toBeNull();
  });

  it("深拷贝：调用方随后改动自己那份快照，不影响已落库的历史", async () => {
    const repo = createMockAnalyticsReportRepository();
    const input = makeReportInput("第一天复盘");

    const created = await repo.create(input);

    // 篡改调用方手里的两份对象
    (input.snapshot.product as { totalProducts: number }).totalProducts = 999;
    (input.report as { executiveSummary: string }).executiveSummary = "被篡改了";

    const stored = await repo.findById(created.id);
    expect(stored?.snapshot.product.totalProducts).toBe(0);
    expect(stored?.report.executiveSummary).toBe("第一天复盘");
  });

  it("多次 create 会累积历史，而不是覆盖（历史复盘才有内容可看）", async () => {
    const repo = createMockAnalyticsReportRepository();

    const first = await repo.create(makeReportInput("第一天复盘"));
    const second = await repo.create(makeReportInput("第二天复盘"));

    expect(await repo.listRecent()).toHaveLength(2);
    // 两份都还在，各自 id 不同
    expect((await repo.findById(first.id))?.id).toBe(first.id);
    expect((await repo.findById(second.id))?.id).toBe(second.id);
    expect((await repo.findLatest())?.report.executiveSummary).toBe("第二天复盘");
  });
});
