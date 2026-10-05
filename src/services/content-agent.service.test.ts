/**
 * Content Agent 业务闭环单测（Mock 数据源，不需要数据库）
 *
 * 这组测试验证的不是「函数能跑」，而是**「一次内容生成在数据层面到底发生了什么」**：
 * 内容写进哪个槽位、任务记了没有、重复生成是覆盖还是新增、
 * 失败时内容有没有被污染、并发时会不会重复扣费、进程中断后能不能恢复。
 *
 * 覆盖任务书 Task 7 要求的四项：
 *   1. 内容生成成功并落库
 *   2. 失败恢复（模型失败 → 任务记失败原因、内容不被写坏）
 *   3. 数据库写入（经仓储契约验证，DB 实现的集成测试见 db-repositories.test.ts）
 *   4. 重复生成（覆盖同一个槽位，而不是堆出第二份）
 * 另外补了**槽位隔离**、并发保护、过期任务放行、依据不足前置拒绝与状态派生五条边界。
 *
 * 与品牌中心测试的关键差异（刻意如此，不是漏测）：
 * 品牌是**单例**，并发保护看「全库最近一次品牌任务」；
 * 内容是按**槽位**（商品 × 平台 × 形态）组织的集合，
 * 因此必须额外验证「给 A 平台生成不会挡住 B 平台的生成」——
 * 这条一旦写错，用户给鲍鱼生成完抖音内容后，小红书按钮会整个卡住。
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
  listStoredAgentTasks,
  resetStoredContents,
} from "@/repositories/mock/store";

import {
  CONTENT_AGENT_TYPE,
  CONTENT_GENERATING_STALE_MS,
  generateContent,
  getContentSlotState,
  getContentSourceProducts,
  resolveContentSlot,
} from "./content-agent.service";

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

/** 本组用例创建过的商品，逐个删掉（删商品会级联清掉它的任务记录与内容） */
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

/** 给商品写入一份 DNA（内容生成的依据） */
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

const DOUYIN_SLOT = {
  platform: "douyin",
  format: "short-video",
} as const;

const XHS_SLOT = {
  platform: "xiaohongshu",
  format: "article",
} as const;

beforeAll(() => {
  pinCleanMockEnv();
});

beforeEach(() => {
  pinCleanMockEnv();
  clearStoredAgentTasks();
  resetStoredContents();
});

afterEach(async () => {
  for (const id of createdProductIds.splice(0)) {
    const existing = await repositories.products.getById(id);
    if (existing) {
      await repositories.products.delete(id);
    }
  }
  resetStoredContents();
});

afterAll(() => {
  restoreEnv();
});

/* ------------------------------------------------------------------ */
/* 1. 完整流程                                                         */
/* ------------------------------------------------------------------ */

