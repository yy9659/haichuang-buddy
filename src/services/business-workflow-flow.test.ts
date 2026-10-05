/**
 * 集成级流程测试：从「填写经营目标」到「看到经营结果」（S4-2）
 *
 * 覆盖任务书 §32 要求的六个 Case。它们不是「服务层各测一遍」，
 * 而是**一条链路跑到底**，每一步都断言真实落库的东西：
 *
 *   ① 商品理解 + 品牌档案都已存在 → 复用资产并继续客服 / 直播 / 分析闭环
 *   ② 两者都缺 → 六 Agent 按依赖顺序完成整轮
 *   ③ 商品分析失败 → 下游「未执行」而不是「失败」（§16）
 *   ④ 两条内容一成功一失败 → `partially_completed`（§15）
 *   ⑤ 同一目标再来一次 → `RATE_LIMITED`（§18 的防重复点击）
 *   ⑥ 重试只跑失败的那一步，已成功的继续复用（§17）
 *
 * ---------- 为什么需要一个「脚本化 Provider」 ----------
 *
 * Mock Provider 的渠道驱动模式刻意**不省步骤**（让复用判定在零凭证 Demo 里
 * 真的被走到），因此它产出的计划里品牌任务**不依赖**商品分析任务 ——
 * 这在真实业务上是对的（品牌档案是全店的，不该硬绑在某一商品的结论上）。
 * 但 Case ③ 要验证的恰恰是「上游失败如何向下游传播」，需要一条
 * 品牌依赖商品的链路。于是在这些用例里由脚本**指定计划**，
 * 其余环节（校验器、复用判定、执行器、状态机、六个 Agent Service、仓储）
 * 全部走真实实现 —— 脚本只替换「模型说了什么」，不替换任何业务逻辑。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MOCK_OUTPUT_MARKER,
  createMockAIProvider,
  type MockAiScenario,
} from "@/ai/provider/mock";
import { BUSINESS_CONTEXT_BLOCK_START } from "@/ai/prompts/business-brain";
import { ANALYTICS_CONTEXT_BLOCK_START } from "@/ai/prompts/analytics-agent";
import { BRAND_CONTEXT_BLOCK_START } from "@/ai/prompts/brand-agent";
import { KNOWLEDGE_CONTEXT_BLOCK_START } from "@/ai/prompts/customer-service-agent";
import { LIVE_CONTEXT_BLOCK_START } from "@/ai/prompts/live-agent";
import { CONTEXT_BLOCK_START } from "@/ai/prompts/product-agent";
import {
  CONTENT_CONTEXT_BLOCK_START,
  parseContentContextBlock,
} from "@/ai/prompts/content-agent";
import type {
  AIProvider,
  GenerateObjectInput,
  GenerateTextInput,
} from "@/ai/provider/types";
import { AppError } from "@/lib/result";
import { resetServerEnvCache } from "@/lib/env";
import { getRepositories, type NewProductInput } from "@/repositories";
import {
  clearStoredAgentTasks,
  clearStoredAgentWorkflows,
  clearStoredBrandProfile,
  findStoredBrandProfile,
  resetStoredContents,
} from "@/repositories/mock/store";
import { buildLiveSteps } from "@/lib/workflow-display";
import type { ContentFormat, ContentPlatform } from "@/types";

import { generateBrandProfile } from "./brand-agent.service";
import {
  createBusinessPlan,
  getWorkflowState,
  retryWorkflow,
  startBusinessWorkflow,
} from "./business-brain.service";
import { analyzeProduct } from "./product-agent.service";

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

/* ------------------------------------------------------------------ */
/* 脚本化 Provider                                                     */
/* ------------------------------------------------------------------ */

interface PlanTaskFixture {
  id: string;
  agent: "product_agent" | "brand_agent" | "content_agent";
  title: string;
  reason: string;
  dependsOn?: readonly string[];
  productId?: string | null;
  platform?: ContentPlatform | null;
  format?: ContentFormat | null;
}

interface ScriptedProviderOptions {
  scenario?: MockAiScenario;
  /** 让哪些「目标」失败：`product` / `brand` / `brain` / `content:douyin` */
  failTargets?: readonly string[];
  /** 覆盖 Business Brain 的计划（只替换「模型说了什么」） */
  planTasks?: readonly PlanTaskFixture[];
  /** 记录结构化调用顺序，用于断言调度顺序 */
  order?: string[];
}

