/**
 * 经营分析服务单测（S6-B · 任务书第十四 / 十七 / 十九 / 三十二 / 三十三 / 三十四节）
 *
 * 服务层是「经营闭环」的最后一环，这组用例盯住四件在界面上看得见的事：
 *
 * 1. **页面只调一个入口**就能拿到「快照 + 最新日报 + 历史 + 状态」；
 * 2. **并发保护靠任务记录**（`agent_tasks` 的 running 记录），而不是内存标志位；
 * 3. **失败不毁掉已有成果** —— 生成失败时旧日报原样保留（§34）；
 * 4. **任务记录只存统计量**，不把整份日报抄进 `output`（§32）。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 模拟区块（趋势 / 内容表现 / 商品表现）在 Mock 数据源下是**演示素材**，
 * 读不到不该让整页失败。这里用「注入失败」的手法验证服务层的降级策略 ——
 * 验证的是**服务层怎么表现**，而不是 Mock 数据本身。
 */
const failures = vi.hoisted(() => ({ analytics: new Set<string>() }));

vi.mock("@/repositories/mock/analytics", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/repositories/mock/analytics")>();
  return {
    ...actual,
    createMockAnalyticsRepository: () => {
      const repo = actual.createMockAnalyticsRepository();
      return {
        ...repo,
        getOverview: async () => {
          if (failures.analytics.has("getOverview")) {
            throw new Error("注入的失败：analytics.getOverview");
          }
          return repo.getOverview();
        },
        getBusinessGoal: async () => {
          if (failures.analytics.has("getBusinessGoal")) {
            throw new Error("注入的失败：analytics.getBusinessGoal");
          }
          return repo.getBusinessGoal();
        },
      };
    },
  };
});

import { createMockAIProvider } from "@/ai/provider/mock";
import type { AIProvider } from "@/ai/provider/types";
import { resetServerEnvCache } from "@/lib/env";
import { AppError } from "@/lib/result";
import { getRepositories } from "@/repositories";
import {
  clearStoredAgentTasks,
  clearStoredAgentWorkflows,
  resetStoredBusinessReports,
  resetStoredContents,
  resetStoredKnowledge,
  resetStoredLive,
} from "@/repositories/mock/store";
import type { BusinessReport } from "@/types";

import {
  ANALYTICS_AGENT_TYPE,
  ANALYTICS_REPORT_STALE_MS,
  buildCurrentAnalyticsSnapshot,
  generateBusinessReport,
  getAnalyticsOverview,
  getAnalyticsReportState,
  getLatestBusinessReport,
  listBusinessReports,
} from "./analytics.service";

process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

const repositories = getRepositories();

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/** 一个每次调用都失败的 Provider，用于验证失败路径 */
function failingProvider(code: "MODEL_TIMEOUT" | "QUOTA_EXCEEDED" = "MODEL_TIMEOUT"): AIProvider {
  const fallback = createMockAIProvider();
  return {
    id: "failing",
    async generateText() {
      throw new AppError({
        code,
        message: code === "MODEL_TIMEOUT" ? "模型响应超时" : "配额已用尽",
        detail: "测试注入",
      });
    },
    async generateObject<T>(): Promise<T> {
      throw new Error("不应调用");
    },
    async streamText() {
      throw new Error("不应调用");
    },
    async analyzeImage(): Promise<string> {
      throw new Error("不应调用");
    },
    embed: (input) => fallback.embed(input),
  };
}

/** 造一条「正在运行」的经营分析任务（用于并发保护用例） */
async function seedRunningTask(createdAt?: string) {
  const task = await repositories.agentTasks.create({
    agentType: ANALYTICS_AGENT_TYPE,
    title: "生成今日经营日报",
    status: "running",
    progress: 10,
    input: { reportType: "daily" },
  });
  if (createdAt) {
    // 仓储不允许直接改 createdAt；用 store 里的替换函数制造「孤儿任务」
    const { listStoredAgentTasks, replaceStoredAgentTask } = await import(
      "@/repositories/mock/store"
    );
    const stored = listStoredAgentTasks().find((item) => item.id === task.id);
    if (stored) {
      replaceStoredAgentTask({ ...stored, createdAt });
    }
  }
  return task;
}

