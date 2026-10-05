/**
 * Brand Agent 业务闭环单测（Mock 数据源，不需要数据库）
 *
 * 这组测试验证的不是「函数能跑」，而是**「一次品牌生成在数据层面到底发生了什么」**：
 * 任务记录建了没有、档案是 create 还是 update、重复生成会不会留下两份、
 * 失败时档案有没有被污染、并发时会不会重复扣费、进程中断后能不能恢复。
 *
 * 覆盖任务书 Task 7 要求的四项：
 *   1. 品牌档案成功落库
 *   2. 失败恢复（模型失败 → 任务记失败原因、档案不被写坏）
 *   3. 数据库写入（经仓储契约验证，DB 实现的集成测试见 db-repositories.test.ts）
 *   4. 重复生成（覆盖而不是新增）
 * 另外补了并发保护、过期任务放行、依据不足前置拒绝与状态派生四条边界。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import { formatDateTime } from "@/lib/datetime";
import { resetServerEnvCache } from "@/lib/env";
import {
  getRepositories,
  type NewProductDnaInput,
  type NewProductInput,
} from "@/repositories";
import {
  clearStoredAgentTasks,
  clearStoredBrandProfile,
  listStoredAgentTasks,
} from "@/repositories/mock/store";

import {
  BRAND_AGENT_TYPE,
  BRAND_GENERATING_STALE_MS,
  generateBrandProfile,
  getBrandGenerationState,
  getBrandSourceProduct,
} from "./brand-agent.service";

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

/** 固定为「Mock 数据源 + 未配置对象存储 + 未指定模型提供方」，让断言不受本机 .env.local 影响 */
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

/** 本组用例创建过的商品，逐个删掉（删商品会级联清掉它的任务记录） */
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

/** 给商品写入一份 DNA（品牌生成的依据） */
async function seedDna(productId: string): Promise<void> {
  const input: NewProductDnaInput = {
    productId,
    category: "海产品",
    subCategory: "鲍鱼",
    visualFeatures: ["鲜活带壳，壳面洁净"],
    coreFeatures: ["品类归属：海产品 · 鲍鱼"],
    sellingPoints: ["当日现捞、肉质弹牙"],
    targetUsers: ["注重食材新鲜度的家庭主厨"],
    consumptionScenarios: ["家庭日常三餐"],
    userPainPoints: ["担心到手不新鲜"],
    marketingAngles: ["产地溯源：从连江海域到餐桌"],
    riskNotes: [],
    aiVersion: "v1.0",
    confidence: 0.5,
    approved: false,
  };
  await repositories.productDna.create(input);
  await repositories.products.update(productId, { analysisStatus: "analyzed" });
}

/** 内存 Mock 的默认提供方：确定性、离线、产出带占位标记 */
function okProvider() {
  return createMockAIProvider();
}

beforeAll(() => {
  pinCleanMockEnv();
});

beforeEach(() => {
  pinCleanMockEnv();
  clearStoredAgentTasks();
  clearStoredBrandProfile();
});

afterEach(async () => {
  for (const id of createdProductIds.splice(0)) {
    const existing = await repositories.products.getById(id);
    if (existing) {
      await repositories.products.delete(id);
    }
  }
  clearStoredBrandProfile();
});

afterAll(() => {
  restoreEnv();
});

/* ------------------------------------------------------------------ */
/* 1. 完整流程                                                         */
/* ------------------------------------------------------------------ */

