/**
 * Product Agent 业务闭环单测（Mock 数据源，不需要数据库）
 *
 * 这是 S2-2 最重要的一组测试：它验证的不是「函数能跑」，而是
 * **「一次 AI 分析在数据层面到底发生了什么」** ——
 * 任务记录建了没有、商品状态怎么流转、DNA 有没有落库、重复分析是覆盖还是新增、失败时留下了什么痕迹。
 *
 * 覆盖任务书 Task 7 要求的四项：
 *   1. Mock Provider 完整流程
 *   2. AI 失败状态
 *   3. 数据库写入（经仓储契约验证，DB 实现的集成测试见 db-repositories.test.ts）
 *   4. 重复分析
 * 另外补了并发保护、过期任务放行、降级告警与「不静默降级」四条边界。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import { formatDateTime } from "@/lib/datetime";
import { resetServerEnvCache } from "@/lib/env";
import { getRepositories, type NewProductInput } from "@/repositories";
import { clearStoredAgentTasks, listStoredAgentTasks } from "@/repositories/mock/store";

import {
  ANALYZING_STALE_MS,
  PRODUCT_AGENT_TYPE,
  analyzeProduct,
  getProductAnalysisState,
} from "./product-agent.service";

/**
 * 先归一化环境再取仓储：`getRepositories()` 在 DATA_SOURCE=db 且缺少连接串时
 * 会直接抛错，放在模块顶层就会让整个测试文件加载失败。
 * （函数声明会提升，因此这里可以提前调用下面定义的 pinCleanMockEnv。）
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

/**
 * 固定为「Mock 数据源 + 未配置对象存储 + 未指定模型提供方」。
 * 显式清空是为了让断言不受本机 .env.local 影响 ——
 * 否则「本机配了 dashscope」会让一组本该离线跑的用例突然开始联网。
 */
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
});

afterEach(async () => {
  for (const id of createdProductIds.splice(0)) {
    const existing = await repositories.products.getById(id);
    if (existing) {
      await repositories.products.delete(id);
    }
  }
});

afterAll(() => {
  restoreEnv();
});

/* ------------------------------------------------------------------ */
/* 1. 完整流程                                                         */
/* ------------------------------------------------------------------ */

