/**
 * 本地比赛演示环境一键重置。
 *
 * 只允许删除项目 `.data` 目录里的 PGlite 数据目录；远程数据库、项目根目录、
 * 自定义到项目外的路径都会被拒绝。运行前请先停止 `next dev`，避免数据库文件锁定。
 */

import "./lib/env";

import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEMO_EMAIL = "demo@haichuang.local";
const DEMO_PASSWORD = "Haichuang2026!";

function fail(message: string): never {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

/** 只接受项目 `.data` 下的非根目录，防止配置错误扩大删除范围。 */
export function resolveSafeLocalDatabaseDir(input: {
  workspace: string;
  configured: string;
}): string {
  const workspace = path.resolve(input.workspace);
  const dataRoot = path.resolve(workspace, ".data");
  const databaseDir = path.isAbsolute(input.configured)
    ? path.resolve(input.configured)
    : path.resolve(workspace, input.configured);
  const relative = path.relative(dataRoot, databaseDir);

  if (
    databaseDir === dataRoot ||
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `拒绝删除不安全的数据目录：${databaseDir}。目录必须位于 ${dataRoot} 内。`,
    );
  }
  return databaseDir;
}

export async function resetLocalDemo(): Promise<void> {
  if ((process.env.DATA_SOURCE ?? "local").trim() !== "local") {
    throw new Error(
      "demo:reset 只允许在 DATA_SOURCE=local 时运行，不会触碰远程数据库。",
    );
  }

  const workspace = path.resolve(process.cwd());
  const configured = process.env.LOCAL_DB_DIR?.trim() || ".data/pgdata";
  const databaseDir = resolveSafeLocalDatabaseDir({ workspace, configured });

  process.stdout.write(`重置本地演示库：${databaseDir}\n`);
  try {
    rmSync(databaseDir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `无法清理本地数据库（请先停止开发服务器）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  process.env.DATA_SOURCE = "local";
  process.env.AI_PROVIDER = "mock";
  const { resetServerEnvCache } = await import("../src/lib/env");
  resetServerEnvCache();
  const { closeDb } = await import("../src/db");

  try {
    /**
     * 删掉数据目录后本地库是一个全新的空集群，迁移必须在这里补上。
     *
     * 为什么不靠 `pnpm db:migrate`：那条命令走 `DATABASE_URL`（远程 Supabase
     * 路径），指不到本地 PGlite。本地迁移平时只在 dev server 启动时由
     * `src/instrumentation.ts` 调用 `ensureLocalDatabaseReady()` 跑，
     * 而重置场景下不能要求用户先去启一次服务 —— 顺序会变成
     * 「删库 → 启动迁移 → 再 seed」，那 seed 又要等第二次停服务。
     */
    const { ensureLocalDatabaseReady } = await import("../src/db/local");
    await ensureLocalDatabaseReady();

    const { seedDemoData } = await import("./seed");
    await seedDemoData();

    // seed 先创建无主演示商家；首个账号会通过正式注册服务安全认领它。
    const { register } = await import("../src/services/auth.service");
    const registered = await register({
      email: DEMO_EMAIL,
      name: "海创演示账号",
      password: DEMO_PASSWORD,
    });
    if (!registered.ok) {
      throw new Error(`演示账号创建失败：${registered.error.message}`);
    }
  } finally {
    await closeDb();
  }

  process.stdout.write("\n✓ 演示环境已恢复\n");
  process.stdout.write(`  登录邮箱：${DEMO_EMAIL}\n`);
  process.stdout.write(`  登录密码：${DEMO_PASSWORD}\n`);
  process.stdout.write("  启动命令：pnpm dev\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = path.resolve(fileURLToPath(import.meta.url));

if (invokedPath.toLowerCase() === currentPath.toLowerCase()) {
  resetLocalDemo().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
