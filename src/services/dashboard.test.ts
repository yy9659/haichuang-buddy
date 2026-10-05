/**
 * 驾驶舱服务单测（S4-2）
 *
 * 这一层是「真实数据」与「演示数据」的分界线，因此测试的核心是**边界本身**：
 *
 *   1. **员工状态一律由任务推出**。名册只回答「这个员工是谁、能不能干活」；
 *      「他现在在不在忙」必须来自 `agent_tasks`。由此得到一条安全性质：
 *      **未接入的 Agent 状态恒为 `idle`**，不可能显示成「运行中」——
 *      假 Agent 在类型层面就构造不出来（§19）。
 *   2. **Business Brain 的四个相位**（空闲 / 待确认 / 执行中 / 中断）要能
 *      与真实工作流记录一一对应（§20）。
 *   3. **装饰性区块降级、真实数据失败即整体失败**。`DATA_SOURCE=db` 时
 *      直播与分析的仓储会抛 NOT_IMPLEMENTED；老实现会让整页 500 ——
 *      那是把「一个区块没有数据」放大成「整个驾驶舱用不了」。
 *      降级是允许的，**不告诉用户**才是问题，因此降级区块要如实记进
 *      `unavailableSections`。
 *   4. **进度的口径是真实步数**，且运行中的那一轮在摘要写库之前
 *      如实显示 `0 / N`（库里确实还没有结果），而不是编一个数字（§12）。
 *
 * 为了让降级路径可测，`analytics` / `live` 两个仓储由假实现包一层：
 * 通过 `failures` 开关注入「某个方法抛错」，验证的是**服务层的降级策略**，
 * 而不是 Mock 数据本身。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const failures = vi.hoisted(() => ({
  analytics: new Set<string>(),
  live: new Set<string>(),
  reports: new Set<string>(),
}));

vi.mock("@/repositories/mock/analytics", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/repositories/mock/analytics")>();
  return {
    ...actual,
    createMockAnalyticsRepository: () => {
      const repo = actual.createMockAnalyticsRepository();
      const guard = (key: string): void => {
        if (failures.analytics.has(key)) {
          throw new Error(`注入的失败：analytics.${key}`);
        }
      };
      return {
        ...repo,
        getOverview: async () => {
          guard("getOverview");
          return repo.getOverview();
        },
        getDashboardMetrics: async () => {
          guard("getDashboardMetrics");
          return repo.getDashboardMetrics();
        },
        getBusinessGoal: async () => {
          guard("getBusinessGoal");
          return repo.getBusinessGoal();
        },
      };
    },
  };
});

/**
 * 经营日报已从 `analytics` 仓储迁到独立的 `reports` 仓储（S6-B 第四节）。
 * 这里用同一套「注入失败」的手法验证服务层的降级策略 ——
 * 验证的是**服务层读到报告失败时怎么表现**，而不是 Mock 数据本身。
 */
vi.mock("@/repositories/mock/reports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/repositories/mock/reports")>();
  return {
    ...actual,
    createMockAnalyticsReportRepository: () => {
      const repo = actual.createMockAnalyticsReportRepository();
      const guard = (key: string): void => {
        if (failures.reports.has(key)) {
          throw new Error(`注入的失败：reports.${key}`);
        }
      };
      return {
        ...repo,
        findLatest: async () => {
          guard("findLatest");
          return repo.findLatest();
        },
      };
    },
  };
});

vi.mock("@/repositories/mock/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/repositories/mock/live")>();
  return {
    ...actual,
    createMockLiveRepository: () => {
      const repo = actual.createMockLiveRepository();
      const guard = (key: string): void => {
        if (failures.live.has(key)) {
          throw new Error(`注入的失败：live.${key}`);
        }
      };
      return {
        ...repo,
        getSession: async () => {
          guard("getSession");
          return repo.getSession();
        },
        getStats: async () => {
          guard("getStats");
          return repo.getStats();
        },
        listComments: async () => {
          guard("listComments");
          return repo.listComments();
        },
      };
    },
  };
});

