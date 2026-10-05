/**
 * 健康检查在「未配置数据库 / 数据源不匹配」路径下的行为测试（不需要数据库）
 *
 * 关键约束：缺少凭证时必须返回 Result 错误信封，而不是抛异常 ——
 * 这样调用方（脚本 / 未来的 /api/health）可以决定降级策略。
 */

import { afterAll, describe, expect, it } from "vitest";

import { resetServerEnvCache } from "@/lib/env";

import { checkDatabaseConnection, describeHealth } from "./health";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDataSource = process.env.DATA_SOURCE;

afterAll(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (originalDataSource === undefined) {
    delete process.env.DATA_SOURCE;
  } else {
    process.env.DATA_SOURCE = originalDataSource;
  }
  resetServerEnvCache();
});

describe("checkDatabaseConnection", () => {
  it("数据源是 mock 时返回 VALIDATION_FAILED，并点明 mock 根本没有数据库", async () => {
    process.env.DATA_SOURCE = "mock";
    resetServerEnvCache();

    const result = await checkDatabaseConnection();

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.detail).toContain("mock");
  });

  it("数据源是 db 但未配置 DATABASE_URL 时返回 VALIDATION_FAILED，不抛异常", async () => {
    process.env.DATA_SOURCE = "db";
    delete process.env.DATABASE_URL;
    resetServerEnvCache();

    const result = await checkDatabaseConnection();

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.retryable).toBe(false);
    expect(result.error.detail).toContain("DATABASE_URL");
  });
});

describe("describeHealth", () => {
  it("输出数据源 / 耗时 / 版本 / 迁移数，便于日志排查", () => {
    const text = describeHealth({
      configured: true,
      dataSource: "local",
      latencyMs: 42,
      serverVersion: "PostgreSQL 15.8 on x86_64-pc-linux-gnu",
      migrationsApplied: true,
      appliedMigrations: 1,
    });

    expect(text).toContain("source=local");
    expect(text).toContain("latency=42ms");
    expect(text).toContain("migrations=1");
    expect(text).toContain("PostgreSQL 15.8");
  });
});
