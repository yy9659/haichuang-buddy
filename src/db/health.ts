/**
 * 数据库连接健康检查
 *
 * 用途：
 * - 部署自检 / 运维排查
 * - 迁移脚本与 Repository 测试在开始前确认连通性
 *
 * 约定：返回 Result，不抛异常，调用方自行决定是否降级。
 * 实现上走 `queryRaw` 发原始查询，不经过 Drizzle 的 schema ——
 * 这样即使迁移尚未执行也能准确报出「连得上但表还没建」。
 *
 * 本地（PGlite）与远程（Supabase）共用本实现：两者都是真 PostgreSQL，
 * 差别只在连接方式，由 `@/db/gateway` 分派。
 */

import { getDataSource, isDatabaseConfigured } from "@/lib/env";
import type { DataSourceId } from "@/lib/env";
import { attempt, fail, toAppError, type Result } from "@/lib/result";

import { queryRaw } from "./gateway";

export interface DatabaseHealth {
  /** 数据源是否可用（local 恒为 true；db 需已配 DATABASE_URL） */
  configured: boolean;
  /** 当前生效的数据源 */
  dataSource: DataSourceId;
  /** 往返耗时（毫秒） */
  latencyMs: number;
  /** 服务端版本，如 PostgreSQL 15.8 */
  serverVersion: string;
  /** 迁移是否已应用（存在 drizzle 迁移记录表且条数 > 0） */
  migrationsApplied: boolean;
  /** 已应用的迁移条数 */
  appliedMigrations: number;
}

/**
 * 检查数据库连通性、版本与迁移状态。
 *
 * - mock 数据源 → VALIDATION_FAILED（根本不存在数据库）
 * - DATA_SOURCE=db 但未配 DATABASE_URL → VALIDATION_FAILED（不可重试）
 * - 连不上 / 鉴权失败 → DB_ERROR（可重试）
 */
export async function checkDatabaseConnection(): Promise<Result<DatabaseHealth>> {
  const dataSource = getDataSource();

  if (dataSource === "mock") {
    return fail(
      "VALIDATION_FAILED",
      "当前数据源是 mock，没有数据库可检查",
      "mock 使用进程内内存仓储。要检查数据库，请把 DATA_SOURCE 改为 local 或 db。",
    );
  }

  if (dataSource === "db" && !isDatabaseConfigured()) {
    return fail(
      "VALIDATION_FAILED",
      "尚未配置数据库连接串",
      "缺少环境变量：DATABASE_URL（请写入 .env.local）",
    );
  }

  return attempt<DatabaseHealth>(
    async () => {
      const startedAt = Date.now();
      const pingRows = await queryRaw<{ version: string }>(
        "select version() as version",
      );
      const latencyMs = Date.now() - startedAt;

      const migration = await readMigrationState();

      return {
        configured: true,
        dataSource,
        latencyMs,
        serverVersion: pingRows[0]?.version ?? "unknown",
        migrationsApplied: migration.applied > 0,
        appliedMigrations: migration.applied,
      };
    },
    (cause) => toAppError(cause, "DB_ERROR", "数据库连接失败"),
  );
}

/**
 * 读取迁移状态。
 * drizzle-kit 的记录表在 `drizzle.__drizzle_migrations`；表不存在说明
 * 迁移还没跑过 —— 这是正常状态，不作为错误抛出。
 */
async function readMigrationState(): Promise<{ applied: number }> {
  try {
    const rows = await queryRaw<{ count: string }>(
      "select count(*)::text as count from drizzle.__drizzle_migrations",
    );
    const applied = Number.parseInt(rows[0]?.count ?? "0", 10);
    return { applied: Number.isFinite(applied) ? applied : 0 };
  } catch {
    return { applied: 0 };
  }
}

/** 把健康检查结果整理成一行可读文本，供脚本与日志使用 */
export function describeHealth(health: DatabaseHealth): string {
  return [
    `source=${health.dataSource}`,
    `latency=${health.latencyMs}ms`,
    `server=${health.serverVersion}`,
    `migrations=${health.appliedMigrations}`,
  ].join(" | ");
}
