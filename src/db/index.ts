/**
 * 数据库层统一出口
 *
 * 只允许服务端引用。页面与组件必须经 `src/services` → `src/repositories` 访问数据，
 * 不允许在任何 `page.tsx` / 组件里直接 import 本模块。
 *
 * 仓储层的 `import { getDb } from "@/db"` 拿到的是**分派后**的实例：
 * DATA_SOURCE=local 给 PGlite，DATA_SOURCE=db 给远程 Supabase。仓储代码
 * 两种模式共用一套，不感知差异。
 */

// —— 统一网关（推荐入口）——
export {
  closeDb,
  executeSql,
  getDb,
  isLocalDataSource,
  isRemoteDataSource,
  queryRaw,
  type AppDatabase,
} from "./gateway";

// —— 远程 Supabase 客户端（DATA_SOURCE=db 专用）——
export {
  closeRemoteDb,
  getRemoteDb,
  getSqlClient,
  type Database,
} from "./client";

// —— 本地 PGlite 客户端（DATA_SOURCE=local 专用）——
export {
  closeLocalDb,
  ensureLocalDatabaseReady,
  getLocalClient,
  getLocalDb,
  resolveLocalDbDir,
  resolveMigrationsFolder,
  DEFAULT_LOCAL_DB_DIR,
  type LocalDatabase,
} from "./local";

export {
  checkDatabaseConnection,
  describeHealth,
  type DatabaseHealth,
} from "./health";
export { EMBEDDING_DIMENSIONS } from "@/lib/embedding";
export * as dbSchema from "./schema";
export { schema } from "./client";