import { createMockAIProvider } from "@/ai/provider/mock";
import { formatDateTime } from "@/lib/datetime";
import { resetServerEnvCache } from "@/lib/env";
import { unwrapOrThrow } from "@/lib/result";
import { MOCK_BUSINESS } from "@/lib/mock";
import { getRepositories, type NewProductInput } from "@/repositories";
import {
  clearStoredAgentTasks,
  clearStoredAgentWorkflows,
  clearStoredBrandProfile,
  putStoredKnowledgeGap,
  replaceStoredAgentWorkflow,
  resetStoredContents,
  resetStoredConversations,
  resetStoredKnowledge,
} from "@/repositories/mock/store";
import type { AgentStatus } from "@/types";

import { createBusinessPlan, startBusinessWorkflow } from "./business-brain.service";
import {
  WORKFLOW_STATS_WINDOW,
  getDashboardOverview,
  type DashboardAgentState,
} from "./dashboard";

pinCleanMockEnv();

const repositories = getRepositories();

const originalEnv = {
  DATA_SOURCE: process.env.DATA_SOURCE,
  DATABASE_URL: process.env.DATABASE_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  AI_PROVIDER: process.env.AI_PROVIDER,
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  AI_API_KEY: process.env.AI_API_KEY,
};

function pinCleanMockEnv(): void {
  process.env.DATA_SOURCE = "mock";
  delete process.env.DATABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.AI_PROVIDER;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.AI_API_KEY;
  resetServerEnvCache();
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetServerEnvCache();
}

const createdProductIds: string[] = [];

async function createTestProduct(overrides: Partial<NewProductInput> = {}) {
  const product = await repositories.products.create({
    name: "连江测试用鲜活鲍鱼",
    description: "当日现捞，肉质厚实弹牙。",
    category: "海产品",
    subCategory: "鲍鱼",
    price: 128,
    unit: "500g",
    origin: "福建连江 · 黄岐半岛",
    specification: "8-10 头 / 500g",
    tags: ["鲜活"],
    ...overrides,
  });
  createdProductIds.push(product.id);
  return product;
}

