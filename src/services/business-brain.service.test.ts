/**
 * 经营大脑业务闭环单测（Mock 数据源 + Mock Provider，不需要数据库）
 *
 * 这组测试验证的是「一次经营工作流在数据层面到底发生了什么」：
 * 计划有没有落库、工作流状态怎么流转、六个 Agent 服务的产出是否真实写入、
 * 复用判定有没有真的省掉模型调用、并发与孤儿工作流如何处置。
 *
 * 覆盖的核心场景（对应任务书 Task 8）：
 *   1. 规划 → 执行 → 查询的完整闭环（planAndRunBusinessGoal）
 *   2. 两层纠错：invalid-agent（契约层）/ circular-dependency（语义层）
 *   3. 全复用重试：retryWorkflow 一个 Agent 都不调，只补没成的
 *   4. 重复启动保护（RATE_LIMITED）与 10 分钟孤儿放行
 *   5. 商品在规划与执行之间被删除 → PLAN_INVALID
 *   6. start / retry / getWorkflowState 的状态门槛
 *
 * 注意用例顺序：全链路用例会给**演示商品**补上 DNA（mock 存储无逐条删除入口），
 * 因此依赖「初始商品状态」的用例都排在它前面，后面的用例只做与计数无关的断言。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import { formatDateTime } from "@/lib/datetime";
import { resetServerEnvCache } from "@/lib/env";
import { getRepositories, type NewProductInput } from "@/repositories";
import {
  clearStoredAgentTasks,
  clearStoredAgentWorkflows,
  clearStoredBrandProfile,
  findStoredAgentWorkflow,
  findStoredBrandProfile,
  findStoredDna,
  listStoredAgentWorkflows,
  listStoredProducts,
  putStoredDna,
  putStoredProduct,
  replaceStoredAgentWorkflow,
  resetStoredContents,
} from "@/repositories/mock/store";
import type { Product, ProductDNA } from "@/types";

import {
  MAX_BUSINESS_GOAL_LENGTH,
  WORKFLOW_RUNNING_STALE_MS,
  createBusinessPlan,
  getWorkflowState,
  planAndRunBusinessGoal,
  retryWorkflow,
  startBusinessWorkflow,
} from "./business-brain.service";

/**
 * 先归一化环境再取仓储：`getRepositories()` 在 DATA_SOURCE=db 且缺少连接串时
 * 会直接抛错，放在模块顶层就会让整个测试文件加载失败。
 */
pinCleanMockEnv();

const repositories = getRepositories();

const originalEnv = {
  DATA_SOURCE: process.env.DATA_SOURCE,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  AI_PROVIDER: process.env.AI_PROVIDER,
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  AI_API_KEY: process.env.AI_API_KEY,
};