describe("analyzeProduct：Mock Provider 完整流程", () => {
  it("从商品到落库全链路打通：DNA 写入、状态流转、任务收口", async () => {
    const product = await createTestProduct();
    expect(product.analysisStatus).toBe("pending");

    const result = await analyzeProduct(product.id, { provider: okProvider() });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const analysis = result.data;

    // —— 返回值 ——
    expect(analysis.productId).toBe(product.id);
    expect(analysis.providerId).toBe("mock");
    expect(analysis.isMock).toBe(true);
    // 商品没有图片 → 图像理解未使用，且必须如实告警
    expect(analysis.visionUsed).toBe(false);
    expect(analysis.reanalyzed).toBe(false);
    expect(analysis.attempts).toBe(1);
    expect(analysis.repaired).toBe(false);
    expect(analysis.durationMs).toBeGreaterThanOrEqual(0);
    expect(analysis.durationText).not.toBe("");
    expect(analysis.warnings.join()).toContain("尚未上传图片");
    expect(analysis.dna.productId).toBe(product.id);

    // —— DNA 真的写进了仓储（不是只改了返回值）——
    const persisted = await repositories.productDna.getByProductId(product.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.category).toBe(analysis.dna.category);
    expect(persisted?.sellingPoints).toEqual(analysis.dna.sellingPoints);
    expect(persisted?.consumptionScenarios).toEqual(
      analysis.dna.consumptionScenarios,
    );
    // AI 产出默认未确认：必须由商家确认后才能对外使用
    expect(persisted?.approved).toBe(false);
    // Mock 产出必须自带「这是占位数据」的标记，避免被当成真实结论
    expect(persisted?.riskNotes[0]).toContain("【Mock】");

    // —— 商品状态 ——
    const reloaded = await repositories.products.getById(product.id);
    expect(reloaded?.analysisStatus).toBe("analyzed");

    // —— 任务记录（Task 5：input / output / duration / 状态）——
    const task = await repositories.agentTasks.findLatestByProduct(
      product.id,
      PRODUCT_AGENT_TYPE,
    );
    expect(task).not.toBeNull();
    expect(task?.status).toBe("completed");
    expect(task?.progress).toBe(100);
    expect(task?.durationMs).not.toBeNull();
    expect(task?.completedAt).not.toBeNull();
    expect(task?.errorMessage).toBeNull();
    expect(task?.title).toContain("连江测试用鲜活鲍鱼");
    expect(task?.input).toMatchObject({ productId: product.id, hasImage: false });
    expect(task?.output).toMatchObject({
      providerId: "mock",
      isMock: true,
      visionUsed: false,
      attempts: 1,
    });
    // output 里保留该次运行的结果快照，便于回溯
    expect(task?.output?.dna).toBeTruthy();
    expect(task?.id).toBe(analysis.taskId);
  });

  it("商品有图片时走图像理解，且不再提示缺少图片", async () => {
    const product = await createTestProduct({
      imageUrl:
        "https://example.supabase.co/storage/v1/object/public/product-images/baoyu.webp",
    });

    const result = await analyzeProduct(product.id, { provider: okProvider() });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.visionUsed).toBe(true);
    expect(result.data.warnings.join()).not.toContain("尚未上传图片");

    const task = await repositories.agentTasks.findLatestByProduct(
      product.id,
      PRODUCT_AGENT_TYPE,
    );
    expect(task?.input).toMatchObject({ hasImage: true });
    expect(task?.output).toMatchObject({ visionUsed: true });
  });

  it("本地内联图片不会被整段复制进 Agent 任务日志", async () => {
    const product = await createTestProduct({
      imageUrl: `data:image/png;base64,${"A".repeat(2048)}`,
    });

    const result = await analyzeProduct(product.id, { provider: okProvider() });
    expect(result.ok).toBe(true);

    const task = await repositories.agentTasks.findLatestByProduct(
      product.id,
      PRODUCT_AGENT_TYPE,
    );
    expect(task?.input?.imageUrl).toBe("inline:products.image_url");
  });

  it("结构化输出不合法时会自动纠错重试一次，任务里能看到 attempts", async () => {
    const product = await createTestProduct();

    const result = await analyzeProduct(product.id, {
      provider: createMockAIProvider({ scenario: "messy-then-ok" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.attempts).toBe(2);
    expect(result.data.repaired).toBe(true);

    const task = await repositories.agentTasks.findLatestByProduct(
      product.id,
      PRODUCT_AGENT_TYPE,
    );
    expect(task?.status).toBe("completed");
    expect(task?.output).toMatchObject({ attempts: 2, repaired: true });
  });
});

/* ------------------------------------------------------------------ */
/* 2. AI 失败状态                                                      */
/* ------------------------------------------------------------------ */

describe("analyzeProduct：AI 失败状态", () => {
  it("模型服务不可用时：商品标记 failed、任务记录失败原因、不写 DNA", async () => {
    const product = await createTestProduct();

    const result = await analyzeProduct(product.id, {
      provider: createMockAIProvider({ scenario: "unavailable" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MODEL_UNAVAILABLE");
    expect(result.error.retryable).toBe(true);

    // 绝不留下「半个成功」：DNA 不能存在
    expect(await repositories.productDna.getByProductId(product.id)).toBeNull();

    // 商品如实标记为分析失败，而不是停在 analyzing 或假装成功
    const reloaded = await repositories.products.getById(product.id);
    expect(reloaded?.analysisStatus).toBe("failed");

    const task = await repositories.agentTasks.findLatestByProduct(
      product.id,
      PRODUCT_AGENT_TYPE,
    );
    expect(task?.status).toBe("failed");
    expect(task?.errorMessage).toContain("模型服务暂时不可用");
    // 失败也要记耗时，否则没法判断「是立刻失败还是超时失败」
    expect(task?.durationMs).not.toBeNull();
    expect(task?.completedAt).not.toBeNull();
  });

  it("模型输出连续不合法时：报 SCHEMA_INVALID，任务记录纠错次数", async () => {
    const product = await createTestProduct();

    const result = await analyzeProduct(product.id, {
      provider: createMockAIProvider({ scenario: "always-invalid" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SCHEMA_INVALID");
    expect(result.error.message).toContain("连续 2 次");

    expect(await repositories.productDna.getByProductId(product.id)).toBeNull();
    const reloaded = await repositories.products.getById(product.id);
    expect(reloaded?.analysisStatus).toBe("failed");
  });

  it("模型超时时同样收口为 failed", async () => {
    const product = await createTestProduct();

    const result = await analyzeProduct(product.id, {
      provider: createMockAIProvider({ scenario: "timeout" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODEL_TIMEOUT");
    }
    const reloaded = await repositories.products.getById(product.id);
    expect(reloaded?.analysisStatus).toBe("failed");
  });

  it("配置了真实模型却没填 Key 时明确报错，**不会**偷偷用 Mock 顶替", async () => {
    const product = await createTestProduct();

    // 关键：不注入 provider，让服务走 getAIProvider() 的真实解析路径
    process.env.AI_PROVIDER = "dashscope";
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.AI_API_KEY;
    resetServerEnvCache();

    const result = await analyzeProduct(product.id);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.message).toContain("通义千问");

    // 没有 DNA = 没有降级产物
    expect(await repositories.productDna.getByProductId(product.id)).toBeNull();
    const task = await repositories.agentTasks.findLatestByProduct(
      product.id,
      PRODUCT_AGENT_TYPE,
    );
    expect(task?.status).toBe("failed");
    expect(task?.output).toBeNull();
  });

  it("失败后可以重试成功，商品从 failed 回到 analyzed", async () => {
    const product = await createTestProduct();

    const failed = await analyzeProduct(product.id, {
      provider: createMockAIProvider({ scenario: "unavailable" }),
    });
    expect(failed.ok).toBe(false);

    const retried = await analyzeProduct(product.id, { provider: okProvider() });
    expect(retried.ok).toBe(true);
    if (!retried.ok) {
      return;
    }

    // 第二次是「首次生成 DNA」而不是覆盖
    expect(retried.data.reanalyzed).toBe(false);
    const reloaded = await repositories.products.getById(product.id);
    expect(reloaded?.analysisStatus).toBe("analyzed");
  });
});

/* ------------------------------------------------------------------ */
/* 3. 重复分析                                                         */
/* ------------------------------------------------------------------ */

describe("analyzeProduct：重复分析", () => {
  it("第二次分析覆盖已有 DNA，而不是新增一条", async () => {
    const product = await createTestProduct();

    const first = await analyzeProduct(product.id, { provider: okProvider() });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.data.reanalyzed).toBe(false);

    // 人为改坏已有 DNA（模拟商家手工确认 + 手工编辑），验证重新分析会覆盖回去
    await repositories.productDna.update(product.id, {
      approved: true,
      sellingPoints: ["人工手写的卖点"],
    });
    const tampered = await repositories.productDna.getByProductId(product.id);
    expect(tampered?.approved).toBe(true);
    expect(tampered?.sellingPoints).toEqual(["人工手写的卖点"]);

    const second = await analyzeProduct(product.id, { provider: okProvider() });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }

    expect(second.data.reanalyzed).toBe(true);

    // 一个商品始终只有一份 DNA：内容被覆盖回 AI 产出
    const after = await repositories.productDna.getByProductId(product.id);
    expect(after?.approved).toBe(false);
    expect(after?.sellingPoints).toEqual(second.data.dna.sellingPoints);
    expect(after?.sellingPoints).not.toEqual(["人工手写的卖点"]);

    // 历史任务被完整保留，可以回溯每一次运行
    const history = await repositories.agentTasks.listByProduct(
      product.id,
      PRODUCT_AGENT_TYPE,
    );
    expect(history).toHaveLength(2);
    expect(history.every((task) => task.status === "completed")).toBe(true);
    // 列表按时间倒序，最新的在最前
    expect(history[0]?.id).toBe(second.data.taskId);
    expect(history[1]?.id).toBe(first.data.taskId);

    // 商品状态仍然是 analyzed（不是被 repeated run 弄成别的）
    const reloaded = await repositories.products.getById(product.id);
    expect(reloaded?.analysisStatus).toBe("analyzed");
  });

  it("连续分析后 analysisStatus 始终一致，不会出现多份互相矛盾的 DNA", async () => {
    const product = await createTestProduct();

    for (let index = 0; index < 3; index += 1) {
      const result = await analyzeProduct(product.id, { provider: okProvider() });
      expect(result.ok).toBe(true);
    }

    const history = await repositories.agentTasks.listByProduct(
      product.id,
      PRODUCT_AGENT_TYPE,
    );
    expect(history).toHaveLength(3);

    const dna = await repositories.productDna.getByProductId(product.id);
    expect(dna).not.toBeNull();
    expect(dna?.aiVersion).toBe("v1.0");
  });
});

/* ------------------------------------------------------------------ */
/* 4. 并发保护与过期放行                                               */
/* ------------------------------------------------------------------ */

describe("analyzeProduct：并发保护", () => {
  it("已有运行中的任务时拒绝重复发起，且不改动商品状态", async () => {
    const product = await createTestProduct();

    const running = await repositories.agentTasks.create({
      agentType: PRODUCT_AGENT_TYPE,
      title: "分析商品：连江测试用鲜活鲍鱼",
      productId: product.id,
      status: "running",
      input: { productId: product.id },
    });

    const result = await analyzeProduct(product.id, { provider: okProvider() });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("RATE_LIMITED");
    expect(result.error.message).toContain("正在分析中");

    // 被拒绝的调用不该留下任何副作用
    const reloaded = await repositories.products.getById(product.id);
    expect(reloaded?.analysisStatus).toBe("pending");
    const history = await repositories.agentTasks.listByProduct(
      product.id,
      PRODUCT_AGENT_TYPE,
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe(running.id);
  });

  it("运行中任务超过过期阈值后允许重新发起（进程中断不会永久卡住商品）", async () => {
    const product = await createTestProduct();

    const stale = await repositories.agentTasks.create({
      agentType: PRODUCT_AGENT_TYPE,
      title: "分析商品：连江测试用鲜活鲍鱼",
      productId: product.id,
      status: "running",
    });

    // 把创建时间往前拨，模拟「部署重启留下的孤儿任务」
    const stored = listStoredAgentTasks().find((task) => task.id === stale.id);
    expect(stored).toBeDefined();
    if (stored) {
      stored.createdAt = formatDateTime(
        new Date(Date.now() - ANALYZING_STALE_MS - 60_000),
      );
    }

    const result = await analyzeProduct(product.id, { provider: okProvider() });
    expect(result.ok).toBe(true);

    const reloaded = await repositories.products.getById(product.id);
    expect(reloaded?.analysisStatus).toBe("analyzed");
  });
});

/* ------------------------------------------------------------------ */
/* 5. 入参校验                                                         */
/* ------------------------------------------------------------------ */

describe("analyzeProduct：入参校验", () => {
  it("商品不存在时返回 NOT_FOUND", async () => {
    const result = await analyzeProduct("prod_missing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("非法 ID 直接失败，不触达仓储", async () => {
    for (const bad of ["", "../../etc/passwd", "a".repeat(80)]) {
      const result = await analyzeProduct(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION_FAILED");
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. 读取：详情页分析上下文                                           */
/* ------------------------------------------------------------------ */

describe("getProductAnalysisState", () => {
  it("没有历史任务时返回 null 任务 + 当前模型通道状态", async () => {
    const product = await createTestProduct();
    const result = await getProductAnalysisState(product.id);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.latestTask).toBeNull();
    expect(result.data.provider.providerId).toBe("mock");
    expect(result.data.provider.isMock).toBe(true);
    expect(result.data.provider.usable).toBe(true);
  });

  it("真实模型缺少凭证时如实标记不可用并给出原因", async () => {
    const product = await createTestProduct();

    process.env.AI_PROVIDER = "dashscope";
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.AI_API_KEY;
    resetServerEnvCache();

    const result = await getProductAnalysisState(product.id);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.provider.providerId).toBe("dashscope");
    expect(result.data.provider.isMock).toBe(false);
    expect(result.data.provider.usable).toBe(false);
    expect(result.data.provider.reason).toContain("DASHSCOPE_API_KEY");
  });

  it("分析完成后能读回最近一次任务的运行信息（供页面展示）", async () => {
    const product = await createTestProduct();
    await analyzeProduct(product.id, { provider: okProvider() });

    const result = await getProductAnalysisState(product.id);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const task = result.data.latestTask;
    expect(task).not.toBeNull();
    expect(task?.status).toBe("completed");
    expect(task?.providerId).toBe("mock");
    expect(task?.isMock).toBe(true);
    expect(task?.durationMs).not.toBeNull();
    expect(task?.attempts).toBe(1);
    expect(task?.repaired).toBe(false);
    expect(task?.warnings.join()).toContain("尚未上传图片");
  });
});
