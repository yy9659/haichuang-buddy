import {
  getDataSource,
  isAiConfigured,
  isDatabaseConfigured,
  type DataSourceId,
} from "@/lib/env";
import { AppError } from "@/lib/result";

import { createDbRepositories } from "./db";
import { createMockRepositories } from "./mock";

import type { Repositories } from "./types";

export * from "./types";

/**
 * 仓储总入口。
 *
 * 切换数据源只需改 `.env.local` 里的一行：
 *   DATA_SOURCE=mock  → 内置演示数据（默认；进程内内存，重启即还原）
 *   DATA_SOURCE=local → 本地 PGlite（WASM 版 PostgreSQL），数据落在 .data/pgdata
 *   DATA_SOURCE=db    → 远程 Supabase PostgreSQL
 *
 * `local` 与 `db` 共用同一套数据库仓储实现（`createDbRepositories`）——
 * 差异只在底层客户端，由 `@/db` 的网关按数据源分派。
 *
 * 两条硬性约束：
 * 1. `DATA_SOURCE=db` 但没配 DATABASE_URL → 明确抛 VALIDATION_FAILED，不静默回退 Mock。
 * 2. 某个领域的数据库实现还没写 → 抛 NOT_IMPLEMENTED，也不回退 Mock。
 *    宁可报错，也不要让用户看到「数据是真的」的假象。
 *
 * 页面代码完全不需要感知这件事 —— 这是 S0 分层的目的。
 */
export function getRepositories(): Repositories {
  const dataSource = getDataSource();

  if (dataSource === "db") {
    if (!isDatabaseConfigured()) {
      throw new AppError({
        code: "VALIDATION_FAILED",
        message: "数据源已设为 db，但尚未配置数据库连接",
        detail:
          "缺少环境变量：DATABASE_URL。请写入 .env.local，或把 DATA_SOURCE 改为 local / mock。",
        retryable: false,
      });
    }
    return createDbRepositories();
  }

  if (dataSource === "local") {
    return createDbRepositories();
  }

  return createMockRepositories();
}

/** 数据源诊断信息，供排查「为什么页面是假数据」时使用 */
export interface DataSourceStatus {
  dataSource: DataSourceId;
  /** 远程数据库（DATABASE_URL）是否已配置 */
  databaseConfigured: boolean;
  /** 是否正在使用本地 PGlite（数据持久化到磁盘） */
  localDatabase: boolean;
  /** 数据是否会在重启后保留 */
  persistent: boolean;
  aiConfigured: boolean;
}

export function getDataSourceStatus(): DataSourceStatus {
  const dataSource = getDataSource();
  return {
    dataSource,
    databaseConfigured: isDatabaseConfigured(),
    localDatabase: dataSource === "local",
    persistent: dataSource !== "mock",
    aiConfigured: isAiConfigured(),
  };
}
