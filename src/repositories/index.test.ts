/**
 * 数据源切换与仓储契约的单元测试（不需要数据库）
 *
 * 覆盖三件必须成立的事：
 * 1. DATA_SOURCE=mock 时行为与 S0 完全一致（6 个演示商品）
 * 2. DATA_SOURCE=db 但缺 DATABASE_URL 时必须报错，禁止静默降级
 * 3. Mock 仓储同样满足 create / update / delete 契约（否则「切 mock 就能跑」不成立）
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { isAiConfigured, resetServerEnvCache } from "@/lib/env";
import { AppError } from "@/lib/result";

import { getDataSourceStatus, getRepositories } from "./index";

const originalEnv = {
  DATA_SOURCE: process.env.DATA_SOURCE,
  DATABASE_URL: process.env.DATABASE_URL,
};

function restoreEnv(): void {
  if (originalEnv.DATA_SOURCE === undefined) {
    delete process.env.DATA_SOURCE;
  } else {
    process.env.DATA_SOURCE = originalEnv.DATA_SOURCE;
  }
  if (originalEnv.DATABASE_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
  }
  resetServerEnvCache();
}

beforeEach(() => {
  restoreEnv();
});

afterAll(() => {
  restoreEnv();
});

describe("数据源切换", () => {
  it("默认（未设置 DATA_SOURCE）走 mock", () => {
    delete process.env.DATA_SOURCE;
    resetServerEnvCache();
    expect(getDataSourceStatus().dataSource).toBe("mock");
  });

  it("DATA_SOURCE=db 且缺少 DATABASE_URL 时明确报错，不回退 mock", () => {
    process.env.DATA_SOURCE = "db";
    delete process.env.DATABASE_URL;
    resetServerEnvCache();

    let caught: unknown;
    try {
      getRepositories();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("VALIDATION_FAILED");
    expect((caught as AppError).message).toContain("尚未配置数据库连接");
  });

  it("DATA_SOURCE 取值非法时抛出环境变量校验错误", () => {
    process.env.DATA_SOURCE = "postgres";
    resetServerEnvCache();

    expect(() => getRepositories()).toThrowError(AppError);
    restoreEnv();
  });

  it("DATA_SOURCE=mock 时返回 Mock 仓储，商品数量与 Phase 0 一致", async () => {
    process.env.DATA_SOURCE = "mock";
    resetServerEnvCache();

    const repositories = getRepositories();
    const products = await repositories.products.list();
    expect(products).toHaveLength(6);
    expect(products.map((product) => product.name)).toContain("连江鲜活鲍鱼");

    // 状态信息包含模型通道配置与否，便于排查
    expect(getDataSourceStatus()).toEqual({
      dataSource: "mock",
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      localDatabase: false,
      // mock 是进程内内存，重启即还原
      persistent: false,
      aiConfigured: isAiConfigured(),
    });
  });

  it("DashScope 专用 Key 已配置时，不会被误判为 AI 未配置", () => {
    process.env.AI_PROVIDER = "dashscope";
    process.env.DASHSCOPE_API_KEY = "test-key";
    delete process.env.AI_API_KEY;
    delete process.env.AI_BASE_URL;
    resetServerEnvCache();

    expect(isAiConfigured()).toBe(true);
    expect(getDataSourceStatus().aiConfigured).toBe(true);
  });

  it("DATA_SOURCE=local 时走数据库仓储且标记为持久化，无需任何凭证", () => {
    process.env.DATA_SOURCE = "local";
    delete process.env.DATABASE_URL;
    resetServerEnvCache();

    // local 不该因为缺少 DATABASE_URL 而报错
    expect(() => getRepositories()).not.toThrow();
    expect(getDataSourceStatus()).toMatchObject({
      dataSource: "local",
      localDatabase: true,
      persistent: true,
    });
  });

  it("取值大小写敏感，拼错不会悄悄生效", () => {
    process.env.DATA_SOURCE = "DB";
    resetServerEnvCache();
    expect(() => getRepositories()).toThrowError(AppError);
    restoreEnv();
  });
});

describe("Mock 商品仓储的写操作契约", () => {
  beforeEach(() => {
    process.env.DATA_SOURCE = "mock";
    resetServerEnvCache();
  });

  it("创建 → 更新 → 删除 全部可用", async () => {
    const { products } = getRepositories();
    const before = await products.list();

    const created = await products.create({
      name: "连江测试用海带结",
      category: "海产品",
      price: 12.5,
      unit: "500g",
      stock: 20,
      tags: ["测试"],
    });

    expect(created.id.startsWith("prod_")).toBe(true);
    expect(created.analysisStatus).toBe("pending");
    expect(created.metrics).toEqual({ views: 0, inquiries: 0, conversions: 0 });

    const afterCreate = await products.list();
    expect(afterCreate).toHaveLength(before.length + 1);

    const updated = await products.update(created.id, { stock: 99, price: 15 });
    expect(updated.stock).toBe(99);
    expect(updated.price).toBe(15);
    expect(updated.name).toBe("连江测试用海带结");

    await products.delete(created.id);
    expect(await products.getById(created.id)).toBeNull();
    expect(await products.list()).toHaveLength(before.length);
  });

  it("更新 / 删除不存在的商品抛 NOT_FOUND", async () => {
    const { products } = getRepositories();
    await expect(products.update("prod_missing", { stock: 1 })).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(products.delete("prod_missing")).rejects.toBeInstanceOf(AppError);
  });

  it("Product DNA 首次生成用 create，重复创建会被拒绝", async () => {
    const { productDna } = getRepositories();
    const product = await getRepositories().products.create({
      name: "连江测试用紫菜",
      category: "干货",
      price: 39.9,
    });

    const input = {
      productId: product.id,
      category: "干货",
      subCategory: "紫菜",
      visualFeatures: ["叶片完整"],
      coreFeatures: ["头水采摘"],
      sellingPoints: ["免洗无沙"],
      targetUsers: ["宝妈家庭"],
      consumptionScenarios: ["快手早餐"],
      userPainPoints: ["怕有沙"],
      marketingAngles: ["产地直发"],
      riskNotes: ["注意防潮"],
      aiVersion: "v1.0",
      confidence: 0.9,
      approved: false,
    };

    const created = await productDna.create(input);
    expect(created.consumptionScenarios).toEqual(["快手早餐"]);

    await expect(productDna.create(input)).rejects.toBeInstanceOf(AppError);

    const updated = await productDna.update(product.id, { approved: true });
    expect(updated.approved).toBe(true);
  });
});
