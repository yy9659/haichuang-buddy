/**
 * 本地数据库（PGlite）地基验收脚本
 *
 * 用法：
 *   pnpm tsx scripts/verify-local-db.ts           # 用 .data/pgdata（真实数据目录）
 *   LOCAL_DB_DIR=.data/pgdata-check pnpm tsx scripts/verify-local-db.ts   # 用临时目录，不碰真实数据
 *
 * 验收四件事：
 *   1. 库能建起来，8 个迁移全部跑通（不报错）
 *   2. 14 张业务表 + drizzle 迁移记录表都在
 *   3. 数据真的落在磁盘上（数据目录里有 PG_VERSION / pg_wal，是完整 PG 数据目录）
 *   4. **重启后数据仍在** —— 关掉客户端再开一个全新实例，刚写入的行还在
 *
 * 这是「本地持久化」这条路线成立与否的唯一硬证据：
 * 若第 4 步失败，方案就不成立，后面所有多用户隔离的工作都没有意义。
 */

import "./lib/env";

import fs from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import { ensureLocalDatabaseReady, resolveLocalDbDir } from "../src/db/local";
import { closeDb, executeSql } from "../src/db";

/** 迁移应当建出的全部业务表（顺序无关） */
const EXPECTED_TABLES = [
  "agent_tasks",
  "agent_workflows",
  "brand_profiles",
  "businesses",
  "contents",
  "customer_conversations",
  "customer_messages",
  "knowledge_chunks",
  "knowledge_documents",
  "knowledge_gaps",
  "owner_profiles",
  "product_dna",
  "products",
  "users",
] as const;

interface CheckResult {
  label: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(label: string, passed: boolean, detail: string): void {
  results.push({ label, passed, detail });
  console.log(`  ${passed ? "✅" : "❌"} ${label}${detail ? ` —— ${detail}` : ""}`);
}

async function listTables(schemaName = "public"): Promise<string[]> {
  const rows = await executeSql<{ table_name: string }>(
    sql`select table_name from information_schema.tables
        where table_schema = ${schemaName} and table_type = 'BASE TABLE'
        order by table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function main(): Promise<void> {
  console.log("===== 本地数据库（PGlite）地基验收 =====");
  console.log(`数据目录：${resolveLocalDbDir()}`);
  console.log(`数据源：${process.env.DATA_SOURCE ?? "(默认)"}\n`);

  if (process.env.DATA_SOURCE !== "local") {
    console.error(
      "❌ 本脚本必须在 DATA_SOURCE=local 下运行：\n   DATA_SOURCE=local pnpm tsx scripts/verify-local-db.ts",
    );
    process.exit(1);
  }

  // —— 1. 建库 + 跑迁移 ——
  console.log("[1] 建库并执行迁移");
  const startedAt = Date.now();
  try {
    await ensureLocalDatabaseReady();
    record("迁移执行完成", true, `${Date.now() - startedAt}ms`);
  } catch (error) {
    record(
      "迁移执行完成",
      false,
      error instanceof Error ? error.message : String(error),
    );
    console.error("\n迁移失败，后续检查跳过。");
    await closeDb();
    process.exit(1);
  }

  // —— 2. 表是否齐全 ——
  console.log("\n[2] 检查表结构");
  const tables = await listTables();
  const missing = EXPECTED_TABLES.filter((name) => !tables.includes(name));

  record(
    `业务表齐全（${EXPECTED_TABLES.length} 张）`,
    missing.length === 0,
    missing.length === 0
      ? `实际 ${tables.length} 张表`
      : `缺少：${missing.join("、")}`,
  );

  // 迁移记录表在 `drizzle` schema 下（见 drizzle.config.ts 的 migrations.schema）
  const drizzleTables = await listTables("drizzle");
  const hasMigrationTable = drizzleTables.includes("__drizzle_migrations");
  record(
    "迁移记录表存在（重复执行不会重跑）",
    hasMigrationTable,
    hasMigrationTable ? "drizzle.__drizzle_migrations" : "未找到",
  );

  // 记录已应用的迁移条数
  const applied = await executeSql<{ count: string }>(
    sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
  );
  const appliedCount = Number(applied[0]?.count ?? "0");
  record(
    "迁移数量已记录",
    appliedCount > 0,
    `已应用 ${appliedCount} 条`,
  );

  // —— 3. 数据是否真的落盘 ——
  console.log("\n[3] 检查磁盘数据目录");
  const dir = resolveLocalDbDir();
  const versionFile = path.join(dir, "PG_VERSION");
  const walDir = path.join(dir, "pg_wal");

  record(
    "数据目录含 PG_VERSION（是真正的 PostgreSQL 数据目录）",
    fs.existsSync(versionFile),
    fs.existsSync(versionFile)
      ? fs.readFileSync(versionFile, "utf8").trim()
      : "未找到",
  );
  record(
    "数据目录含 pg_wal（WAL 日志，写入先落盘）",
    fs.existsSync(walDir),
    fs.existsSync(walDir) ? "存在" : "未找到",
  );

  // —— 4. 重启后数据还在吗 ——
  console.log("\n[4] 持久化验证：关掉再开，数据是否还在");

  const probeName = `__persist_probe_${Date.now()}`;
  await executeSql(
    sql`create table if not exists ${sql.identifier(probeName)} (note text not null)`,
  );
  await executeSql(
    sql`insert into ${sql.identifier(probeName)} (note) values ('本地持久化探针')`,
  );
  record("写入探针数据", true, probeName);

  // 彻底关掉当前实例（模拟服务重启）
  await closeDb();

  // 重新打开数据目录：全局单例已被关闭清空，这一步等价于「进程重启后再连一次」
  await ensureLocalDatabaseReady();

  const rows = await executeSql<{ note: string }>(
    sql`select note from ${sql.identifier(probeName)}`,
  );
  const survived = rows.some((row) => row.note === "本地持久化探针");
  record(
    "关闭后重新打开，探针数据仍在",
    survived,
    survived ? "数据未丢失" : "数据丢失 —— 持久化不成立",
  );

  // 清理探针表
  await executeSql(
    sql`drop table if exists ${sql.identifier(probeName)}`,
  );
  record("清理探针表", true, "");

  // —— 汇总 ——
  const failed = results.filter((item) => !item.passed);
  console.log("\n===== 汇总 =====");
  console.log(
    `共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`,
  );

  await closeDb();

  if (failed.length > 0) {
    console.error("\n❌ 本地数据库地基验收未通过：");
    for (const item of failed) {
      console.error(`   · ${item.label} —— ${item.detail}`);
    }
    process.exit(1);
  }

  console.log(
    "\n✅ 本地数据库地基验收通过：建库、迁移、落盘、重启后保留全部成立。",
  );
}

void main().catch(async (error) => {
  console.error("\n脚本异常终止：", error);
  try {
    await closeDb();
  } catch {
    // 收尾失败不掩盖原始错误
  }
  process.exit(1);
});