/** 把提示词归类到「哪个 Agent / 哪个槽位」——确定性，不猜 */
function classifyPrompt(prompt: string): string {
  if (prompt.includes(BUSINESS_CONTEXT_BLOCK_START)) {
    return "brain";
  }
  if (prompt.includes(CONTENT_CONTEXT_BLOCK_START)) {
    // 用内容提示词自己的解析器读槽位，而不是在测试里复述它的格式
    const context = parseContentContextBlock(prompt);
    return `content:${context?.request.platform ?? "unknown"}`;
  }
  if (prompt.includes(BRAND_CONTEXT_BLOCK_START)) {
    return "brand";
  }
  if (prompt.includes(CONTEXT_BLOCK_START)) {
    return "product";
  }
  if (prompt.includes(KNOWLEDGE_CONTEXT_BLOCK_START)) {
    return "customer-service";
  }
  if (prompt.includes(LIVE_CONTEXT_BLOCK_START)) {
    return "live";
  }
  if (prompt.includes(ANALYTICS_CONTEXT_BLOCK_START)) {
    return "analytics";
  }
  return "other";
}

function buildScriptedPlan(tasks: readonly PlanTaskFixture[]): string {
  return JSON.stringify(
    {
      goal: "为今晚准备推广内容",
      summary: "按依赖顺序：先补商品理解与品牌档案，再产出各渠道内容。",
      tasks: tasks.map((task) => ({
        id: task.id,
        agent: task.agent,
        title: task.title,
        reason: task.reason,
        dependsOn: [...(task.dependsOn ?? [])],
        productId: task.productId ?? null,
        platform: task.platform ?? null,
        format: task.format ?? null,
      })),
      confidence: 0.5,
    },
    null,
    2,
  );
}

function createScriptedProvider(options: ScriptedProviderOptions = {}): AIProvider {
  const base = createMockAIProvider(
    options.scenario ? { scenario: options.scenario } : {},
  );
  const failTargets = new Set(options.failTargets ?? []);
  const order = options.order;

  function beforeCall(prompt: string): string | null {
    const target = classifyPrompt(prompt);
    order?.push(target);
    if (failTargets.has(target)) {
      throw new AppError({
        code: "MODEL_UNAVAILABLE",
        message: "模型服务暂时不可用",
        detail: `测试注入的故障：${target}`,
      });
    }
    if (target === "brain" && options.planTasks) {
      return buildScriptedPlan(options.planTasks);
    }
    return null;
  }

  return {
    id: "scripted-mock",

    async generateText(input: GenerateTextInput): Promise<string> {
      const scripted = beforeCall(input.prompt);
      return scripted ?? base.generateText(input);
    },

    // 六个 Agent 都经 `generateValidatedObject` → `generateText`，
    // 因此这里只需委托；保留实现是为了让假 Provider 满足完整接口。
    generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
      return base.generateObject(input);
    },
    streamText: (input) => base.streamText(input),
    analyzeImage: (input) => base.analyzeImage(input),
    embed: (input) => base.embed(input),
  };
}

/** 一份「品牌依赖商品分析」的计划（Case ③ 用） */
function dependentPlan(productId: string): PlanTaskFixture[] {
  return [
    {
      id: "task-1",
      agent: "product_agent",
      title: `分析「连江测试用鲜活鲍鱼」`,
      reason: "该商品尚无商品理解。",
      productId,
    },
    {
      id: "task-2",
      agent: "brand_agent",
      title: "生成品牌档案",
      reason: "品牌档案决定内容语气。",
      dependsOn: ["task-1"],
      productId,
    },
    {
      id: "task-3",
      agent: "content_agent",
      title: "生成抖音短视频脚本",
      reason: "抖音是本次选定渠道。",
      dependsOn: ["task-1", "task-2"],
      productId,
      platform: "douyin",
      format: "short-video",
    },
    {
      id: "task-4",
      agent: "content_agent",
      title: "生成朋友圈海报文案",
      reason: "朋友圈是本次选定渠道。",
      dependsOn: ["task-1", "task-2"],
      productId,
      platform: "wechat",
      format: "poster-copy",
    },
  ];
}

/** 把工作流的逐步报告 + 执行流水合成界面视图（与对话框用的是同一个函数） */
function displayStatuses(state: Awaited<ReturnType<typeof getWorkflowState>>) {
  if (!state.ok || !state.data) {
    throw new Error("测试前置失败：读不到工作流状态");
  }
  return buildLiveSteps({
    planTasks: state.data.plan?.tasks ?? [],
    summary: state.data.summary,
    liveTasks: state.data.agentTasks,
    includeUnplanned: true,
  });
}