/** 固定为「Mock 数据源 + 未配置模型提供方」，让断言不受本机 .env.local 影响 */
function pinCleanMockEnv(): void {
  process.env.DATA_SOURCE = "mock";
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

/** 本组用例创建过的商品，结束后逐个删掉（级联清理其 DNA / 内容 / 任务） */
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

/** 确定性 Provider：ok 场景或指定故障注入场景 */
function provider(scenario?: "ok") {
  return createMockAIProvider(scenario ? { scenario } : {});
}

beforeAll(() => {
  pinCleanMockEnv();
});

beforeEach(() => {
  pinCleanMockEnv();
  clearStoredAgentTasks();
  clearStoredAgentWorkflows();
  resetStoredContents();
  // 品牌档案基线为 null（mock 存储刻意不预置），显式复位防止前一个用例污染
  clearStoredBrandProfile();
});

afterEach(async () => {
  for (const id of createdProductIds.splice(0)) {
    const existing = await repositories.products.getById(id);
    if (existing) {
      await repositories.products.delete(id);
    }
  }
  resetStoredContents();
  clearStoredBrandTasks();
});

function clearStoredBrandTasks(): void {
  // 品牌任务挂在「全库最近一次 brand_agent 任务」上，必须一并清掉，
  // 否则前一个用例的 running 品牌任务会挡住下一个用例的品牌生成
  clearStoredAgentTasks();
}

afterAll(() => {
  restoreEnv();
});

/* ------------------------------------------------------------------ */
/* 1. 规划入口                                                          */
/* ------------------------------------------------------------------ */

describe("createBusinessPlan：规划", () => {
  it("成功规划：计划落库为 idle 工作流，返回值带上下文计数", async () => {
    const product = await createTestProduct();

    const result = await createBusinessPlan("这周把鲍鱼内容做起来", {
      provider: provider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // —— 返回值 ——
    expect(result.data.plan.goal).toBe("这周把鲍鱼内容做起来");
    expect(result.data.plan.tasks.length).toBeGreaterThanOrEqual(1);
    expect(result.data.providerId).toBe("mock");
    expect(result.data.isMock).toBe(true);
    expect(result.data.attempts).toBe(1);
    expect(result.data.planRounds).toBe(1);
    expect(result.data.repaired).toBe(false);
    // 计划里只允许出现六位一线 Agent（business_brain 自己不能被规划）
    for (const task of result.data.plan.tasks) {
      expect([
        "product_agent",
        "brand_agent",
        "content_agent",
        "customer_service_agent",
        "live_agent",
        "analytics_agent",
      ]).toContain(task.agent);
    }
    // 计划里必须有针对新商品的分析步骤（它还没有 DNA）
    expect(
      result.data.plan.tasks.some(
        (task) => task.agent === "product_agent" && task.productId === product.id,
      ),
    ).toBe(true);

    // —— 上下文计数 ——
    expect(result.data.context.productCount).toBeGreaterThan(0);
    expect(result.data.context.totalProductCount).toBeGreaterThanOrEqual(
      result.data.context.productCount,
    );
    expect(result.data.context.hasBrandProfile).toBe(false);

    // —— 落库 ——
    const stored = findStoredAgentWorkflow(result.data.workflowId);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("idle"); // 只规划不执行，等商家确认
    expect(stored?.plan).toMatchObject({ version: "v2.0", goal: "这周把鲍鱼内容做起来" });
  });

  it("六个渠道全部勾选时仍完整保留，并覆盖六种执行 Agent", async () => {
    const product = await createTestProduct({ name: "六渠道计划商品" });
    const result = await createBusinessPlan("完成全渠道推广闭环", {
      provider: provider(),
      primaryProductId: product.id,
      channels: [
        "douyin",
        "xiaohongshu",
        "wechat",
        "shipinhao",
        "detail",
        "ads",
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.plan.tasks).toHaveLength(11);
    expect(
      result.data.plan.tasks.filter((task) => task.agent === "content_agent"),
    ).toHaveLength(6);
    expect(new Set(result.data.plan.tasks.map((task) => task.agent))).toEqual(
      new Set([
        "product_agent",
        "brand_agent",
        "content_agent",
        "customer_service_agent",
        "live_agent",
        "analytics_agent",
      ]),
    );
  });

  it("明确选择六岗位模式时，即使目标文字没写全链路也必须覆盖全部岗位", async () => {
    const product = await createTestProduct({ name: "全链路选择商品" });
    const result = await createBusinessPlan("准备新品上线", {
      provider: provider(),
      primaryProductId: product.id,
      channels: ["douyin"],
      fullChain: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.data.plan.tasks.map((task) => task.agent))).toEqual(
      new Set([
        "product_agent", "brand_agent", "content_agent",
        "customer_service_agent", "live_agent", "analytics_agent",
      ]),
    );
  });

  it("全链路未选内容渠道时直接拒绝，且不创建计划", async () => {
    const result = await createBusinessPlan("准备新品上线", {
      provider: provider(),
      fullChain: true,
      channels: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("内容渠道");
    expect(listStoredAgentWorkflows()).toHaveLength(0);
  });

  it("模型两次都漏掉岗位时拒绝全链路计划，不交给商家确认", async () => {
    const product = await createTestProduct({ name: "计划缺岗商品" });
    const base = provider();
    const incomplete = {
      ...base,
      generateText: async () => JSON.stringify({
        goal: "准备新品上线",
        summary: "先整理商品资料。",
        tasks: [{
          id: "task-1", agent: "product_agent", title: "分析商品",
          reason: "先确认商品的基础信息。", dependsOn: [],
          productId: product.id, platform: null, format: null,
        }],
        confidence: 0.5,
      }),
    };
    const result = await createBusinessPlan("准备新品上线", {
      provider: incomplete,
      primaryProductId: product.id,
      channels: ["douyin"],
      fullChain: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAN_INVALID");
      expect(result.error.message).toContain("六岗位计划未能覆盖全部岗位");
    }
    expect(listStoredAgentWorkflows()).toHaveLength(0);
  });

  it("目标为空 / 纯空白 / 超长 → VALIDATION_FAILED，不建工作流记录", async () => {
    const empty = await createBusinessPlan("   ", { provider: provider() });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe("VALIDATION_FAILED");
    }

    const tooLong = await createBusinessPlan("要".repeat(MAX_BUSINESS_GOAL_LENGTH + 1), {
      provider: provider(),
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.error.code).toBe("VALIDATION_FAILED");
    }

    expect(listStoredAgentWorkflows()).toHaveLength(0);
  });

  it("模型不可用 → 失败透传，且不创建工作流记录（没有计划可存）", async () => {
    const result = await createBusinessPlan("这周把鲍鱼内容做起来", {
      provider: createMockAIProvider({ scenario: "unavailable" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODEL_UNAVAILABLE");
    }
    expect(listStoredAgentWorkflows()).toHaveLength(0);
  });

  it("没有任何商品 → 明确拒绝，而不是让模型凭空编一件商品", async () => {
    // 快照 + 清空 + 结束后还原（mock 存储没有「恢复商品」的入口，只能手工搬运）
    const savedProducts: Product[] = listStoredProducts().map((product) => ({ ...product }));
    const savedDna: { productId: string; dna: ProductDNA | undefined }[] =
      savedProducts.map((product) => ({
        productId: product.id,
        dna: findStoredDna(product.id),
      }));

    try {
      for (const product of [...savedProducts]) {
        await repositories.products.delete(product.id);
      }
      expect(listStoredProducts()).toHaveLength(0);

      const result = await createBusinessPlan("这周把鲍鱼内容做起来", {
        provider: provider(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION_FAILED");
        expect(result.error.message).toContain("商品");
      }
    } finally {
      // 逆序 unshift 恢复原始顺序；DNA 逐条放回
      for (const product of [...savedProducts].reverse()) {
        putStoredProduct(product);
      }
      for (const { dna } of savedDna) {
        if (dna) {
          putStoredDna(dna);
        }
      }
      resetStoredContents();
    }
  });
});

describe("createBusinessPlan：两层纠错（Mock 故障注入）", () => {
  it("invalid-agent：白名单外 Agent 在契约层被拦 → Schema 层纠错修好", async () => {
    const result = await createBusinessPlan("这周把鲍鱼内容做起来", {
      provider: createMockAIProvider({ scenario: "invalid-agent" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // 第一次调用（live_agent 违反 enum）→ Schema 层回喂一次 → 第二次干净产出
    expect(result.data.attempts).toBe(2);
    expect(result.data.planRounds).toBe(1); // 语义层一次通过
    expect(result.data.repaired).toBe(true);
    // 修好的计划里不允许残留越界 Agent（live_agent 已是合法执行者）
    for (const task of result.data.plan.tasks) {
      expect(task.agent).not.toBe("unknown_agent");
    }
  });

  it("circular-dependency：循环依赖形状合法、Zod 看不见 → 语义层纠错修好", async () => {
    const result = await createBusinessPlan("这周把鲍鱼内容做起来", {
      provider: createMockAIProvider({ scenario: "circular-dependency" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // 第一次通过 Schema 但被 plan-validator 拒 → 违规清单回喂 → 第二次干净产出
    expect(result.data.attempts).toBe(2);
    expect(result.data.planRounds).toBe(2); // 语义层经历两轮
    expect(result.data.repaired).toBe(true);
    expect(result.data.warnings).toHaveLength(1);
    expect(result.data.warnings[0]).toContain("CIRCULAR_DEPENDENCY");
  });
});

/* ------------------------------------------------------------------ */
/* 2. 并发保护                                                          */
/* ------------------------------------------------------------------ */

describe("createBusinessPlan：重复启动保护", () => {
  it("已有运行中的工作流且目标相同 → RATE_LIMITED（同一个目标的文案）", async () => {
    await createTestProduct();
    await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "这周把鲍鱼内容做起来",
      status: "running",
    });

    const result = await createBusinessPlan("这周把鲍鱼内容做起来", {
      provider: provider(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMITED");
      expect(result.error.message).toContain("这个经营目标正在执行中");
    }
  });

  it("已有运行中的工作流但目标不同 → RATE_LIMITED（另一个计划的文案）", async () => {
    await createTestProduct();
    await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "上一个目标",
      status: "running",
    });

    const result = await createBusinessPlan("这周把鲍鱼内容做起来", {
      provider: provider(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMITED");
      expect(result.error.message).toContain("另一个经营计划");
    }
  });

  it("运行中的工作流已超过 10 分钟 → 视为孤儿，放行（进程中断后能恢复）", async () => {
    await createTestProduct();
    const running = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "上一个目标",
      status: "running",
    });
    // 把创建时间拨到过期阈值之前，模拟进程中断留下的孤儿
    const stored = findStoredAgentWorkflow(running.id);
    expect(stored).not.toBeNull();
    replaceStoredAgentWorkflow({
      ...stored!,
      createdAt: formatDateTime(
        new Date(Date.now() - WORKFLOW_RUNNING_STALE_MS - 60_000),
      ),
    });

    const result = await createBusinessPlan("这周把鲍鱼内容做起来", {
      provider: provider(),
    });
    expect(result.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 完整闭环（会改变演示商品的分析状态，依赖初始状态的用例已排在前面）  */
/* ------------------------------------------------------------------ */

describe("planAndRunBusinessGoal：规划 → 确认 → 执行完整闭环", () => {
  it("Mock Provider 全链路：六个服务真实产出、任务归属同一工作流", async () => {
    const product = await createTestProduct();
    // 品牌 / DNA / 内容槽位全部为空 → 计划里的每一步都要真的跑
    expect(findStoredBrandProfile()).toBeNull();
    expect(await repositories.productDna.getByProductId(product.id)).toBeNull();

    const result = await planAndRunBusinessGoal("这周把鲍鱼内容做起来", {
      provider: provider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // —— 整轮结果 ——
    expect(result.data.status).toBe("completed");
    expect(result.data.errorMessage).toBeNull();
    expect(result.data.retried).toBe(false);
    expect(result.data.summary.executed).toBe(result.data.summary.totalTasks);
    expect(result.data.summary.reused).toBe(0);
    expect(result.data.summary.failed).toBe(0);

    // —— 三个业务表的真实产出（不是只改了返回值）——
    expect(findStoredBrandProfile()).not.toBeNull();
    expect(await repositories.productDna.getByProductId(product.id)).not.toBeNull();
    for (const slot of [
      { platform: "douyin", format: "short-video" },
      { platform: "xiaohongshu", format: "article" },
    ] as const) {
      const content = await repositories.content.findBySlot({
        productId: product.id,
        ...slot,
      });
      expect(content).not.toBeNull();
    }

    // —— 任务归属：每个执行过的步骤都在 agent_tasks 里挂着 workflowId ——
    const workflowTasks = await repositories.agentTasks.listByWorkflow(
      result.data.workflowId,
    );
    expect(workflowTasks.length).toBe(result.data.summary.executed);
    expect(workflowTasks.length).toBeGreaterThan(0);
    for (const task of workflowTasks) {
      expect(task.workflowId).toBe(result.data.workflowId);
      expect(task.status).toBe("completed");
    }

    // —— 工作流记录收口 ——
    const stored = findStoredAgentWorkflow(result.data.workflowId);
    expect(stored?.status).toBe("completed");
    expect(stored?.summary).toMatchObject({
      totalTasks: result.data.summary.totalTasks,
      executed: result.data.summary.executed,
    });
    // 逐步报告必须落库：它是「哪几步没跑、为什么」的唯一记录
    expect(Array.isArray(stored?.summary?.steps)).toBe(true);

    // —— 状态视图 ——
    const state = await getWorkflowState(result.data.workflowId);
    expect(state.ok).toBe(true);
    if (!state.ok || !state.data) {
      return;
    }
    expect(state.data.workflow.status).toBe("completed");
    expect(state.data.canStart).toBe(false);
    expect(state.data.canRetry).toBe(false); // 全部成功：没有可重跑的东西
    expect(state.data.isRunning).toBe(false);
    expect(state.data.plan).not.toBeNull();
    for (const step of state.data.steps) {
      expect(step.outcome).toBe("executed");
    }
  }, 30_000);

  it("两步走（先规划后执行）与一步跑完结果一致", async () => {
    await createTestProduct({ name: "连江测试用新商品两步走" });

    const planned = await createBusinessPlan("这周把内容做起来", { provider: provider() });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }

    // 规划后：idle、可启动、步骤都是 pending
    const state = await getWorkflowState(planned.data.workflowId);
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data?.canStart).toBe(true);
    expect(state.data?.steps.every((step) => step.outcome === "pending")).toBe(true);

    const started = await startBusinessWorkflow(planned.data.workflowId, {
      provider: provider(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.data.status).toBe("completed");
    expect(started.data.retried).toBe(false);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* 4. 复用重试                                                          */
/* ------------------------------------------------------------------ */

describe("retryWorkflow：全复用重试", () => {
  it("上一轮全部成功（人为标为部分完成后）→ 重试一个 Agent 都不调，全记 reused", async () => {
    await createTestProduct({ name: "连江测试用新商品重试" });

    // 第一轮：全部成功
    const first = await planAndRunBusinessGoal("这周把内容做起来", { provider: provider() });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const workflowId = first.data.workflowId;
    const taskCountAfterFirst = (
      await repositories.agentTasks.listByWorkflow(workflowId)
    ).length;

    // 人为把它标成「部分完成」，打开重试入口
    // （真实场景里这里应是部分失败；全复用判定的结论与失败原因无关，只看现状）
    await repositories.agentWorkflows.markPartiallyCompleted(workflowId, {
      summary: { totalTasks: first.data.summary.totalTasks, executed: first.data.summary.executed, reused: 0, skipped: 0, failed: 0 },
      errorMessage: "测试构造：模拟部分失败",
    });

    // 第二轮：品牌、DNA、内容槽位全部已有 → 复用判定把每一步都标成 reused
    const retried = await retryWorkflow(workflowId, { provider: provider() });
    expect(retried.ok).toBe(true);
    if (!retried.ok) {
      return;
    }

    expect(retried.data.retried).toBe(true);
    expect(retried.data.status).toBe("completed");
    expect(retried.data.summary.executed).toBe(0); // 一个 Agent 都没被调用 —— 这层存在的意义
    expect(retried.data.summary.reused).toBe(retried.data.summary.totalTasks);
    expect(retried.data.summary.failed).toBe(0);

    // 没有产生新的 agent_tasks（复用的步骤不进入任何 Agent 服务）
    expect((await repositories.agentTasks.listByWorkflow(workflowId)).length).toBe(
      taskCountAfterFirst,
    );

    // 工作流重新收口为 completed
    const state = await getWorkflowState(workflowId);
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data?.workflow.status).toBe("completed");
    expect(state.data?.steps.every((step) => step.outcome === "reused")).toBe(true);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* 5. start / retry 的状态门槛                                          */
/* ------------------------------------------------------------------ */

describe("startBusinessWorkflow：状态门槛", () => {
  it("工作流不存在 → NOT_FOUND", async () => {
    const result = await startBusinessWorkflow("wf_not_exist");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("缺少 id → VALIDATION_FAILED", async () => {
    const result = await startBusinessWorkflow("  ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("正在运行（未过期）→ RATE_LIMITED", async () => {
    const running = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "目标",
      status: "running",
    });
    const result = await startBusinessWorkflow(running.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMITED");
      expect(result.error.message).toContain("正在执行中");
    }
  });

  it("正在运行但已过期 → 提示「看起来已经中断」", async () => {
    const running = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "目标",
      status: "running",
    });
    replaceStoredAgentWorkflow({
      ...running,
      createdAt: formatDateTime(new Date(Date.now() - WORKFLOW_RUNNING_STALE_MS - 60_000)),
    });

    const result = await startBusinessWorkflow(running.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMITED");
      expect(result.error.message).toContain("已经中断");
    }
  });

  it("已执行过（非 idle）→ VALIDATION_FAILED，指引走重试", async () => {
    const done = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "目标",
      status: "completed",
    });
    const result = await startBusinessWorkflow(done.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.message).toContain("已经执行过");
    }
  });

  it("计划内容读不回来（脏 jsonb / 旧版本）→ SCHEMA_INVALID", async () => {
    const broken = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "目标",
      status: "idle",
      plan: { broken: true }, // 结构断言进来的脏对象
    });
    const result = await startBusinessWorkflow(broken.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCHEMA_INVALID");
      expect(result.error.message).toContain("无法读取");
    }
  });

  it("规划与执行之间商品被删除 → PLAN_INVALID，拒绝启动而不是跑一半", async () => {
    const product = await createTestProduct({ name: "连江测试用将被删除商品" });

    const planned = await createBusinessPlan("这周把内容做起来", { provider: provider() });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    // 计划里确实引用了这件商品
    expect(
      planned.data.plan.tasks.some((task) => task.productId === product.id),
    ).toBe(true);

    await repositories.products.delete(product.id);
    const index = createdProductIds.indexOf(product.id);
    if (index >= 0) {
      createdProductIds.splice(index, 1);
    }

    const result = await startBusinessWorkflow(planned.data.workflowId, {
      provider: provider(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PLAN_INVALID");
      expect(result.error.message).toContain("不能执行");
    }
    // 工作流保持 idle：拒绝发生在启动之前，不该留下 running 的悬空记录
    expect(findStoredAgentWorkflow(planned.data.workflowId)?.status).toBe("idle");
  });
});

describe("retryWorkflow：状态门槛", () => {
  it("还没执行过（idle）→ VALIDATION_FAILED", async () => {
    const idle = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "目标",
      status: "idle",
    });
    const result = await retryWorkflow(idle.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.message).toContain("还没有执行过");
    }
  });

  it("全部完成 → 无需重试（想刷新请到对应页面手动触发）", async () => {
    const done = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "目标",
      status: "completed",
    });
    const result = await retryWorkflow(done.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.message).toContain("全部完成");
    }
  });

  it("工作流不存在 → NOT_FOUND", async () => {
    const result = await retryWorkflow("wf_not_exist");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. 状态查询                                                          */
/* ------------------------------------------------------------------ */

describe("getWorkflowState：查询", () => {
  it("库里一条工作流都没有 → ok(null)（正常的初始状态，不是错误）", async () => {
    const state = await getWorkflowState();
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data).toBeNull();
  });

  it("运行中（未过期）→ isRunning，既不能启动也不能重试", async () => {
    const running = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "目标",
      status: "running",
    });
    const state = await getWorkflowState(running.id);
    expect(state.ok && state.data).toBeTruthy();
    if (!state.ok || !state.data) {
      return;
    }
    expect(state.data.isRunning).toBe(true);
    expect(state.data.isStale).toBe(false);
    expect(state.data.canStart).toBe(false);
    expect(state.data.canRetry).toBe(false);
    expect(state.data.provider.providerId).toBe("mock");
  });

  it("运行中但已过期 → isStale，可以重试（不放行会让商家永久卡住）", async () => {
    const running = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "目标",
      status: "running",
    });
    replaceStoredAgentWorkflow({
      ...running,
      createdAt: formatDateTime(new Date(Date.now() - WORKFLOW_RUNNING_STALE_MS - 60_000)),
    });

    const state = await getWorkflowState(running.id);
    expect(state.ok && state.data).toBeTruthy();
    if (!state.ok || !state.data) {
      return;
    }
    expect(state.data.isRunning).toBe(false);
    expect(state.data.isStale).toBe(true);
    expect(state.data.canRetry).toBe(true);
  });

  it("不传 id 时取最近一轮（规划后即可查到）", async () => {
    await createTestProduct({ name: "连江测试用新商品查询" });
    const planned = await createBusinessPlan("这周把内容做起来", { provider: provider() });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }

    const state = await getWorkflowState();
    expect(state.ok && state.data).toBeTruthy();
    if (!state.ok || !state.data) {
      return;
    }
    expect(state.data.workflow.id).toBe(planned.data.workflowId);
    expect(state.data.canStart).toBe(true);
    // 计划是步骤的权威来源；摘要还没写库，全部 pending 而不是臆测
    expect(state.data.summary).toBeNull();
    expect(state.data.steps.every((step) => step.outcome === "pending")).toBe(true);
  });
});