describe("generateBrandProfile：Mock Provider 完整流程", () => {
  it("从 Product DNA 到档案落库全链路打通：档案写入、任务收口、状态派生", async () => {
    const product = await createTestProduct();
    await seedDna(product.id);

    expect(await repositories.brand.getProfile()).toBeNull();

    const result = await generateBrandProfile(product.id, { provider: okProvider() });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const generation = result.data;

    // —— 返回值 ——
    expect(generation.providerId).toBe("mock");
    expect(generation.isMock).toBe(true);
    expect(generation.regenerated).toBe(false);
    expect(generation.attempts).toBe(1);
    expect(generation.repaired).toBe(false);
    expect(generation.durationMs).toBeGreaterThanOrEqual(0);
    expect(generation.durationText).not.toBe("");
    expect(generation.sourceProductId).toBe(product.id);
    expect(generation.analyzedProductCount).toBeGreaterThanOrEqual(1);
    // 品牌档案的所有契约字段都必须有值
    expect(generation.profile.positioning.length).toBeGreaterThan(0);
    expect(generation.profile.brandStory.length).toBeGreaterThan(0);
    expect(generation.profile.slogan.length).toBeGreaterThan(0);
    expect(generation.profile.brandValues.length).toBeGreaterThan(0);
    expect(generation.profile.visualKeywords.length).toBeGreaterThan(0);

    // —— 档案真的写进了仓储（不是只改了返回值）——
    const persisted = await repositories.brand.getProfile();
    expect(persisted).not.toBeNull();
    expect(persisted?.positioning).toBe(generation.profile.positioning);
    expect(persisted?.brandValues).toEqual(generation.profile.brandValues);
    // AI 产出默认未确认：必须由商家确认后才能对外使用
    expect(persisted?.approved).toBe(false);
    expect(persisted?.aiVersion).toBe("v1.0");
    // 完整度由仓储现算，应落在 0~1
    expect(persisted?.completeness).toBeGreaterThan(0);
    expect(persisted?.completeness).toBeLessThanOrEqual(1);
    // Mock 产出必须自带「这是占位数据」的标记，避免被当成真实品牌结论
    expect(persisted?.riskNotes.join()).toContain("【Mock】");

    // —— 任务记录 ——
    const task = await repositories.agentTasks.findLatestByType(BRAND_AGENT_TYPE);
    expect(task).not.toBeNull();
    expect(task?.status).toBe("completed");
    expect(task?.progress).toBe(100);
    expect(task?.durationMs).not.toBeNull();
    expect(task?.completedAt).not.toBeNull();
    expect(task?.errorMessage).toBeNull();
    expect(task?.title).toContain("连江海创海产商贸");
    expect(task?.productId).toBe(product.id);
    expect(task?.input).toMatchObject({
      sourceProductId: product.id,
      sourceProductName: product.name,
      hasOwnerTwin: true,
    });
    expect(task?.output).toMatchObject({
      providerId: "mock",
      isMock: true,
      attempts: 1,
    });
    expect(task?.id).toBe(generation.taskId);

    // —— 状态派生 ——
    const state = await getBrandGenerationState(persisted);
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data.status).toBe("completed");
    expect(state.data.lastRunFailed).toBe(false);
    expect(state.data.provider).toMatchObject({ providerId: "mock", isMock: true });
  });

  it("主依据商品尚无 DNA 时仍可生成，但必须如实告警依据覆盖不足", async () => {
    // 新建的商品没有 DNA；依据来自其它已完成分析的商品与 Owner Profile
    const product = await createTestProduct({ name: "连江测试用新商品A" });

    const result = await generateBrandProfile(product.id, { provider: okProvider() });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.sourceProductId).toBe(product.id);
    // 依据覆盖不完整：部分商品没有 DNA，必须在告警里说清楚
    expect(result.data.analyzedProductCount).toBeLessThan(result.data.sourceProductCount);
    expect(result.data.warnings.join()).toContain("其余商品的卖点未纳入本次品牌推导");
  });

  it("结构化输出不合法时会自动纠错重试一次，任务里能看到 attempts", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品B" });
    await seedDna(product.id);

    const result = await generateBrandProfile(product.id, {
      provider: createMockAIProvider({ scenario: "messy-then-ok" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.attempts).toBe(2);
    expect(result.data.repaired).toBe(true);

    const task = await repositories.agentTasks.findLatestByType(BRAND_AGENT_TYPE);
    expect(task?.status).toBe("completed");
    expect(task?.output).toMatchObject({ attempts: 2, repaired: true });
  });
});

/* ------------------------------------------------------------------ */
/* 2. 重复生成                                                         */
/* ------------------------------------------------------------------ */