beforeAll(() => {
  pinCleanMockEnv();
});

beforeEach(() => {
  pinCleanMockEnv();
  clearStoredAgentTasks();
  clearStoredAgentWorkflows();
  resetStoredContents();
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
  clearStoredAgentTasks();
});

afterAll(() => {
  restoreEnv();
});

/* ================================================================== */
/* Case ① 商品理解 + 品牌档案都已存在 → 只执行内容                      */
/* ================================================================== */

describe("Case ①：资产齐备时只执行内容，其余复用", () => {
  it("复用 2 步、执行 2 步，且已存在的资产没有再次调用模型", async () => {
    const product = await createTestProduct();

    // —— 先把商品理解与品牌档案准备好（走真实服务） ——
    const analyzed = await analyzeProduct(product.id, {
      provider: createMockAIProvider(),
    });
    expect(analyzed.ok).toBe(true);
    const branded = await generateBrandProfile(product.id, {
      provider: createMockAIProvider(),
    });
    expect(branded.ok).toBe(true);
    expect(findStoredBrandProfile()).not.toBeNull();

    // —— 规划：复用预判应当立刻告诉商家「有 2 步是白拿的」 ——
    const planned = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider(),
      channels: ["douyin", "wechat"],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    expect(planned.data.plan.tasks).toHaveLength(7);
    expect(planned.data.reusePreview.reusableCount).toBe(2);
    expect(planned.data.reusePreview.executableCount).toBe(5);
    expect(planned.data.reusePreview.expectedContentCount).toBe(2);
    expect(planned.data.reusePreview.estimatedModelCalls).toBe(5);

    // —— 执行：资产复用，内容、客服、直播、分析继续真实调用 ——
    const order: string[] = [];
    const started = await startBusinessWorkflow(planned.data.workflowId, {
      provider: createScriptedProvider({ order }),
      maxConcurrency: 1,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    expect(started.data.status).toBe("completed");
    expect(started.data.summary).toMatchObject({
      totalTasks: 7,
      executed: 5,
      reused: 2,
      skipped: 0,
      failed: 0,
    });
    expect(order).toEqual([
      "content:douyin",
      "content:wechat",
      "customer-service",
      "live",
      "analytics",
    ]);

    // 复用步骤不产生任务记录；其余五步各有真实 agent_tasks 流水
    const workflowTasks = await repositories.agentTasks.listByWorkflow(
      planned.data.workflowId,
    );
    expect(workflowTasks).toHaveLength(5);

    // —— 界面层：复用必须显示成「已复用」，不能显示成「已完成」——
    const steps = displayStatuses(await getWorkflowState(planned.data.workflowId));
    expect(steps.map((step) => step.displayStatus)).toEqual([
      "reused",
      "reused",
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
    ]);
    expect(steps[0]?.note).toContain("不再重复分析");
    // 复用说明是编排层写的（不是模型产出），因此不可能带 Mock 占位标记
    expect(steps[0]?.note).not.toContain(MOCK_OUTPUT_MARKER);
  }, 30_000);
});

/* ================================================================== */
/* Case ② 两者都缺 → 按依赖顺序补齐                                      */
/* ================================================================== */

describe("Case ②：资产缺失时按依赖顺序执行", () => {
  it("商品 → 品牌 → 内容 → 客服 → 直播 → 分析，七步全部真实执行", async () => {
    const product = await createTestProduct();
    expect(findStoredBrandProfile()).toBeNull();
    expect(await repositories.productDna.getByProductId(product.id)).toBeNull();

    const planned = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider(),
      channels: ["douyin", "wechat"],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    expect(planned.data.reusePreview.reusableCount).toBe(0);

    const order: string[] = [];
    const started = await startBusinessWorkflow(planned.data.workflowId, {
      provider: createScriptedProvider({ order }),
      maxConcurrency: 1,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    // 并发压到 1 之后启动顺序 = 计划顺序（计划顺序就是展示顺序）
    expect(order).toEqual([
      "product",
      "brand",
      "content:douyin",
      "content:wechat",
      "customer-service",
      "live",
      "analytics",
    ]);
    expect(started.data.summary).toMatchObject({
      totalTasks: 7,
      executed: 7,
      reused: 0,
      failed: 0,
    });

    // 真实产出：商品理解、品牌档案、两条内容都落库了
    expect(await repositories.productDna.getByProductId(product.id)).not.toBeNull();
    expect(findStoredBrandProfile()).not.toBeNull();
    for (const slot of [
      { platform: "douyin", format: "short-video" },
      { platform: "wechat", format: "poster-copy" },
    ] as const) {
      expect(
        await repositories.content.findBySlot({ productId: product.id, ...slot }),
      ).not.toBeNull();
    }

    const steps = displayStatuses(await getWorkflowState(planned.data.workflowId));
    expect(steps.map((step) => step.displayStatus)).toEqual([
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
    ]);
  }, 30_000);
});

/* ================================================================== */
/* Case ③ 商品分析失败 → 下游是「未执行」，不是「失败」（§16）           */
/* ================================================================== */

describe("Case ③：上游失败向下游传播", () => {
  it("品牌与内容显示「未执行」并说明被谁挡住，绝不冤枉成「执行失败」", async () => {
    const product = await createTestProduct();

    // 用脚本指定一条「品牌依赖商品分析」的链路
    const planned = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider({ planTasks: dependentPlan(product.id) }),
      channels: ["douyin", "wechat"],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }

    const started = await startBusinessWorkflow(planned.data.workflowId, {
      provider: createScriptedProvider({
        failTargets: ["product"],
        planTasks: dependentPlan(product.id),
      }),
      maxConcurrency: 1,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    // 一个都没成 → 整轮 failed（不是 partially_completed）
    expect(started.data.status).toBe("failed");
    expect(started.data.summary).toMatchObject({
      totalTasks: 4,
      executed: 0,
      reused: 0,
      failed: 1,
      skipped: 3,
    });

    const state = await getWorkflowState(planned.data.workflowId);
    expect(state.ok).toBe(true);
    if (!state.ok || !state.data) {
      return;
    }

    // 逐步报告：第 1 步 failed，第 2/3/4 步 skipped 并带上 blockedBy
    const report = state.data.summary?.steps ?? [];
    expect(report[0]).toMatchObject({ taskId: "task-1", outcome: "failed" });
    expect(report[1]).toMatchObject({ taskId: "task-2", outcome: "skipped" });
    expect(report[1]?.blockedBy).toEqual(["task-1"]);

    // 界面层：第 2 步必须显示「未执行」，且说清是被第 1 步挡住的
    const steps = displayStatuses(state);
    expect(steps.map((step) => step.displayStatus)).toEqual([
      "failed",
      "not_run",
      "not_run",
      "not_run",
    ]);
    expect(steps[1]?.displayStatus).not.toBe("failed");
    expect(steps[1]?.blockedByTitles).toEqual(["分析「连江测试用鲜活鲍鱼」"]);
    expect(steps[1]?.note).toContain("依赖");
    // 失败原因必须落在第 1 步上，而不是被抹掉
    expect(steps[0]?.note).toContain("模型服务暂时不可用");

    // 品牌与内容根本没有进入任何 Agent 服务 → 只有 1 条任务记录
    const workflowTasks = await repositories.agentTasks.listByWorkflow(
      planned.data.workflowId,
    );
    expect(workflowTasks).toHaveLength(1);
    expect(workflowTasks[0]?.agentType).toBe("product_agent");
    expect(workflowTasks[0]?.status).toBe("failed");
  }, 30_000);
});

/* ================================================================== */
/* Case ④ 两条内容一成功一失败 → partially_completed（§15）             */
/* ================================================================== */

describe("Case ④：部分完成", () => {
  it("状态是「部分完成」，并准确区分失败与被阻塞步骤", async () => {
    const product = await createTestProduct();

    // 商品理解与品牌档案先备好 → 这两步复用，把失败面收窄到内容
    await analyzeProduct(product.id, { provider: createMockAIProvider() });
    await generateBrandProfile(product.id, { provider: createMockAIProvider() });

    const planned = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider(),
      channels: ["douyin", "wechat"],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }

    const started = await startBusinessWorkflow(planned.data.workflowId, {
      provider: createScriptedProvider({ failTargets: ["content:wechat"] }),
      maxConcurrency: 1,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    // 有成功也有失败 —— 编排层跑起来之后这是最常见的收尾状态
    expect(started.data.status).toBe("partially_completed");
    expect(started.data.summary).toMatchObject({
      totalTasks: 7,
      executed: 2,
      reused: 2,
      failed: 1,
      skipped: 2,
    });
    // 工作流级说明要如实说清「几个失败、几个成功」，而不是只丢一句「失败」
    expect(started.data.errorMessage).toContain("1 个任务失败");
    expect(started.data.errorMessage).toContain("成功 4 个");

    const state = await getWorkflowState(planned.data.workflowId);
    const steps = displayStatuses(state);
    expect(steps.map((step) => step.displayStatus)).toEqual([
      "reused",
      "reused",
      "executed",
      "failed",
      "executed",
      "not_run",
      "not_run",
    ]);

    // 失败的槽位在界面上是可定位的：结果卡片要靠它深链到内容工厂
    const failedStep = steps.find((step) => step.displayStatus === "failed");
    expect(failedStep?.platform).toBe("wechat");
    expect(failedStep?.format).toBe("poster-copy");

    if (!state.ok || !state.data) {
      return;
    }
    expect(state.data.canRetry).toBe(true);
    expect(state.data.canStart).toBe(false);
  }, 30_000);
});

/* ================================================================== */
/* Case ⑤ 同一目标再来一次 → RATE_LIMITED（§18）                        */
/* ================================================================== */

describe("Case ⑤：防重复点击", () => {
  it("已有运行中的同一目标 → RATE_LIMITED，且文案点明「这个目标正在执行」", async () => {
    const product = await createTestProduct();

    const first = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider(),
      channels: ["douyin", "wechat"],
      primaryProductId: product.id,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    // 模拟「第一轮还在跑」：这一轮的执行请求此刻正阻塞在服务端
    await repositories.agentWorkflows.markRunning(first.data.workflowId);

    // 商家忍不住又点了一次「AI 制定计划」（同样的商品、同样的渠道）
    const second = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider(),
      channels: ["douyin", "wechat"],
      primaryProductId: product.id,
    });

    expect(second.ok).toBe(false);
    if (second.ok) {
      return;
    }
    expect(second.error.code).toBe("RATE_LIMITED");
    // 组装后的目标完全一致，因此能给出最贴切的那句提示
    expect(second.error.message).toContain("这个经营目标正在执行中");

    // 库里没有多出第二条工作流
    expect(await repositories.agentWorkflows.listRecent()).toHaveLength(1);
  }, 30_000);

  it("换了商品/渠道后被挡住时，文案改成「另一个计划在执行」", async () => {
    const product = await createTestProduct();

    const first = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider(),
      channels: ["douyin"],
      primaryProductId: product.id,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    await repositories.agentWorkflows.markRunning(first.data.workflowId);

    const second = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider(),
      channels: ["douyin", "wechat"],
      primaryProductId: product.id,
    });

    expect(second.ok).toBe(false);
    if (second.ok) {
      return;
    }
    expect(second.error.code).toBe("RATE_LIMITED");
    expect(second.error.message).toContain("另一个经营计划");
  }, 30_000);
});

/* ================================================================== */
/* Case ⑥ 重试只跑失败任务（§17）                                       */
/* ================================================================== */

describe("Case ⑥：重试只跑没成的那一步", () => {
  it("已成功的步骤继续复用，只有失败的那个槽位再次调用模型", async () => {
    const product = await createTestProduct();

    await analyzeProduct(product.id, { provider: createMockAIProvider() });
    await generateBrandProfile(product.id, { provider: createMockAIProvider() });

    const planned = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider(),
      channels: ["douyin", "wechat"],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    const workflowId = planned.data.workflowId;

    // —— 第一轮：朋友圈内容失败 ——
    const first = await startBusinessWorkflow(workflowId, {
      provider: createScriptedProvider({ failTargets: ["content:wechat"] }),
      maxConcurrency: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.data.status).toBe("partially_completed");
    const tasksAfterFirst = await repositories.agentTasks.listByWorkflow(workflowId);

    // —— 第二轮：模型恢复正常，重试整轮 ——
    const retryOrder: string[] = [];
    const retried = await retryWorkflow(workflowId, {
      provider: createScriptedProvider({ order: retryOrder }),
      maxConcurrency: 1,
    });
    expect(retried.ok).toBe(true);
    if (!retried.ok) {
      return;
    }

    // 「只跑失败任务」不是靠挑任务实现的，而是复用判定自动跳过已成功的 ——
    // 因此这里断言的是**模型调用序列**，而不是某个 if 分支
    expect(retryOrder).toEqual(["content:wechat", "live", "analytics"]);
    expect(retried.data.retried).toBe(true);
    expect(retried.data.status).toBe("completed");
    expect(retried.data.summary).toMatchObject({
      totalTasks: 7,
      executed: 3,
      reused: 4,
      skipped: 0,
      failed: 0,
    });

    // 已完成的四步不产生新任务；失败内容与上轮被阻塞的直播、分析共新增三条。
    // （上一轮失败的那条记录是真实历史，不会被删掉 —— 否则商家就查不到
    //   「第一次为什么没成」了。）
    const tasksAfterRetry = await repositories.agentTasks.listByWorkflow(workflowId);
    expect(tasksAfterRetry).toHaveLength(tasksAfterFirst.length + 3);
    const newTasks = tasksAfterRetry.filter(
      (task) => !tasksAfterFirst.some((before) => before.id === task.id),
    );
    expect(newTasks).toHaveLength(3);
    expect(new Set(newTasks.map((task) => task.agentType))).toEqual(
      new Set(["content_agent", "live_agent", "analytics_agent"]),
    );
    expect(
      newTasks.find((task) => task.agentType === "content_agent")?.input?.platform,
    ).toBe("wechat");

    // 界面：失败及被阻塞步骤重跑，其余四步复用
    const steps = displayStatuses(await getWorkflowState(workflowId));
    expect(steps.map((step) => step.displayStatus)).toEqual([
      "reused",
      "reused",
      "reused",
      "executed",
      "reused",
      "executed",
      "executed",
    ]);
  }, 30_000);

  it("全部成功的一轮没有可重跑的东西，明确拒绝而不是白跑一遍", async () => {
    await createTestProduct();

    const planned = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider(),
      channels: ["douyin"],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }

    const started = await startBusinessWorkflow(planned.data.workflowId, {
      provider: createScriptedProvider(),
      maxConcurrency: 1,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.data.status).toBe("completed");

    const retried = await retryWorkflow(planned.data.workflowId, {
      provider: createScriptedProvider(),
    });
    expect(retried.ok).toBe(false);
    if (retried.ok) {
      return;
    }
    expect(retried.error.code).toBe("VALIDATION_FAILED");
    expect(retried.error.message).toContain("全部完成");
  }, 30_000);
});

/* ================================================================== */
/* Case ⑦ 品牌任务不绑商品 → 兜底锚点（真实模型踩过的坑）                */
/* ================================================================== */

describe("Case ⑦：brand_agent 的 productId 为 null 时走兜底锚点", () => {
  /**
   * 真实模型的计划出现过：brand 任务按提示词把 productId 给了 null
   * （提示词与校验器都允许），而 Brand Service 需要一件主依据商品，
   * 结果 5ms 撞上「商品 ID 不合法」，下游内容被连坐。
   * 回归锁：执行器必须退回「计划里第一个目标商品」作锚点，整轮照常跑通。
   */
  it("品牌步骤兜底锚定计划里的商品，整轮完成且档案落库", async () => {
    const product = await createTestProduct();
    expect(findStoredBrandProfile()).toBeNull();

    const planTasks: PlanTaskFixture[] = [
      {
        id: "task-1",
        agent: "product_agent",
        title: `分析「连江测试用鲜活鲍鱼」`,
        reason: "该商品尚无商品理解。",
        productId: product.id,
      },
      {
        id: "task-2",
        agent: "brand_agent",
        title: "生成品牌档案",
        reason: "品牌档案决定内容语气。",
        dependsOn: ["task-1"],
        productId: null, // ← 关键：与真实模型的产出一致
      },
      {
        id: "task-3",
        agent: "content_agent",
        title: "生成朋友圈海报文案",
        reason: "适配朋友圈渠道。",
        dependsOn: ["task-2"],
        productId: product.id,
        platform: "wechat",
        format: "poster-copy",
      },
    ];

    const planned = await createBusinessPlan("为今晚准备全链路推广闭环", {
      provider: createScriptedProvider({ planTasks }),
      channels: ["wechat"],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }

    const started = await startBusinessWorkflow(planned.data.workflowId, {
      provider: createScriptedProvider({ planTasks }),
      maxConcurrency: 1,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    expect(started.data.status).toBe("completed");
    expect(started.data.summary).toMatchObject({
      totalTasks: 3,
      executed: 3,
      reused: 0,
      failed: 0,
    });

    // 品牌档案真实落库 —— 兜底锚点确实生效，而不是静默跳过
    expect(await repositories.productDna.getByProductId(product.id)).not.toBeNull();
    expect(findStoredBrandProfile()).not.toBeNull();
  }, 30_000);
});