/** 规划一份渠道驱动的六 Agent 计划（7 步，内容 Agent 占两个渠道任务） */
async function planChannelDriven(goal = "为今晚准备全链路推广闭环") {
  const planned = await createBusinessPlan(goal, {
    provider: createMockAIProvider(),
    channels: ["douyin", "wechat"],
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) {
    throw new Error("测试前置失败：规划未成功");
  }
  return planned.data;
}

beforeAll(() => {
  pinCleanMockEnv();
});

beforeEach(() => {
  pinCleanMockEnv();
  failures.analytics.clear();
  failures.live.clear();
  failures.reports.clear();
  clearStoredAgentTasks();
  clearStoredAgentWorkflows();
  resetStoredContents();
  clearStoredBrandProfile();
  resetStoredKnowledge();
  resetStoredConversations();
});

afterEach(async () => {
  for (const id of createdProductIds.splice(0)) {
    const existing = await repositories.products.getById(id);
    if (existing) {
      await repositories.products.delete(id);
    }
  }
  resetStoredContents();
  clearStoredAgentTasks();
  failures.analytics.clear();
  failures.live.clear();
  failures.reports.clear();
});

afterAll(() => {
  restoreEnv();
});

/* ------------------------------------------------------------------ */
/* 1. 空态基线                                                          */
/* ------------------------------------------------------------------ */

describe("getDashboardOverview：初始状态", () => {
  it("没有任何工作流与任务时，六张员工卡片都在，且状态全部为真实来源", async () => {
    await createTestProduct();

    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.agentStates).toHaveLength(6);

    const available = overview.agentStates.filter((agent) => agent.available);
    const pending = overview.agentStates.filter((agent) => !agent.available);

    /**
     * S6-B：经营分析师（analytics_agent）是编制的最后一位，至此 6 / 6 全部接入。
     * `pending` 必须为空 —— 只要还有人 `available=false`，就说明名册与实现脱节了。
     */
    expect(available.map((agent) => agent.id).sort()).toEqual([
      "analytics_agent",
      "brand_agent",
      "content_agent",
      "customer_service_agent",
      "live_agent",
      "product_agent",
    ]);
    expect(pending).toEqual([]);

    // 已接入但从未跑过：有记录地"没有"（hasHistory=false），而不是编一条
    for (const agent of available) {
      expect(agent.status).toBe("idle");
      expect(agent.hasHistory).toBe(false);
      expect(agent.currentTask).toBeNull();
      expect(agent.lastRunAt).toBeNull();
    }

    /**
     * Task 81：智能客服即使 status=idle，也必须挂上 statusLabel='待命' 而不是
     * 「暂无任务」—— 这是 driving cabin 与客服工作台之间的语义桥。
     */
    const customerAgent = available.find(
      (agent) => agent.id === "customer_service_agent",
    );
    expect(customerAgent?.available).toBe(true);
    expect(customerAgent?.href).toBe("/customer-service");
    expect(customerAgent?.statusLabel).toBe("待命");

    /**
     * S6：AI 直播导演同样上线，且与客服共享那套「服务是否正常」的措辞 ——
     * 从未跑过时必须显示「待命」，而不是「暂无任务」。
     */
    const liveAgent = available.find((agent) => agent.id === "live_agent");
    expect(liveAgent?.available).toBe(true);
    expect(liveAgent?.href).toBe("/live");
    expect(liveAgent?.statusLabel).toBe("待命");

    /**
     * S6-B §20：经营分析师上线后同样遵守这套措辞 ——
     * 从未复盘过（没有 agent_tasks 记录）时显示「待命」，指向经营分析页。
     */
    const analyticsAgent = available.find((agent) => agent.id === "analytics_agent");
    expect(analyticsAgent?.available).toBe(true);
    expect(analyticsAgent?.href).toBe("/analytics");
    expect(analyticsAgent?.statusLabel).toBe("待命");
    expect(analyticsAgent?.unavailableNote).toBe("");
  });

  it("工作流为空时 Business Brain 空闲、进度为空（而不是 0 / 0 冒充进度）", async () => {
    await createTestProduct();

    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.businessBrain.phase).toBe("idle");
    expect(overview.businessBrain.goal).toBeNull();
    expect(overview.businessBrain.progress).toBeNull();
    expect(overview.businessBrain.lastStatus).toBeNull();
    expect(overview.businessBrain.workflowId).toBeNull();
    expect(overview.businessBrain.canLaunch).toBe(true);
    expect(overview.businessBrain.provider.isMock).toBe(true);

    expect(overview.activeWorkflow).toBeNull();
    expect(overview.recentWorkflows).toEqual([]);
    expect(overview.workflowStats).toMatchObject({
      windowSize: WORKFLOW_STATS_WINDOW,
      total: 0,
      completed: 0,
      failed: 0,
      running: 0,
      idle: 0,
      executedTasks: 0,
      reusedTasks: 0,
    });
  });

  it("计划对话框的商品选项来自真实商品，并带上「有没有商品理解」", async () => {
    const product = await createTestProduct({ name: "连江测试用无理解商品" });

    const overview = unwrapOrThrow(await getDashboardOverview());
    const option = overview.planningProducts.find((item) => item.id === product.id);

    expect(option).toBeDefined();
    expect(option?.name).toBe("连江测试用无理解商品");
    expect(option?.hasDna).toBe(false);
    expect(option?.analysisStatus).toBe("pending");
  });

  it("Mock 数据源下装饰性区块全部可用，没有降级区块", async () => {
    await createTestProduct();
    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.dataSource.dataSource).toBe("mock");
    expect(overview.unavailableSections).toEqual([]);
    expect(overview.metrics.length).toBeGreaterThan(0);
    expect(overview.trend.length).toBeGreaterThan(0);
    expect(overview.liveSession).not.toBeNull();
    expect(overview.spotlightProduct).not.toBeNull();
    expect(overview.productCount).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Business Brain 的四个相位                                          */
/* ------------------------------------------------------------------ */

describe("getDashboardOverview：Business Brain 相位", () => {
  it("计划已生成、等商家确认 → awaiting_confirmation（不能叫「规划中」）", async () => {
    const product = await createTestProduct();
    const planned = await planChannelDriven();

    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.businessBrain.phase).toBe("awaiting_confirmation");
    expect(overview.businessBrain.workflowId).toBe(planned.workflowId);
    // 落库的是**组装后**的目标（含渠道），不是商家原话 —— 否则历史里查不出"当时投了哪些渠道"
    expect(overview.businessBrain.goal).toBe(planned.plan.goal);
    expect(overview.businessBrain.goal).toContain("渠道：抖音短视频脚本、朋友圈海报文案");
    expect(overview.businessBrain.lastStatus).toBe("idle");
    expect(overview.businessBrain.canLaunch).toBe(true);
    // 计划已生成但一步都没跑：进度必须是 null，不是 0 / 4
    expect(overview.businessBrain.progress).toBeNull();

    expect(overview.recentWorkflows).toHaveLength(1);
    expect(overview.recentWorkflows[0]?.status).toBe("idle");
    expect(overview.recentWorkflows[0]?.productNames).toContain(product.name);
    expect(overview.recentWorkflows[0]?.progress).toEqual({
      done: 0,
      total: planned.plan.tasks.length,
      running: 0,
    });
    expect(overview.workflowStats).toMatchObject({ total: 1, idle: 1, executedTasks: 0 });
  });

  it("正在执行且未过期 → executing，且禁止再发起", async () => {
    await createTestProduct();
    const planned = await planChannelDriven();

    // markRunning 会清掉上一轮的摘要 —— 因此此时库里确实没有任何一步的结果
    await repositories.agentWorkflows.markRunning(planned.workflowId);

    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.businessBrain.phase).toBe("executing");
    expect(overview.businessBrain.canLaunch).toBe(false);
    expect(overview.activeWorkflow?.id).toBe(planned.workflowId);
    expect(overview.activeWorkflow?.isStale).toBe(false);
    // §12：运行期间如实显示 0 / N（摘要要等整轮结束才写库），绝不编一个百分比
    expect(overview.businessBrain.progress).toEqual({
      done: 0,
      total: planned.plan.tasks.length,
      running: 0,
    });
    expect(overview.workflowStats).toMatchObject({ total: 1, running: 1 });
  });

  it("running 超过 10 分钟 → interrupted，并重新放行新一轮", async () => {
    await createTestProduct();
    const planned = await planChannelDriven();
    const running = await repositories.agentWorkflows.markRunning(planned.workflowId);

    replaceStoredAgentWorkflow({
      ...running,
      createdAt: formatDateTime(new Date(Date.now() - 11 * 60 * 1000)),
    });

    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.businessBrain.phase).toBe("interrupted");
    // 卡住的 running 不处理掉，新建计划会被并发保护挡住 —— 因此这里必须放行
    expect(overview.businessBrain.canLaunch).toBe(true);
    expect(overview.activeWorkflow).toBeNull();
    expect(overview.recentWorkflows[0]?.isStale).toBe(true);
  });

  it("执行完成后回到 idle，但保留「最近一次」的结论与收尾时间", async () => {
    const product = await createTestProduct();
    const planned = await planChannelDriven();

    const started = await startBusinessWorkflow(planned.workflowId, {
      provider: createMockAIProvider(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.data.status).toBe("completed");

    const overview = unwrapOrThrow(await getDashboardOverview());
    const item = overview.recentWorkflows[0];

    expect(overview.businessBrain.phase).toBe("idle");
    expect(overview.businessBrain.lastStatus).toBe("completed");
    expect(overview.businessBrain.lastCompletedAt).not.toBeNull();
    expect(overview.businessBrain.canLaunch).toBe(true);

    // 全链路真实落地：7 步全部执行，其中两条是内容任务
    expect(item?.status).toBe("completed");
    expect(item?.progress.done).toBe(item?.progress.total);
    expect(item?.outcome.executed).toBe(7);
    expect(item?.outcome.reused).toBe(0);
    expect(item?.outcome.failed).toBe(0);
    expect(item?.outcome.newAssets).toBe(2);
    expect(item?.hasContentTask).toBe(true);
    expect(item?.errorMessage).toBeNull();

    expect(overview.workflowStats).toMatchObject({
      total: 1,
      completed: 1,
      executedTasks: 7,
      reusedTasks: 0,
    });

    // 员工卡片的状态由真实任务推出
    const productAgent = overview.agentStates.find(
      (agent) => agent.id === "product_agent",
    );
    expect(productAgent?.status).toBe("completed");
    expect(productAgent?.hasHistory).toBe(true);
    expect(productAgent?.currentTask).toContain(product.name);
    expect(productAgent?.lastRunAt).not.toBeNull();
    expect(productAgent?.lastRunSummary).toBe("最近一次执行已完成。");
  });
});

/* ------------------------------------------------------------------ */
/* 3. 降级与失败语义                                                    */
/* ------------------------------------------------------------------ */

describe("getDashboardOverview：降级策略", () => {
  it("装饰性区块读失败 → 降级为空并记进 unavailableSections（去重 + 排序）", async () => {
    await createTestProduct();

    failures.analytics.add("getOverview");
    failures.reports.add("findLatest");
    failures.analytics.add("getBusinessGoal");
    // live 有三次读取，都应该被收敛成同一个区块名
    failures.live.add("getSession");
    failures.live.add("getStats");
    failures.live.add("listComments");

    const result = await getDashboardOverview();

    // 关键：一个区块读不到，不该把整个驾驶舱拖垮
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.unavailableSections).toEqual([
      "businessGoal",
      "dailyReport",
      "live",
      "trend",
    ]);
    expect(result.data.trend).toEqual([]);
    expect(result.data.dailyReport).toBeNull();
    expect(result.data.businessGoal).toBeNull();
    expect(result.data.liveSession).toBeNull();
    expect(result.data.liveStats).toBeNull();
    expect(result.data.liveComments).toEqual([]);

    // 没失败的区块照常给出真实内容
    expect(result.data.metrics.length).toBeGreaterThan(0);
    expect(result.data.productCount).toBeGreaterThan(0);
  });

  it("单个装饰性区块失败不影响其它区块", async () => {
    await createTestProduct();
    failures.reports.add("findLatest");

    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.unavailableSections).toEqual(["dailyReport"]);
    expect(overview.dailyReport).toBeNull();
    expect(overview.trend.length).toBeGreaterThan(0);
    expect(overview.liveSession).not.toBeNull();
  });

  it("真实数据拿不到（DATA_SOURCE=db 但没配连接串）→ 整体失败，绝不静默给一份空驾驶舱", async () => {
    process.env.DATA_SOURCE = "db";
    delete process.env.DATABASE_URL;
    resetServerEnvCache();

    const result = await getDashboardOverview();

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.message).toContain("数据库");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Task 81：客服 Agent 状态映射 + 知识缺口提醒                       */
/* ------------------------------------------------------------------ */

/**
 * Task 81 §8 / §10 / §11：驾驶舱客服卡片与提醒。
 *
 * 关键不变量：
 * - `needsHumanConversationCount > 0` **不**等于 Agent failed（§27）
 * - 知识缺口数 > 0 时驾驶舱要展示提醒，但**不染红警报**
 * - `topGaps` 至多 3 条，按 occurrenceCount DESC（任务书第十一节，沿用 Task 78 排序）
 */
describe("getDashboardOverview：客服 Agent 状态映射（Task 81）", () => {
  async function seedAgentTask(status: AgentStatus): Promise<void> {
    const task = await repositories.agentTasks.create({
      agentType: "customer_service_agent",
      title: "客服会话问答",
      status,
      ...(status === "completed" || status === "failed"
        ? { input: {} }
        : { input: {} }),
    });
    if (status === "completed") {
      await repositories.agentTasks.update(task.id, {
        status: "completed",
        output: {
          intent: "storage",
          grounded: true,
          needsHuman: false,
          retrievedChunkCount: 3,
          citationCount: 2,
        },
        durationMs: 1200,
      });
    } else if (status === "failed") {
      await repositories.agentTasks.update(task.id, {
        status: "failed",
        errorMessage: "模型响应超时",
        durationMs: 90000,
      });
    }
  }

  it("没有客服任务 → 待命（不是『暂无任务』）", async () => {
    await createTestProduct();
    const overview = unwrapOrThrow(await getDashboardOverview());

    const cs = overview.agentStates.find(
      (agent) => agent.id === "customer_service_agent",
    );
    expect(cs?.statusLabel).toBe("待命");
    expect(cs?.customerServiceMetrics).not.toBeNull();
    expect(cs?.customerServiceMetrics?.todayAnsweredCount).toBe(0);
  });

  it("最近任务 = completed → 最近服务正常", async () => {
    await createTestProduct();
    await seedAgentTask("completed");

    const overview = unwrapOrThrow(await getDashboardOverview());
    const cs = overview.agentStates.find(
      (agent) => agent.id === "customer_service_agent",
    );

    expect(cs?.status).toBe("completed");
    expect(cs?.statusLabel).toBe("最近服务正常");
  });

  it("最近任务 = failed → 最近一次服务异常（这不是『客服挂了』）", async () => {
    await createTestProduct();
    await seedAgentTask("failed");

    const overview = unwrapOrThrow(await getDashboardOverview());
    const cs = overview.agentStates.find(
      (agent) => agent.id === "customer_service_agent",
    );

    expect(cs?.status).toBe("failed");
    expect(cs?.statusLabel).toBe("最近一次服务异常");
  });

  it("needsHumanConversationCount > 0 但 Agent 任务 completed → 不染成 failed（§27）", async () => {
    await createTestProduct();
    await seedAgentTask("completed");
    /**
     * 关键场景：客服会话 status=human（需人工），但 Agent 任务仍是 completed ——
     * 因为 Agent 正确识别出「依据不足」本身就是一次成功的执行。
     * 商家从卡片上看到的是「服务正常」+「待人工提醒」两个独立维度，
     * 而不是把「有客户等人工」放大成「AI 失败了」。
     */
    await repositories.conversations.createConversation({
      customerName: "心急买家",
      channel: "simulator",
    });
    /**
     * 把会话推进为 human —— Mock 实现的 updateStatus 不立即持久化，
     * 但 customer-service Service 才是状态推进的真实路径；
     * 这里通过 updateConversation 直接置位，避免起一次 AI。
     */
    const conversations = await repositories.conversations.listConversations();
    const last = conversations[0];
    if (last) {
      await repositories.conversations.updateConversation(last.id, {
        status: "human",
      });
    }

    const overview = unwrapOrThrow(await getDashboardOverview());
    const cs = overview.agentStates.find(
      (agent) => agent.id === "customer_service_agent",
    );

    expect(cs?.status).toBe("completed");
    expect(cs?.statusLabel).toBe("最近服务正常");
    /** 业务提醒维度：会话数出现在 customerServiceMetrics，但不是 failed */
    expect(cs?.customerServiceMetrics?.needsHumanConversationCount).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5. S6-B §20：经营分析师（Analytics Agent）卡片状态                    */
/* ------------------------------------------------------------------ */

/**
 * 经营分析师卡片回答的是「**复盘正不正常**」，文案与客服 / 直播同一套判断：
 *
 * - 没有任务 → 待命（还没做过一次复盘）
 * - running / queued → 分析中
 * - completed → 最近复盘正常（一次成功复盘的产物就是一份日报）
 * - failed → 最近一次复盘异常（旧日报仍保留，见 analytics.service）
 */
describe("getDashboardOverview：经营分析师状态映射（S6-B §20）", () => {
  async function seedAnalyticsTask(status: AgentStatus): Promise<void> {
    const task = await repositories.agentTasks.create({
      agentType: "analytics_agent",
      title: "生成今日经营日报",
      status,
      input: { reportType: "daily" },
    });
    if (status === "completed") {
      await repositories.agentTasks.update(task.id, {
        status: "completed",
        output: { health: "good", highlightCount: 1, issueCount: 0, actionCount: 1 },
        durationMs: 4200,
      });
    } else if (status === "failed") {
      await repositories.agentTasks.update(task.id, {
        status: "failed",
        errorMessage: "模型响应超时",
        durationMs: 90000,
      });
    }
  }

  function analyticsCard(overview: { agentStates: DashboardAgentState[] }) {
    return overview.agentStates.find((agent) => agent.id === "analytics_agent");
  }

  it("没有任务 → 待命，并指向经营分析页", async () => {
    await createTestProduct();
    const overview = unwrapOrThrow(await getDashboardOverview());
    const card = analyticsCard(overview);

    expect(card?.status).toBe("idle");
    expect(card?.statusLabel).toBe("待命");
    expect(card?.href).toBe("/analytics");
    expect(card?.hasHistory).toBe(false);
  });

  it("最近任务 = completed → 最近复盘正常", async () => {
    await createTestProduct();
    await seedAnalyticsTask("completed");

    const card = analyticsCard(unwrapOrThrow(await getDashboardOverview()));

    expect(card?.status).toBe("completed");
    expect(card?.statusLabel).toBe("最近复盘正常");
    expect(card?.hasHistory).toBe(true);
    expect(card?.lastRunAt).not.toBeNull();
  });

  it("最近任务 = running → 分析中", async () => {
    await createTestProduct();
    await seedAnalyticsTask("running");

    const card = analyticsCard(unwrapOrThrow(await getDashboardOverview()));

    expect(card?.status).toBe("running");
    expect(card?.statusLabel).toBe("分析中");
  });

  it("最近任务 = failed → 最近一次复盘异常（措辞限定在「最近一次」）", async () => {
    await createTestProduct();
    await seedAnalyticsTask("failed");

    const card = analyticsCard(unwrapOrThrow(await getDashboardOverview()));

    expect(card?.status).toBe("failed");
    expect(card?.statusLabel).toBe("最近一次复盘异常");
    expect(card?.lastRunSummary).toContain("超时");
  });

  it("六位员工全部 available=true（顶部 6 / 6 的依据）", async () => {
    await createTestProduct();
    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.agentStates).toHaveLength(6);
    expect(overview.agentStates.every((agent) => agent.available)).toBe(true);
    expect(overview.agentStates.every((agent) => agent.unavailableNote === "")).toBe(
      true,
    );
  });
});

describe("getDashboardOverview：知识缺口提醒（Task 81 §10 §11）", () => {
  it("没有缺口 → customerService.topGaps 为空", async () => {
    await createTestProduct();
    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.customerService).not.toBeNull();
    expect(overview.customerService?.openKnowledgeGapCount).toBe(0);
    expect(overview.customerService?.topGaps).toEqual([]);
  });

  it("缺口按 occurrenceCount DESC 排序，且最多 3 条", async () => {
    await createTestProduct();
    /** 注入 4 条，让排序规则真正起作用 */
    putStoredKnowledgeGap({
      id: "gap_a",
      businessId: MOCK_BUSINESS.id,
      productId: null,
      question: "多久发货？",
      normalizedQuestion: "多久发货",
      gapKey: "gap_a",
      intent: "logistics",
      reason: "演示",
      status: "open",
      occurrenceCount: 8,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      resolvedDocumentId: null,
    });
    putStoredKnowledgeGap({
      id: "gap_b",
      businessId: MOCK_BUSINESS.id,
      productId: null,
      question: "鲍鱼怎么保存？",
      normalizedQuestion: "鲍鱼怎么保存",
      gapKey: "gap_b",
      intent: "storage",
      reason: "演示",
      status: "open",
      occurrenceCount: 5,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      resolvedDocumentId: null,
    });
    putStoredKnowledgeGap({
      id: "gap_c",
      businessId: MOCK_BUSINESS.id,
      productId: null,
      question: "支持礼盒吗？",
      normalizedQuestion: "支持礼盒",
      gapKey: "gap_c",
      intent: "after_sales",
      reason: "演示",
      status: "open",
      occurrenceCount: 3,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      resolvedDocumentId: null,
    });
    putStoredKnowledgeGap({
      id: "gap_d",
      businessId: MOCK_BUSINESS.id,
      productId: null,
      question: "可以囤货吗？",
      normalizedQuestion: "可以囤货",
      gapKey: "gap_d",
      intent: "after_sales",
      reason: "演示",
      status: "open",
      occurrenceCount: 1,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      resolvedDocumentId: null,
    });

    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.customerService?.openKnowledgeGapCount).toBe(4);
    /** §11：最多 3 条 */
    expect(overview.customerService?.topGaps).toHaveLength(3);
    /** §11：排序规则复用 Task 78，即 occurrenceCount DESC */
    const counts = overview.customerService?.topGaps.map(
      (gap) => gap.occurrenceCount,
    );
    expect(counts).toEqual([8, 5, 3]);
  });

  it("resolved / ignored 缺口不计入 openKnowledgeGapCount", async () => {
    await createTestProduct();
    putStoredKnowledgeGap({
      id: "gap_resolved",
      businessId: MOCK_BUSINESS.id,
      productId: null,
      question: "已解决",
      normalizedQuestion: "已解决",
      gapKey: "gap_resolved",
      intent: "logistics",
      reason: "",
      status: "resolved",
      occurrenceCount: 5,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      resolvedDocumentId: "kdoc_001",
    });
    putStoredKnowledgeGap({
      id: "gap_ignored",
      businessId: MOCK_BUSINESS.id,
      productId: null,
      question: "已忽略",
      normalizedQuestion: "已忽略",
      gapKey: "gap_ignored",
      intent: "after_sales",
      reason: "",
      status: "ignored",
      occurrenceCount: 2,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      resolvedDocumentId: null,
    });

    const overview = unwrapOrThrow(await getDashboardOverview());

    expect(overview.customerService?.openKnowledgeGapCount).toBe(0);
    expect(overview.customerService?.topGaps).toEqual([]);
  });
});
