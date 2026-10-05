/**
 * 数据库网关 —— 按 DATA_SOURCE 在两种 PostgreSQL 实现之间分派。
 *
 * 为什么要这一层：
 * 本地开发跑 PGlite（WASM 版 PostgreSQL），部署跑远程 Supabase。两者都是
 * 真正的 PostgreSQL、共用同一套 schema 与迁移，但客户端类型不同
 * （`PgliteDatabase` / `PostgresJsDatabase`）。仓储层有几十处 `getDb()`，
 * 不该关心自己连的是哪一个 —— 分派集中在这里。
 *
 * 三种数据源的语义：
 * - `mock`  → 走内存仓储，**根本不会调用本模块**；真调到了说明分层出了问题，
 *             所以这里明确抛错而不是返回空实例，让 bug 立刻暴露。
 * - `local` → PGlite，数据落在 `.data/pgdata`
 * - `db`    → 远程 PostgreSQL，缺 DATABASE_URL 直接抛 VALIDATION_FAILED
 *
 * 仅服务端使用。禁止在客户端组件中 import 本模块。
 */

import type { SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { getDataSource, isDatabaseConfigured } from "@/lib/env";
import { AppError } from "@/lib/result";

import { getRemoteDb } from "./client";
import { getLocalClient, getLocalDb } from "./local";

import * as schema from "./schema";

/**
 * 仓储层看到的数据库类型。
 *
 * 为什么声明成远程驱动而不是抽象基类 `PgDatabase`：
 * Drizzle 用 HKT（`PgQueryResultHKT`）携带驱动信息，用基类接收会让
 * `row` 退化成 `unknown`，于是全项目每一处 `db.select({...})` 的返回类型
 * 都塌成 any —— 实测直接导致 seed 脚本等十余处推断失败。
 *
 * 两种驱动是安全的：`PgliteDatabase` 与 `PostgresJsDatabase` 都直接继承
 * `PgDatabase`，一个查询方法都没覆写，差异全部封在 session 里。所以本地
 * 实例断言过来运行期完全同构 —— 这不是在骗类型系统，而是选一个双方共享的
 * 名义类型（下面对应的断言处有说明）。
 */
export type AppDatabase = PostgresJsDatabase<typeof schema>;

/** 当前是否使用本地 PGlite */
export function isLocalDataSource(): boolean {
  return getDataSource() === "local";
}

/** 当前是否使用远程 PostgreSQL */
export function isRemoteDataSource(): boolean {
  return getDataSource() === "db";
}

/**
 * 获取 Drizzle 实例（按数据源分派）。
 *
 * 注意：本地模式下实例是同步返回的，但**迁移**由
 * `ensureLocalDatabaseReady()` 负责，服务启动时已在 `src/instrumentation.ts`
 * 里跑过。脚本里请自行先 await 它。
 */
export function getDb(): AppDatabase {
  const source = getDataSource();

  if (source === "local") {
    // 断言理由见 AppDatabase 的注释：两者继承同一个 PgDatabase，
    // 查询方法完全同构，差异只在底层 session。
    return getLocalDb() as unknown as AppDatabase;
  }

  if (source === "db") {
    if (!isDatabaseConfigured()) {
      throw new AppError({
        code: "VALIDATION_FAILED",
        message: "数据源已设为 db，但尚未配置数据库连接",
        detail:
          "缺少环境变量：DATABASE_URL。请写入 .env.local，或把 DATA_SOURCE 改为 local / mock。",
        retryable: false,
      });
    }
    return getRemoteDb();
  }

  throw new AppError({
    code: "VALIDATION_FAILED",
    message: "当前数据源是 mock，不应访问数据库",
    detail:
      "DATA_SOURCE=mock 时数据来自内存仓储（src/repositories/mock）。出现本错误说明有代码绕过 repositories 直接读库了。",
    retryable: false,
  });
}

/**
 * 执行原始 SQL，返回数据行。
 *
 * 为需要 escape hatch 的场景保留（健康检查、向量检索等 Drizzle 表达不了的语句）。
 * 两种驱动的调用形态不同：PGlite 是 `query(text, params)`，postgres.js 是
 * `unsafe(text, params)`。参数一律走占位符绑定，不要拼字符串。
 */
export async function queryRaw<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const source = getDataSource();

  if (source === "local") {
    const result = await getLocalClient().query<T>(text, params);
    return result.rows;
  }

  if (source === "db") {
    if (!isDatabaseConfigured()) {
      throw new AppError({
        code: "VALIDATION_FAILED",
        message: "数据源已设为 db，但尚未配置数据库连接",
        detail: "缺少环境变量：DATABASE_URL。",
        retryable: false,
      });
    }
    const { getSqlClient } = await import("./client");
    const rows = await getSqlClient().unsafe(text, params as never[]);
    // postgres.js 的 unsafe 返回 RowList（带 concat/values 等方法的数组子类），
    // 与调用方期望的裸行数组结构重叠不足，需显式经 unknown 转换。
    return rows as unknown as T[];
  }

  throw new AppError({
    code: "VALIDATION_FAILED",
    message: "当前数据源是 mock，不应访问数据库",
    retryable: false,
  });
}

/**
 * 执行 Drizzle `sql` 模板查询，**统一返回行数组**。
 *
 * 为什么需要它：两种驱动的 `db.execute()` 返回结构**不一样** ——
 * postgres.js 返回数组（`RowList`），PGlite 返回 `{ rows, fields, affectedRows }`。
 * 上面的 `AppDatabase` 断言把它们说成同一个类型，于是 local 模式下
 * `db.execute(...).map()` 会在运行期炸成「rows.map is not a function」——
 * 类型检查完全看不出来。实测踩过一次（地基验收脚本），因此把差异在这里抹平。
 *
 * 仓储层目前只用查询构造器（`.select()/.insert()/.update()/.delete()`，
 * 两种驱动返回一致），所以没踩到；但凡要写裸 SQL，一律走本函数或 `queryRaw()`，
 * 不要直接调 `getDb().execute()`。
 */
export async function executeSql<
  T extends Record<string, unknown> = Record<string, unknown>,
>(query: SQL): Promise<T[]> {
  const result = await getDb().execute<T>(query);

  if (Array.isArray(result)) {
    return result as T[];
  }

  // PGlite 形态：{ rows: [...] }
  return (result as unknown as { rows: T[] }).rows;
}

/**
 * 关闭数据库连接。用于脚本与测试收尾，避免进程挂住不退出。
 * mock 模式下是空操作。
 */
export async function closeDb(): Promise<void> {
  const source = getDataSource();

  if (source === "local") {
    const { closeLocalDb } = await import("./local");
    await closeLocalDb();
    return;
  }

  if (source === "db") {
    const { closeRemoteDb } = await import("./client");
    await closeRemoteDb();
  }
}
