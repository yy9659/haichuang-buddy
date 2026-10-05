/**
 * 数据库客户端（postgres.js + Drizzle）
 *
 * 设计要点：
 * - 惰性连接：只有真正调用 getRemoteDb() 时才读环境变量并建连接池，
 *   缺少 DATABASE_URL 时不阻断 `next build`（构建期不会连接数据库）。
 * - 显式失败：没配 DATABASE_URL 直接抛 VALIDATION_FAILED，禁止静默回退。
 * - 单例复用：连接池挂在 globalThis 上，避免 Next.js 开发模式热更新时反复建池耗尽连接。
 * - prepare: false：兼容 Supabase 连接池（PgBouncer transaction 模式不支持预处理语句）。
 *
 * 仅服务端使用。禁止在客户端组件中 import 本模块。
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getServerEnv } from "@/lib/env";
import { AppError } from "@/lib/result";

import * as schema from "./schema";

/** Drizzle 实例类型（带 schema，便于后续使用 db.query.*） */
export type Database = PostgresJsDatabase<typeof schema>;

/** 开发模式下连接池需要跨热更新复用，否则每次 HMR 都会新建一个池 */
const globalForDb = globalThis as unknown as {
  __haichuangSql?: postgres.Sql;
  __haichuangDb?: Database;
};

function resolveDatabaseUrl(): string {
  const { DATABASE_URL } = getServerEnv();
  if (!DATABASE_URL) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "尚未配置数据库连接串",
      detail:
        "缺少环境变量：DATABASE_URL。请写入 .env.local（Supabase 控制台 → Project Settings → Database → Connection string），或将 DATA_SOURCE 设为 mock。",
      retryable: false,
    });
  }
  return DATABASE_URL;
}

/** 获取 postgres.js 连接池（单例） */
export function getSqlClient(): postgres.Sql {
  if (globalForDb.__haichuangSql) {
    return globalForDb.__haichuangSql;
  }

  const sql = postgres(resolveDatabaseUrl(), {
    // Supabase pooler 不支持 prepared statements
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 15,
  });

  globalForDb.__haichuangSql = sql;
  return sql;
}

/** 获取 Drizzle 实例（单例，惰性创建） */
export function getRemoteDb(): Database {
  if (globalForDb.__haichuangDb) {
    return globalForDb.__haichuangDb;
  }

  const db = drizzle(getSqlClient(), { schema });
  globalForDb.__haichuangDb = db;
  return db;
}

/**
 * 关闭连接池。用于脚本与测试收尾，避免进程挂住不退出。
 * 应用运行期不需要调用。
 */
export async function closeRemoteDb(): Promise<void> {
  const sql = globalForDb.__haichuangSql;
  globalForDb.__haichuangSql = undefined;
  globalForDb.__haichuangDb = undefined;
  if (sql) {
    await sql.end({ timeout: 5 });
  }
}

/** 供仓储实现按需引用表定义与操作符 */
export { schema };
