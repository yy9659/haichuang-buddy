/**
 * 经营工作流 Server Actions 单测（S4-2）
 *
 * 这一层只有三件事：**收参数 → 调服务 → 失效缓存**。测试因此围绕四条纪律：
 *
 *   1. **缓存失效的时机是对的**。规划成功要失效（驾驶舱要从「空闲」切到「待确认计划」），
 *      规划失败不该失效（库里什么都没变，白刷一遍页面）。
 *   2. **轮询不能失效缓存**。`getBusinessStateAction` 每 2~3 秒被调一次，
 *      若它也 revalidate，整页会跟着反复重渲染 —— 商家看到的是页面在抖。
 *   3. **错误的 `detail` 必须被剥掉**。编排层的 detail 里装着工作流 id、
 *      违规清单这类给开发者看的线索；进了浏览器就等于把内部结构暴露给
 *      任何能打开控制台的人。商家需要的是 `message`（一句中文处置建议）。
 *   4. **业务输入原样透传**：主推商品与勾选的渠道要真的走到服务层，
 *      在这里被"顺手丢掉"是最隐蔽的一类 bug —— 界面看起来一切正常，
 *      只是计划永远不聚焦商家选的那件商品。
 *
 * `next/cache` 用假实现替换：本层不测 Next 的缓存机制，只测"调没调、调了什么"。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import { resetServerEnvCache } from "@/lib/env";
import { getRepositories, type NewProductInput } from "@/repositories";
import {
  clearStoredAgentTasks,
  clearStoredAgentWorkflows,
  clearStoredBrandProfile,
  resetStoredContents,
} from "@/repositories/mock/store";

import {
  createBusinessPlanAction,
  getBusinessStateAction,
  retryBusinessWorkflowAction,
  startBusinessWorkflowAction,
} from "./business-workflow";

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

/** 固定为「Mock 数据源 + 未配置模型提供方」：动作层不注入 Provider，靠环境决定用 Mock */
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

/** 本次调用都失效了哪些路径 */
function revalidatedPaths(): string[] {
  return revalidatePathMock.mock.calls.map((call) => call[0] as string);
}

beforeAll(() => {
  pinCleanMockEnv();
});