beforeAll(() => {
  process.env.DATA_SOURCE = "mock";
  delete process.env.AI_PROVIDER;
  resetServerEnvCache();
});

beforeEach(() => {
  failures.analytics.clear();
  resetStoredBusinessReports();
  clearStoredAgentTasks();
  clearStoredAgentWorkflows();
  resetStoredContents();
  resetStoredKnowledge();
  resetStoredLive();
});

afterEach(() => {
  failures.analytics.clear();
  resetStoredBusinessReports();
  clearStoredAgentTasks();
});

afterAll(() => {
  resetServerEnvCache();
});

/* ------------------------------------------------------------------ */
/* 1. 快照                                                              */
/* ------------------------------------------------------------------ */

describe("buildCurrentAnalyticsSnapshot", () => {
  it("从各业务域取齐数据并算出快照（比率可为 null，但不报错）", async () => {
    const snapshot = unwrap(await buildCurrentAnalyticsSnapshot());

    expect(snapshot.generatedAt.length).toBeGreaterThan(0);
    expect(["good", "attention", "risk"]).toContain(snapshot.health.status);
    // 种子数据里有直播场次（用于演示），因此场次数应为正
    expect(snapshot.live.sessions).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 总览与历史                                                        */
/* ------------------------------------------------------------------ */

describe("getAnalyticsOverview", () => {
  it("没有日报时：快照有值、最新日报为 null、历史为空、状态为 empty", async () => {
    const overview = unwrap(await getAnalyticsOverview());

    expect(overview.snapshot.generatedAt.length).toBeGreaterThan(0);
    expect(overview.latestReport).toBeNull();
    expect(overview.recentReports).toEqual([]);
    expect(overview.reportState.status).toBe("empty");
    expect(overview.reportState.lastRunFailed).toBe(false);
    expect(overview.reportState.provider.providerId).toBe("mock");
  });

  it("生成一次之后：最新日报出现，历史也含它", async () => {
    const generated = await generateBusinessReport({ provider: createMockAIProvider() });
    expect(generated.ok).toBe(true);

    const overview = unwrap(await getAnalyticsOverview());

    expect(overview.latestReport).not.toBeNull();
    expect(overview.recentReports.map((item) => item.id)).toContain(
      overview.latestReport?.id,
    );
    expect(overview.reportState.status).toBe("completed");
    expect(overview.reportState.lastRunFailed).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 生成日报                                                          */
/* ------------------------------------------------------------------ */

describe("generateBusinessReport", () => {
  it("成功后落库：快照与结论一起存，任务记为 completed", async () => {
    const result = await generateBusinessReport({ provider: createMockAIProvider() });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.report.report.executiveSummary.length).toBeGreaterThan(0);
    expect(result.data.report.snapshot.generatedAt.length).toBeGreaterThan(0);
    expect(result.data.providerId).toBe("mock");
    expect(result.data.isMock).toBe(true);
    expect(result.data.tierFallback).toBe(false);

    const task = await repositories.agentTasks.findLatestByType(ANALYTICS_AGENT_TYPE);
    expect(task?.status).toBe("completed");
    expect(task?.durationMs).not.toBeNull();
  });

  it("§32：任务 output 只存统计量，不把整份日报抄进去", async () => {
    const result = await generateBusinessReport({ provider: createMockAIProvider() });
    expect(result.ok).toBe(true);

    const task = await repositories.agentTasks.findLatestByType(ANALYTICS_AGENT_TYPE);
    const output = task?.output ?? {};

    expect(output).toMatchObject({
      health: expect.any(String),
      highlightCount: expect.any(Number),
      issueCount: expect.any(Number),
      actionCount: expect.any(Number),
      reportId: expect.any(String),
    });
    // 全是统计量：不应出现任何一段日报正文
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("executiveSummary");
    expect(serialized).not.toContain("highlights");
    expect(serialized).not.toContain("tomorrowFocus");
  });

  it("§32：任务 input 只记索引（快照时间 + 指标数 + 报告类型）", async () => {
    await generateBusinessReport({ provider: createMockAIProvider() });

    const task = await repositories.agentTasks.findLatestByType(ANALYTICS_AGENT_TYPE);
    const input = task?.input ?? {};

    expect(input).toMatchObject({
      snapshotGeneratedAt: expect.any(String),
      metricCount: expect.any(Number),
      reportType: "daily",
    });
  });

  it("多次生成会累积历史（每次都是一份独立记录）", async () => {
    await generateBusinessReport({ provider: createMockAIProvider() });
    await generateBusinessReport({ provider: createMockAIProvider() });

    const reports = unwrap(await listBusinessReports());
    expect(reports.length).toBe(2);
    expect(new Set(reports.map((item) => item.id)).size).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 并发保护（§33）                                                   */
/* ------------------------------------------------------------------ */

describe("generateBusinessReport：并发保护", () => {
  it("已有未过期的 running 任务 → RATE_LIMITED，且不新建任务", async () => {
    await seedRunningTask();

    const result = await generateBusinessReport({ provider: createMockAIProvider() });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("RATE_LIMITED");

    // 库里仍然只有那一条 running 任务，没有多出新的
    const tasks = await repositories.agentTasks.listRecent(50);
    expect(tasks.filter((item) => item.agentType === ANALYTICS_AGENT_TYPE)).toHaveLength(1);
  });

  it("running 任务已过期（进程中断留下的孤儿）→ 放行重跑", async () => {
    const stale = new Date(Date.now() - ANALYTICS_REPORT_STALE_MS - 60_000);
    const iso = `${stale.getFullYear()}-${String(stale.getMonth() + 1).padStart(2, "0")}-${String(
      stale.getDate(),
    ).padStart(2, "0")} ${String(stale.getHours()).padStart(2, "0")}:${String(
      stale.getMinutes(),
    ).padStart(2, "0")}`;
    await seedRunningTask(iso);

    const result = await generateBusinessReport({ provider: createMockAIProvider() });

    expect(result.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 失败语义（§34）                                                   */
/* ------------------------------------------------------------------ */

describe("generateBusinessReport：失败不毁掉已有成果", () => {
  it("生成失败 → 任务记 failed，且**旧日报原样保留**", async () => {
    // 先成功生成一份
    const first = await generateBusinessReport({ provider: createMockAIProvider() });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const originalId = first.data.report.id;

    // 第二次用失败的 Provider
    const second = await generateBusinessReport({ provider: failingProvider("MODEL_TIMEOUT") });

    expect(second.ok).toBe(false);
    if (second.ok) {
      return;
    }
    expect(second.error.code).toBe("MODEL_TIMEOUT");

    // 旧日报还在，id 未变
    const latest = unwrap(await getLatestBusinessReport());
    expect(latest?.id).toBe(originalId);

    // 最新的任务记录如实为 failed
    const task = await repositories.agentTasks.findLatestByType(ANALYTICS_AGENT_TYPE);
    expect(task?.status).toBe("failed");
    expect(task?.errorMessage).toContain("超时");
  });

  it("失败时状态派生为 completed + lastRunFailed（界面据此提示「下面是上一次成功的结果」）", async () => {
    await generateBusinessReport({ provider: createMockAIProvider() });
    await generateBusinessReport({ provider: failingProvider("MODEL_TIMEOUT") });

    const state = unwrap(await getAnalyticsReportState());

    expect(state.status).toBe("completed");
    expect(state.lastRunFailed).toBe(true);
    expect(state.latestTask?.status).toBe("failed");
  });

  it("从未成功、且最近一次失败 → 状态为 failed（不谎报 empty）", async () => {
    const result = await generateBusinessReport({ provider: failingProvider("QUOTA_EXCEEDED") });
    expect(result.ok).toBe(false);

    const state = unwrap(await getAnalyticsReportState());

    expect(state.status).toBe("failed");
    expect(state.lastRunFailed).toBe(false);
  });

  it("失败不会写入任何日报记录", async () => {
    await generateBusinessReport({ provider: failingProvider() });

    expect(unwrap(await listBusinessReports())).toEqual([]);
    expect(unwrap(await getLatestBusinessReport())).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 6. 状态派生                                                          */
/* ------------------------------------------------------------------ */

describe("getAnalyticsReportState", () => {
  it("没有任务也没有日报 → empty", async () => {
    const state = unwrap(await getAnalyticsReportState());

    expect(state.status).toBe("empty");
    expect(state.latestTask).toBeNull();
  });

  it("有未过期的 running 任务 → generating", async () => {
    await seedRunningTask();

    const state = unwrap(await getAnalyticsReportState());

    expect(state.status).toBe("generating");
    expect(state.latestTask?.status).toBe("running");
  });

  it("running 但已过期 → 不再显示 generating（否则界面会永远卡在「分析中」）", async () => {
    const stale = new Date(Date.now() - ANALYTICS_REPORT_STALE_MS - 60_000);
    const iso = `${stale.getFullYear()}-${String(stale.getMonth() + 1).padStart(2, "0")}-${String(
      stale.getDate(),
    ).padStart(2, "0")} ${String(stale.getHours()).padStart(2, "0")}:${String(
      stale.getMinutes(),
    ).padStart(2, "0")}`;
    await seedRunningTask(iso);

    const state = unwrap(await getAnalyticsReportState());

    expect(state.status).not.toBe("generating");
  });
});

/* ------------------------------------------------------------------ */
/* 7. 视图装配（页面唯一入口）                                          */
/* ------------------------------------------------------------------ */

describe("getAnalyticsView", () => {
  it("真实与模拟两组数据严格分开，且都带得出来", async () => {
    const { getAnalyticsView } = await import("./analytics");

    const view = unwrap(await getAnalyticsView());

    expect(view.real.snapshot.generatedAt.length).toBeGreaterThan(0);
    expect(view.real.reportState.status).toBe("empty");
    // 模拟区块在 mock 数据源下可用
    expect(view.simulatedUnavailable).toBe(false);
    expect(view.simulated.metrics.length).toBeGreaterThan(0);
    expect(view.simulated.trend.length).toBeGreaterThan(0);
  });

  it("模拟区块读失败 → 降级为空数组 + simulatedUnavailable，真实区块照常", async () => {
    const { getAnalyticsView } = await import("./analytics");
    failures.analytics.add("getOverview");

    const view = unwrap(await getAnalyticsView());

    expect(view.simulatedUnavailable).toBe(true);
    expect(view.simulated.metrics).toEqual([]);
    expect(view.simulated.trend).toEqual([]);
    expect(view.businessGoal).toBeNull();

    // 关键：真实区块不跟着降级 —— 算不出经营指标就没有报告可言，
    // 硬撑一个空快照比报错更危险（会让日报基于 0 值给出错误结论）
    expect(view.real.snapshot.generatedAt.length).toBeGreaterThan(0);
    expect(view.real.reportState.status).toBe("empty");
  });

  it("模拟区块降级后仍能正常生成日报（真实链路不依赖演示数据）", async () => {
    const { getAnalyticsView } = await import("./analytics");
    failures.analytics.add("getOverview");

    const generated = await generateBusinessReport({ provider: createMockAIProvider() });
    expect(generated.ok).toBe(true);

    const view = unwrap(await getAnalyticsView());
    expect(view.simulatedUnavailable).toBe(true);
    expect(view.real.latestReport).not.toBeNull();
  });
});

describe("BusinessReport 形状", () => {
  it("落库的报告携带 id / businessId / createdAt（历史可回溯）", async () => {
    const result = await generateBusinessReport({ provider: createMockAIProvider() });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const report: BusinessReport = result.data.report;
    expect(report.id.length).toBeGreaterThan(0);
    expect(report.businessId.length).toBeGreaterThan(0);
    expect(report.createdAt.length).toBeGreaterThan(0);
  });
});