describe("generateBrandProfile：重复生成", () => {
  it("人工确认后的品牌不能被静默覆盖，明确同意后才可重新生成", async () => {
    const product = await createTestProduct({ name: "连江测试用人工品牌商品" });
    await seedDna(product.id);
    const first = await generateBrandProfile(product.id, { provider: okProvider() });
    expect(first.ok).toBe(true);
    await repositories.brand.update({ approved: true });

    const blocked = await generateBrandProfile(product.id, { provider: okProvider() });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toContain("确认覆盖");
    expect((await repositories.brand.getProfile())?.approved).toBe(true);

    const replaced = await generateBrandProfile(product.id, { provider: okProvider(), replaceExisting: true });
    expect(replaced.ok).toBe(true);
    expect((await repositories.brand.getProfile())?.approved).toBe(false);
  });

  it("第二次生成走 update 覆盖同一份档案，而不是新增第二份", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品C" });
    await seedDna(product.id);

    const first = await generateBrandProfile(product.id, { provider: okProvider() });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.data.regenerated).toBe(false);

    const second = await generateBrandProfile(product.id, { provider: okProvider() });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.data.regenerated).toBe(true);
    expect(second.data.taskId).not.toBe(first.data.taskId);

    /**
     * Mock 仓储对「一个商家一份档案」的约束与数据库的唯一索引等价：
     * 若实现成 insert 而不是 update，create 会直接抛 DB_ERROR，
     * 因此这里再加一条「档案仍可读到且内容来自后一次」的断言。
     */
    const persisted = await repositories.brand.getProfile();
    expect(persisted).not.toBeNull();
    expect(persisted?.positioning).toBe(second.data.profile.positioning);

    // 两次生成留下两条任务记录（历史快照），便于回溯
    const tasks = listStoredAgentTasks().filter(
      (task) => task.agentType === BRAND_AGENT_TYPE,
    );
    expect(tasks).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 失败恢复                                                         */
/* ------------------------------------------------------------------ */

describe("generateBrandProfile：失败与恢复", () => {
  it("模型不可用时：任务记 failed + 失败原因 + 耗时，且绝不写入品牌档案", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品D" });
    await seedDna(product.id);

    const result = await generateBrandProfile(product.id, {
      provider: createMockAIProvider({ scenario: "unavailable" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MODEL_UNAVAILABLE");

    // 档案没有被写坏：本就为空，现在仍然为空
    expect(await repositories.brand.getProfile()).toBeNull();

    const task = await repositories.agentTasks.findLatestByType(BRAND_AGENT_TYPE);
    expect(task?.status).toBe("failed");
    expect(task?.errorMessage).toContain("模型服务暂时不可用");
    expect(task?.durationMs).not.toBeNull();
    expect(task?.completedAt).not.toBeNull();
    expect(task?.progress).not.toBe(100);
  });

  it("已成功生成后再次生成失败：旧档案保持不变，状态标为 lastRunFailed", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品E" });
    await seedDna(product.id);

    const ok = await generateBrandProfile(product.id, { provider: okProvider() });
    expect(ok.ok).toBe(true);
    if (!ok.ok) {
      return;
    }
    const goodProfile = await repositories.brand.getProfile();
    expect(goodProfile).not.toBeNull();

    const failed = await generateBrandProfile(product.id, {
      provider: createMockAIProvider({ scenario: "timeout" }),
    });
    expect(failed.ok).toBe(false);

    // 旧档案不能被这次失败改掉
    const afterFailure = await repositories.brand.getProfile();
    expect(afterFailure?.updatedAt).toBe(goodProfile?.updatedAt);
    expect(afterFailure?.positioning).toBe(goodProfile?.positioning);

    const state = await getBrandGenerationState(afterFailure);
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    // 档案还在 → completed，但必须如实告知「最近一次运行失败了」
    expect(state.data.status).toBe("completed");
    expect(state.data.lastRunFailed).toBe(true);
    expect(state.data.latestTask?.status).toBe("failed");
  });

  it("商品不存在时返回 NOT_FOUND，且不留下任务记录", async () => {
    const result = await generateBrandProfile("prod_not_exist", {
      provider: okProvider(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("NOT_FOUND");
    expect(
      listStoredAgentTasks().filter((task) => task.agentType === BRAND_AGENT_TYPE),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 并发与恢复                                                       */
/* ------------------------------------------------------------------ */

describe("generateBrandProfile：并发保护与孤儿任务恢复", () => {
  it("已有运行中的任务时拒绝重复触发（RATE_LIMITED），避免重复扣费", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品F" });
    await seedDna(product.id);

    // 手工造一条「正在运行」的任务，模拟另一个请求已经在跑
    await repositories.agentTasks.create({
      agentType: BRAND_AGENT_TYPE,
      title: "生成品牌策略：连江海创海产商贸",
      productId: product.id,
      status: "running",
      progress: 30,
    });

    const result = await generateBrandProfile(product.id, { provider: okProvider() });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("RATE_LIMITED");
    // 被拒绝的调用不应该自己再建一条任务
    expect(
      listStoredAgentTasks().filter((task) => task.agentType === BRAND_AGENT_TYPE),
    ).toHaveLength(1);
  });

  it("运行中但已超过过期阈值的任务被放行（进程中断后能恢复）", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品G" });
    await seedDna(product.id);

    const stale = await repositories.agentTasks.create({
      agentType: BRAND_AGENT_TYPE,
      title: "生成品牌策略：连江海创海产商贸",
      productId: product.id,
      status: "running",
      progress: 30,
    });

    // 把 created_at 往前推，模拟进程中断留下的孤儿任务
    const staleTime = new Date(
      Date.now() - BRAND_GENERATING_STALE_MS - 60_000,
    );
    await repositories.agentTasks.update(stale.id, {});
    listStoredAgentTasks().forEach((task) => {
      if (task.id === stale.id) {
        task.createdAt = formatDateTime(staleTime);
      }
    });

    const result = await generateBrandProfile(product.id, { provider: okProvider() });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.regenerated).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 依据前置检查与读取接口                                            */
/* ------------------------------------------------------------------ */

describe("依据前置检查与状态派生", () => {
  it("商品 ID 为空时返回 VALIDATION_FAILED，且不触达任何 IO", async () => {
    const result = await generateBrandProfile("", { provider: okProvider() });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(
      listStoredAgentTasks().filter((task) => task.agentType === BRAND_AGENT_TYPE),
    ).toHaveLength(0);
  });

  /**
   * 说明：「没有任何依据 → 拒绝」这条门槛在服务层与 Agent 层是同一个判据
   * （`hasBrandGrounding`），而 Mock 数据源自带 4 份 Product DNA 与 Owner Twin，
   * 服务层无法构造出「零依据」的环境，因此该分支由
   * `src/ai/agents/brand-agent.test.ts` 直接覆盖，这里不重复造场景。
   */

  it("getBrandSourceProduct 优先挑出确实存在 DNA 的商品", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品H" });
    await seedDna(product.id);

    const picked = await getBrandSourceProduct();
    expect(picked.ok).toBe(true);
    if (!picked.ok) {
      return;
    }
    expect(picked.data).not.toBeNull();
    expect(picked.data?.id).toBe(product.id);
    expect(picked.data?.hasDna).toBe(true);
  });

  it("尚未生成任何档案且没有任务时状态为 empty", async () => {
    const state = await getBrandGenerationState(null);
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data.status).toBe("empty");
    expect(state.data.latestTask).toBeNull();
    expect(state.data.lastRunFailed).toBe(false);
  });

  it("最近一次任务失败且没有档案时状态为 failed（可重试）", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品I" });
    await seedDna(product.id);

    await generateBrandProfile(product.id, {
      provider: createMockAIProvider({ scenario: "unavailable" }),
    });

    const state = await getBrandGenerationState(null);
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data.status).toBe("failed");
    expect(state.data.latestTask?.status).toBe("failed");
    expect(state.data.latestTask?.errorMessage).toBeTruthy();
  });
});