beforeEach(() => {
  pinCleanMockEnv();
  revalidatePathMock.mockClear();
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

/* ------------------------------------------------------------------ */
/* 规划                                                                */
/* ------------------------------------------------------------------ */

describe("createBusinessPlanAction：只规划、不执行", () => {
  it("成功时返回计划与工作流 id，并失效六 Agent 涉及的全部页面", async () => {
    await createTestProduct();

    const result = await createBusinessPlanAction({
      goal: "这周把鲍鱼内容做起来",
      productId: null,
      targetAudience: null,
      channels: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.workflowId).toBeTruthy();
    expect(result.data.isMock).toBe(true);
    // 只规划：库里应当是一条 idle 记录，等商家确认才执行
    const stored = await repositories.agentWorkflows.findById(result.data.workflowId);
    expect(stored?.status).toBe("idle");

    // 一次经营会改动 agent_workflows / agent_tasks / product_dna / brand_profiles / contents，
    // 漏失效任意一处，商家就会看到「驾驶舱说完成了、内容工厂还是旧数据」
    expect(revalidatedPaths().sort()).toEqual([
      "/analytics",
      "/brand",
      "/content",
      "/customer-service",
      "/dashboard",
      "/live",
      "/products",
    ]);
  });

  it("失败时不失效缓存 —— 库里什么都没变，白刷一遍页面只会让界面抖一下", async () => {
    const result = await createBusinessPlanAction({
      goal: "   ",
      productId: null,
      targetAudience: null,
      channels: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("业务输入原样透传：主推商品与勾选渠道真的走到了服务层", async () => {
    const product = await createTestProduct({ name: "连江测试用主推鲍鱼" });

    const result = await createBusinessPlanAction({
      goal: "为今晚准备推广内容",
      productId: product.id,
      targetAudience: "注重食材新鲜度的年轻家庭",
      channels: ["douyin", "wechat"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.primaryProductId).toBe(product.id);
    expect(result.data.channels.map((channel) => channel.platform)).toEqual([
      "douyin",
      "wechat",
    ]);
    // 普通推广只生成商品、品牌与两份渠道素材，不制造模拟客服或直播记录
    expect(result.data.plan.tasks).toHaveLength(4);
    expect(result.data.reusePreview.reusableCount).toBe(0);
    expect(result.data.reusePreview.executableCount).toBe(4);
    expect(result.data.reusePreview.expectedContentCount).toBe(2);
    // 落库的目标是组装后的那句话（含主推商品），不是商家原话
    const stored = await repositories.agentWorkflows.findById(result.data.workflowId);
    expect(stored?.goal).toContain(`主推商品：连江测试用主推鲍鱼`);
    expect(stored?.goal).toContain("目标用户：注重食材新鲜度的年轻家庭");
  });

  it("未知渠道被丢掉而不是让整次规划失败", async () => {
    await createTestProduct();

    const result = await createBusinessPlanAction({
      goal: "推一把",
      productId: null,
      targetAudience: null,
      channels: ["douyin", "weibo"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.channels.map((channel) => channel.platform)).toEqual(["douyin"]);
  });
});

/* ------------------------------------------------------------------ */
/* 执行 / 重试                                                         */
/* ------------------------------------------------------------------ */

describe("startBusinessWorkflowAction：启动执行", () => {
  it("真实跑完整轮并失效页面 —— 失败也要失效（执行中途可能已经改过业务数据）", async () => {
    await createTestProduct();

    const planned = await createBusinessPlanAction({
      goal: "这周把鲍鱼内容做起来",
      productId: null,
      targetAudience: null,
      channels: [],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    revalidatePathMock.mockClear();

    const started = await startBusinessWorkflowAction(planned.data.workflowId);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.data.status).toBe("completed");
    expect(started.data.retried).toBe(false);
    expect(started.data.summary.executed).toBe(started.data.summary.totalTasks);
    expect(revalidatedPaths()).toContain("/dashboard");
  });

  it("已执行过的计划再启动 → VALIDATION_FAILED，且错误里没有 detail", async () => {
    const workflow = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "目标",
      status: "completed",
    });

    const result = await startBusinessWorkflowAction(workflow.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.message).toContain("已经执行过");
      // 服务层的 detail 里带着工作流 id，不该进浏览器
      expect("detail" in result.error).toBe(false);
      expect(JSON.stringify(result.error)).not.toContain(workflow.id);
    }
    // 启动是"可能已经改过东西"的操作，因此失败同样失效缓存
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("缺少 id → VALIDATION_FAILED（服务层的守卫没被绕过）", async () => {
    const result = await startBusinessWorkflowAction("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect("detail" in result.error).toBe(false);
    }
  });
});

describe("retryBusinessWorkflowAction：重试", () => {
  it("不存在的计划 → NOT_FOUND，错误里没有 detail", async () => {
    const result = await retryBusinessWorkflowAction("wf_not_exist");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect("detail" in result.error).toBe(false);
      expect(JSON.stringify(result.error)).not.toContain("wf_not_exist");
    }
  });

  it("还没执行过 → VALIDATION_FAILED，并指引先执行", async () => {
    const idle = await repositories.agentWorkflows.create({
      businessId: "biz_test",
      goal: "目标",
      status: "idle",
    });

    const result = await retryBusinessWorkflowAction(idle.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.message).toContain("还没有执行过");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 轮询                                                                */
/* ------------------------------------------------------------------ */

describe("getBusinessStateAction：轮询专用，绝不失效缓存", () => {
  it("读取状态不触发 revalidate（否则每 2.5 秒整页重渲染一次）", async () => {
    await createTestProduct();

    const planned = await createBusinessPlanAction({
      goal: "这周把鲍鱼内容做起来",
      productId: null,
      targetAudience: null,
      channels: [],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    revalidatePathMock.mockClear();

    for (let index = 0; index < 3; index += 1) {
      const state = await getBusinessStateAction(planned.data.workflowId);
      expect(state.ok).toBe(true);
      if (!state.ok || !state.data) {
        return;
      }
      expect(state.data.workflow.id).toBe(planned.data.workflowId);
      expect(state.data.canStart).toBe(true);
    }

    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("库里一条工作流都没有 → ok(null)，界面据此进入空态", async () => {
    const state = await getBusinessStateAction();
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data).toBeNull();
  });
});