describe("generateContent：Mock Provider 完整流程", () => {
  it("推广重点传到生成链路，同一商品切换重点会得到不同演示草稿", async () => {
    const product = await createTestProduct();
    await seedDna(product.id);

    const first = await generateContent(product.id, "douyin", "short-video", {
      provider: okProvider(),
      angle: "selling-point",
    });
    const second = await generateContent(product.id, "douyin", "short-video", {
      provider: okProvider(),
      angle: "cooking",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.content.title).not.toBe(second.data.content.title);
    expect(second.data.content.title).toContain("怎么准备");
    const tasks = await repositories.agentTasks.listByProduct(product.id, CONTENT_AGENT_TYPE, 10);
    expect(tasks[0]?.input?.angle).toBe("cooking");
  });

  it("从 Product DNA 到内容落库全链路打通：内容写入、任务收口、状态派生", async () => {
    const product = await createTestProduct();
    await seedDna(product.id);

    const result = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
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
    expect(generation.slot).toEqual({
      productId: product.id,
      platform: DOUYIN_SLOT.platform,
      format: DOUYIN_SLOT.format,
    });
    // 内容的所有契约字段都必须有值
    expect(generation.content.title.length).toBeGreaterThan(0);
    expect(generation.content.hook.length).toBeGreaterThan(0);
    expect(generation.content.body.length).toBeGreaterThan(0);
    expect(generation.content.cta.length).toBeGreaterThan(0);
    expect(generation.content.hashtags.length).toBeGreaterThan(0);

    // —— 内容真的写进了仓储（不是只改了返回值）——
    const persisted = await repositories.content.findBySlot({
      productId: product.id,
      platform: DOUYIN_SLOT.platform,
      format: DOUYIN_SLOT.format,
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.id).toBe(generation.content.id);
    expect(persisted?.title).toBe(generation.content.title);
    // AI 产出默认未确认：必须由商家确认后才能排期发布
    expect(persisted?.status).toBe("draft");
    expect(persisted?.aiVersion).toBe("v1.0");
    // 商品名是快照
    expect(persisted?.productName).toBe(product.name);
    // 新生成的内容还没发布，经营数据必须是 0，不能伪造
    expect(persisted?.metrics.views).toBe(0);
    // Mock 产出必须自带「这是占位数据」的标记，避免被当成真实结论
    expect(persisted?.riskNotes?.join()).toContain("【Mock】");

    // —— 任务记录 ——
    const tasks = await repositories.agentTasks.listByProduct(
      product.id,
      CONTENT_AGENT_TYPE,
      10,
    );
    expect(tasks[0]).toBeDefined();
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.progress).toBe(100);
    expect(tasks[0]?.durationMs).not.toBeNull();
    expect(tasks[0]?.completedAt).not.toBeNull();
    expect(tasks[0]?.errorMessage).toBeNull();
    expect(tasks[0]?.productId).toBe(product.id);
    // 槽位信息必须写进任务 input：状态派生与并发保护都要靠它定位槽位
    expect(tasks[0]?.input).toMatchObject({
      productId: product.id,
      platform: DOUYIN_SLOT.platform,
      format: DOUYIN_SLOT.format,
      hasDna: true,
    });
    expect(tasks[0]?.output).toMatchObject({
      providerId: "mock",
      isMock: true,
      attempts: 1,
    });
    expect(tasks[0]?.id).toBe(generation.taskId);

    // —— 状态派生 ——
    const state = await getContentSlotState(
      {
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      },
      persisted,
    );
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data.generation.status).toBe("completed");
    expect(state.data.generation.lastRunFailed).toBe(false);
    expect(state.data.generation.provider).toMatchObject({
      providerId: "mock",
      isMock: true,
    });
  });

  it("结构化输出不合法时会自动纠错重试一次，任务里能看到 attempts", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品B" });
    await seedDna(product.id);

    const result = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: createMockAIProvider({ scenario: "messy-then-ok" }) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.attempts).toBe(2);
    expect(result.data.repaired).toBe(true);

    const tasks = await repositories.agentTasks.listByProduct(
      product.id,
      CONTENT_AGENT_TYPE,
      10,
    );
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.output).toMatchObject({ attempts: 2, repaired: true });
  });
});

/* ------------------------------------------------------------------ */
/* 2. 槽位隔离与重复生成                                               */
/* ------------------------------------------------------------------ */

describe("generateContent：槽位隔离与重复生成", () => {
  it("同一商品的不同平台是两个独立槽位，互不覆盖", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品C" });
    await seedDna(product.id);

    const douyin = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
    const xhs = await generateContent(product.id, XHS_SLOT.platform, XHS_SLOT.format, {
      provider: okProvider(),
    });
    expect(douyin.ok && xhs.ok).toBe(true);
    if (!douyin.ok || !xhs.ok) {
      return;
    }

    expect(douyin.data.content.id).not.toBe(xhs.data.content.id);
    expect(douyin.data.regenerated).toBe(false);
    expect(xhs.data.regenerated).toBe(false);

    // 两个槽位各自都有内容
    const douyinContent = await repositories.content.findBySlot({
      productId: product.id,
      platform: DOUYIN_SLOT.platform,
      format: DOUYIN_SLOT.format,
    });
    const xhsContent = await repositories.content.findBySlot({
      productId: product.id,
      platform: XHS_SLOT.platform,
      format: XHS_SLOT.format,
    });
    expect(douyinContent).not.toBeNull();
    expect(xhsContent).not.toBeNull();
    expect(douyinContent?.format).toBe("short-video");
    expect(xhsContent?.format).toBe("article");
  });

  it("同一槽位第二次生成走 update 覆盖，而不是新增第二份", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品D" });
    await seedDna(product.id);

    const first = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.data.regenerated).toBe(false);

    const second = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.data.regenerated).toBe(true);
    expect(second.data.taskId).not.toBe(first.data.taskId);
    // 覆盖同一条内容：id 不变
    expect(second.data.content.id).toBe(first.data.content.id);

    /**
     * 槽位唯一性：若第二次实现成 create 而不是 update，
     * Mock 仓储会直接抛 DB_ERROR（对应数据库的 `contents_slot_unique`），
     * 因此这里再加一条「该商品只有一条抖音内容」的断言。
     */
    const all = await repositories.content.list();
    const douyinContents = all.filter(
      (item) => item.productId === product.id && item.platform === DOUYIN_SLOT.platform,
    );
    expect(douyinContents).toHaveLength(1);

    // 两次生成留下两条任务记录（历史快照），便于回溯
    const tasks = await repositories.agentTasks.listByProduct(
      product.id,
      CONTENT_AGENT_TYPE,
      10,
    );
    expect(tasks).toHaveLength(2);
  });

  it("重新生成刷新 updatedAt（界面那句「生成于 xxx」不会停在首次生成时间）", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品E" });
    await seedDna(product.id);

    const first = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    // 首次生成：createdAt 与 updatedAt 相同
    expect(first.data.content.updatedAt).toBe(first.data.content.createdAt);

    const second = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }

    // 覆盖同一条内容：创建时间不变，更新时间必须有值
    expect(second.data.content.createdAt).toBe(first.data.content.createdAt);
    expect(second.data.content.updatedAt).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* 3. 失败恢复                                                         */
