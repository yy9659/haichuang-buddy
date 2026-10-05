/**
 * 本地数据库客户端（PGlite —— WASM 版 PostgreSQL）
 *
 * 为什么是 PGlite 而不是 SQLite：
 * 项目在 S1 就按 PostgreSQL 写好了 14 张表、8 个迁移和整套 Drizzle 仓储，
 * 用的是 `jsonb` / `uuid` / `timestamptz` / `text[]` / 枚举 / 外键级联。
 * 换成 SQLite 意味着把这些全部重写一遍；PGlite 是真正跑在 WASM 里的
 * PostgreSQL，同一套迁移和 schema 几乎原样可用，只需去掉 pgvector 依赖
 * （见 0000 迁移顶部说明）。
 *
 * 数据落在本地目录（默认 `.data/pgdata`），是完整的 PostgreSQL 数据目录
 * （base / pg_wal / PG_VERSION …），进程重启后数据仍在 —— 与 mock 的
 * 内存实现本质不同。
 *
 * 设计要点：
 * - 惰性创建 + 单例挂 globalThis：Next.js 开发模式热更新会反复求值模块，
 *   不挂全局就会每次 HMR 新建一个 PG 实例，把数据目录锁死。
 * - 迁移在 `ensureLocalDatabaseReady()` 里跑，由 `src/instrumentation.ts`
 *   在服务启动时调用；开发模式新增迁移后会重新检查版本。
 * - 仅服务端使用。禁止在客户端组件中 import 本模块。
 */

import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { getServerEnv } from "@/lib/env";

import * as schema from "./schema";

/** 本地 Drizzle 实例类型（带 schema，便于使用 db.query.*） */
export type LocalDatabase = PgliteDatabase<typeof schema>;

/** 默认数据目录（相对项目根）。可用 LOCAL_DB_DIR 覆盖 */
export const DEFAULT_LOCAL_DB_DIR = ".data/pgdata";

const globalForLocal = globalThis as unknown as {
  __haichuangLocalClient?: PGlite;
  __haichuangLocalDb?: LocalDatabase;
  __haichuangLocalReady?: Promise<void>;
  __haichuangLocalMigrationTag?: string;
};

/** 解析本地数据目录为绝对路径 */
export function resolveLocalDbDir(): string {
  const raw = getServerEnv().LOCAL_DB_DIR ?? DEFAULT_LOCAL_DB_DIR;
  return path.isAbsolute(raw)
    ? raw
    : path.resolve(/* turbopackIgnore: true */ process.cwd(), raw);
}

/**
 * 解析迁移目录。
 *
 * 用 `process.cwd()` 而不是 `import.meta.url`：迁移是 `.sql` 文件，
 * 不参与打包，运行期（`next start` / tsx 脚本）从项目根按相对路径找最可靠。
 */
export function resolveMigrationsFolder(): string {
  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    "src/db/migrations",
  );
}

/** 热更新后判断迁移清单是否变化，避免沿用旧的“已就绪”状态。 */
function currentMigrationTag(): string {
  const journalPath = path.join(resolveMigrationsFolder(), "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries?: Array<{ tag: string }>;
  };
  return journal.entries?.at(-1)?.tag ?? "";
}

/**
 * 获取 PGlite 实例（单例，惰性创建）。
 *
 * 注意 PGlite 不会递归创建目录，父目录不存在时直接抛 ENOENT ——
 * 这里先 `mkdirSync(recursive: true)` 兜住。
 */
export function getLocalClient(): PGlite {
  if (globalForLocal.__haichuangLocalClient) {
    return globalForLocal.__haichuangLocalClient;
  }

  const dir = resolveLocalDbDir();
  fs.mkdirSync(dir, { recursive: true });

  const client = new PGlite(dir);
  globalForLocal.__haichuangLocalClient = client;
  return client;
}

/** 获取本地 Drizzle 实例（单例，惰性创建） */
export function getLocalDb(): LocalDatabase {
  if (globalForLocal.__haichuangLocalDb) {
    return globalForLocal.__haichuangLocalDb;
  }

  const db = drizzle(getLocalClient(), { schema });
  globalForLocal.__haichuangLocalDb = db;
  return db;
}

/**
 * 确保本地数据库就绪：等 WASM 初始化完成，并把迁移跑到最新。
 *
 * 幂等且并发安全 —— 同一迁移版本共用挂在全局的 Promise。
 * 开发模式热更新新增迁移后，版本变化会排队重跑；普通 HMR 不重复迁移。
 */
export function ensureLocalDatabaseReady(): Promise<void> {
  const migrationTag = currentMigrationTag();
  if (
    globalForLocal.__haichuangLocalReady &&
    globalForLocal.__haichuangLocalMigrationTag === migrationTag
  ) {
    return globalForLocal.__haichuangLocalReady;
  }

  const previousReady = globalForLocal.__haichuangLocalReady;
  let failedClient: PGlite | undefined;
  const ready = (async () => {
    // 新迁移到来时等待上一次迁移结束，不能并发操作同一个 PGlite 实例。
    await previousReady?.catch(() => undefined);
    const client = getLocalClient();
    failedClient = client;
    await client.waitReady;
    await migrate(drizzle(client, { schema }), {
      migrationsFolder: resolveMigrationsFolder(),
    });
  })();

  globalForLocal.__haichuangLocalReady = ready;
  globalForLocal.__haichuangLocalMigrationTag = migrationTag;

  // 失败时清掉缓存的 Promise，否则一次失败会被永久记住，
  // 修好问题后连重启都救不回来（同一个进程内）。
  ready.catch(() => {
    if (globalForLocal.__haichuangLocalReady === ready) {
      globalForLocal.__haichuangLocalReady = undefined;
      globalForLocal.__haichuangLocalMigrationTag = undefined;
    }

    /**
     * 连带丢弃**实例本身**，只清 Promise 是不够的。
     *
     * `waitReady` 失败（WASM abort）的 PGlite 是个死对象：里面的 postgres
     * 已经停了，任何查询都直接报「PGlite failed to initialize properly」。
     * 若继续把它留在全局单例上，下一次请求拿到的还是它，于是错误被无限复现 ——
     * 哪怕数据目录的问题已经修好。关掉并置空，下一个请求才有机会建新实例。
     *
     * 同时 `close()` 一次，把数据目录上的锁和文件句柄放掉；失败本身就不再上抛了
     * （这里已经在错误路径上，再抛会变成 unhandled rejection）。
     */
    if (failedClient && globalForLocal.__haichuangLocalClient === failedClient) {
      globalForLocal.__haichuangLocalClient = undefined;
      globalForLocal.__haichuangLocalDb = undefined;
      void failedClient.close().catch(() => undefined);
    }
  });

  return ready;
}

/**
 * 关闭本地数据库。用于脚本与测试收尾，避免进程挂住不退出。
 * 应用运行期不需要调用。
 */
export async function closeLocalDb(): Promise<void> {
  const client = globalForLocal.__haichuangLocalClient;
  globalForLocal.__haichuangLocalClient = undefined;
  globalForLocal.__haichuangLocalDb = undefined;
  globalForLocal.__haichuangLocalReady = undefined;
  globalForLocal.__haichuangLocalMigrationTag = undefined;
  if (client) {
    await client.close();
  }
}