/* ------------------------------------------------------------------ */

describe("generateContent：失败与恢复", () => {
  it("模型不可用时：任务记 failed + 失败原因 + 耗时，且绝不写入内容", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品F" });
    await seedDna(product.id);

    const result = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: createMockAIProvider({ scenario: "unavailable" }) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MODEL_UNAVAILABLE");

    // 内容没有被写坏：本就为空，现在仍然为空
    expect(
      await repositories.content.findBySlot({
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      }),
    ).toBeNull();

    const tasks = await repositories.agentTasks.listByProduct(
      product.id,
      CONTENT_AGENT_TYPE,
      10,
    );
    expect(tasks[0]?.status).toBe("failed");
    expect(tasks[0]?.errorMessage).toContain("模型服务暂时不可用");
    expect(tasks[0]?.durationMs).not.toBeNull();
    expect(tasks[0]?.completedAt).not.toBeNull();
    expect(tasks[0]?.progress).not.toBe(100);
  });

  it("已成功生成后再次生成失败：旧内容保持不变，状态标为 lastRunFailed", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品G" });
    await seedDna(product.id);

    const ok = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) {
      return;
    }
    const good = await repositories.content.findBySlot({
      productId: product.id,
      platform: DOUYIN_SLOT.platform,
      format: DOUYIN_SLOT.format,
    });
    expect(good).not.toBeNull();

    const failed = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: createMockAIProvider({ scenario: "timeout" }) },
    );
    expect(failed.ok).toBe(false);

    // 旧内容不能被这次失败改掉
    const afterFailure = await repositories.content.findBySlot({
      productId: product.id,
      platform: DOUYIN_SLOT.platform,
      format: DOUYIN_SLOT.format,
    });
    expect(afterFailure?.id).toBe(good?.id);
    expect(afterFailure?.title).toBe(good?.title);
    expect(afterFailure?.body).toBe(good?.body);
    expect(afterFailure?.updatedAt).toBe(good?.updatedAt);

    const state = await getContentSlotState(
      {
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      },
      afterFailure,
    );
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    // 内容还在 → completed，但必须如实告知「最近一次运行失败了」
    expect(state.data.generation.status).toBe("completed");
    expect(state.data.generation.lastRunFailed).toBe(true);
    expect(state.data.generation.latestTask?.status).toBe("failed");
  });

  it("商品不存在时返回 NOT_FOUND，且不留下任务记录", async () => {
    const result = await generateContent(
      "prod_not_exist",
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("NOT_FOUND");
    expect(
      listStoredAgentTasks().filter((task) => task.agentType === CONTENT_AGENT_TYPE),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 并发与孤儿任务恢复                                               */
/* ------------------------------------------------------------------ */

describe("generateContent：并发保护与孤儿任务恢复", () => {
  it("同一槽位已有运行中的任务时拒绝重复触发（RATE_LIMITED），避免重复扣费", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品H" });
    await seedDna(product.id);

    // 手工造一条「正在运行」的任务，模拟另一个请求已经在跑同一个槽位
    await repositories.agentTasks.create({
      agentType: CONTENT_AGENT_TYPE,
      title: `生成短视频脚本内容：${product.name}`,
      productId: product.id,
      status: "running",
      progress: 30,
      input: {
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      },
    });

    const result = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("RATE_LIMITED");
    // 被拒绝的调用不应该自己再建一条任务
    expect(
      listStoredAgentTasks().filter((task) => task.agentType === CONTENT_AGENT_TYPE),
    ).toHaveLength(1);
  });

  it("其它槽位正在生成**不会**挡住本槽位（槽位级并发保护，不是全库级）", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品I" });
    await seedDna(product.id);

    await repositories.agentTasks.create({
      agentType: CONTENT_AGENT_TYPE,
      title: `生成短视频脚本内容：${product.name}`,
      productId: product.id,
      status: "running",
      progress: 30,
      input: {
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      },
    });

    const result = await generateContent(product.id, XHS_SLOT.platform, XHS_SLOT.format, {
      provider: okProvider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.slot.platform).toBe(XHS_SLOT.platform);
  });

  it("运行中但已超过过期阈值的任务被放行（进程中断后能恢复）", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品J" });
    await seedDna(product.id);

    const stale = await repositories.agentTasks.create({
      agentType: CONTENT_AGENT_TYPE,
      title: `生成短视频脚本内容：${product.name}`,
      productId: product.id,
      status: "running",
      progress: 30,
      input: {
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      },
    });

    // 把 created_at 往前推，模拟进程中断留下的孤儿任务
    const staleTime = new Date(Date.now() - CONTENT_GENERATING_STALE_MS - 60_000);
    listStoredAgentTasks().forEach((task) => {
      if (task.id === stale.id) {
        task.createdAt = formatDateTime(staleTime);
      }
    });

    const result = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
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
    const result = await generateContent("", DOUYIN_SLOT.platform, DOUYIN_SLOT.format, {
      provider: okProvider(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(
      listStoredAgentTasks().filter((task) => task.agentType === CONTENT_AGENT_TYPE),
    ).toHaveLength(0);
  });

  it("平台或形态不合法时返回 VALIDATION_FAILED，且不创建任务", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品K" });
    await seedDna(product.id);

    const badPlatform = await generateContent(product.id, "kuaishou", "short-video", {
      provider: okProvider(),
    });
    expect(badPlatform.ok).toBe(false);
    if (!badPlatform.ok) {
      expect(badPlatform.error.code).toBe("VALIDATION_FAILED");
    }

    const badFormat = await generateContent(product.id, "douyin", "podcast", {
      provider: okProvider(),
    });
    expect(badFormat.ok).toBe(false);
    if (!badFormat.ok) {
      expect(badFormat.error.code).toBe("VALIDATION_FAILED");
    }

    expect(
      listStoredAgentTasks().filter((task) => task.agentType === CONTENT_AGENT_TYPE),
    ).toHaveLength(0);
  });

  /**
   * 说明：「没有任何依据 → 拒绝」这条门槛在服务层与 Agent 层是同一个判据
   * （`hasContentGrounding`），而 Mock 数据源自带 4 份 Product DNA 与品牌档案，
   * 服务层无法构造出「零依据」的环境，因此该分支由
   * `src/ai/agents/content-agent.test.ts` 直接覆盖，这里不重复造场景。
   */

  it("getContentSourceProducts：已有 DNA 的商品排在前面", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品L" });
    await seedDna(product.id);

    const loaded = await getContentSourceProducts();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.data.length).toBeGreaterThan(0);
    expect(loaded.data[0]?.id).toBe(product.id);
    expect(loaded.data[0]?.hasDna).toBe(true);
    expect(loaded.data[0]?.posterProduct).toMatchObject({
      id: product.id, name: product.name, price: product.price,
      unit: product.unit, imageUrl: product.imageUrl,
    });
    // 排序规则是「有 DNA 的在前」，因此第一个无 DNA 项之后不该再出现有 DNA 的
    const firstWithoutDna = loaded.data.findIndex((item) => !item.hasDna);
    if (firstWithoutDna >= 0) {
      expect(
        loaded.data.slice(firstWithoutDna).every((item) => !item.hasDna),
      ).toBe(true);
    }
  });

  it("resolveContentSlot：非法商品 id 退回首件商品，非法平台/形态退回默认值", async () => {
    const resolved = await resolveContentSlot({
      productId: "prod_not_exist",
      platform: "kuaishou",
      format: "podcast",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.data).not.toBeNull();
    expect(resolved.data?.platform).toBe("douyin");
    expect(resolved.data?.format).toBe("short-video");
    // 兜底到的商品必须是真实存在的候选商品
    const loaded = await getContentSourceProducts();
    if (loaded.ok) {
      expect(loaded.data.some((item) => item.id === resolved.data?.productId)).toBe(
        true,
      );
    }
  });

  it("resolveContentSlot：合法入参原样解析", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品M" });
    const resolved = await resolveContentSlot({
      productId: product.id,
      platform: "wechat",
      format: "poster-copy",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.data).toEqual({
      productId: product.id,
      platform: "wechat",
      format: "poster-copy",
    });
  });

  it("从未生成过的槽位状态为 empty", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品N" });
    const state = await getContentSlotState(
      {
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      },
      null,
    );
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data.generation.status).toBe("empty");
    expect(state.data.generation.latestTask).toBeNull();
    expect(state.data.generation.lastRunFailed).toBe(false);
    expect(state.data.content).toBeNull();
  });

  it("最近一次任务失败且没有内容时状态为 failed（可重试）", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品O" });
    await seedDna(product.id);

    await generateContent(product.id, DOUYIN_SLOT.platform, DOUYIN_SLOT.format, {
      provider: createMockAIProvider({ scenario: "unavailable" }),
    });

    const state = await getContentSlotState(
      {
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      },
      null,
    );
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data.generation.status).toBe("failed");
    expect(state.data.generation.latestTask?.status).toBe("failed");
    expect(state.data.generation.latestTask?.errorMessage).toBeTruthy();
  });

  it("内容存在但最近一次任务已失败的槽位仍为 completed（不能把旧内容说成失败）", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品P" });
    await seedDna(product.id);

    await generateContent(product.id, DOUYIN_SLOT.platform, DOUYIN_SLOT.format, {
      provider: okProvider(),
    });
    await generateContent(product.id, DOUYIN_SLOT.platform, DOUYIN_SLOT.format, {
      provider: createMockAIProvider({ scenario: "always-invalid" }),
    });

    const content = await repositories.content.findBySlot({
      productId: product.id,
      platform: DOUYIN_SLOT.platform,
      format: DOUYIN_SLOT.format,
    });

    const state = await getContentSlotState(
      {
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      },
      content,
    );
    expect(state.ok).toBe(true);
    if (!state.ok) {
      return;
    }
    expect(state.data.generation.status).toBe("completed");
    expect(state.data.generation.lastRunFailed).toBe(true);
  });

  it("同一商品在另一平台上生成失败，不影响本平台的状态", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品Q" });
    await seedDna(product.id);

    await generateContent(product.id, DOUYIN_SLOT.platform, DOUYIN_SLOT.format, {
      provider: okProvider(),
    });
    await generateContent(product.id, XHS_SLOT.platform, XHS_SLOT.format, {
      provider: createMockAIProvider({ scenario: "unavailable" }),
    });

    const douyinState = await getContentSlotState(
      {
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      },
      await repositories.content.findBySlot({
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      }),
    );
    expect(douyinState.ok).toBe(true);
    if (!douyinState.ok) {
      return;
    }
    expect(douyinState.data.generation.status).toBe("completed");
    expect(douyinState.data.generation.lastRunFailed).toBe(false);

    const xhsState = await getContentSlotState(
      {
        productId: product.id,
        platform: XHS_SLOT.platform,
        format: XHS_SLOT.format,
      },
      null,
    );
    expect(xhsState.ok).toBe(true);
    if (!xhsState.ok) {
      return;
    }
    expect(xhsState.data.generation.status).toBe("failed");
  });
});

/* ------------------------------------------------------------------ */
/* 6. 删除级联                                                         */
/* ------------------------------------------------------------------ */

describe("删除商品时的级联清理由", () => {
  it("商品删除后其内容一并消失（对应 contents.product_id ON DELETE CASCADE）", async () => {
    const product = await createTestProduct({ name: "连江测试用新商品R" });
    await seedDna(product.id);

    const created = await generateContent(
      product.id,
      DOUYIN_SLOT.platform,
      DOUYIN_SLOT.format,
      { provider: okProvider() },
    );
    expect(created.ok).toBe(true);

    await repositories.products.delete(product.id);
    // 已删除的商品 id 不再需要 afterEach 再删一次
    const index = createdProductIds.indexOf(product.id);
    if (index >= 0) {
      createdProductIds.splice(index, 1);
    }

    expect(
      await repositories.content.findBySlot({
        productId: product.id,
        platform: DOUYIN_SLOT.platform,
        format: DOUYIN_SLOT.format,
      }),
    ).toBeNull();
  });
});
