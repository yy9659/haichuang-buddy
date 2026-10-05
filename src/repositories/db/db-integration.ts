/**
 * 数据库集成测试的开关与前置准备。
 *
 * 三个 `*.repository.test.ts` 需要**一个真实可写的 PostgreSQL** 才能验证
 * 那些 Mock 实现模拟不出来的行为：外键级联、事务回滚、唯一键冲突、
 * `jsonb` / `text[]` 的往返、以及向量检索的排序。
 *
 * 两种方式都算「有库可测」：
 *
 * | 方式 | 怎么开 | 打哪里 |
 * | ---- | ------ | ------ |
 * | 远程 | `.env.local` 配 `DATABASE_URL` | Supabase PostgreSQL（CI / 部署前验证） |
 * | 本地 | `pnpm test:db` | 本地 PGlite，数据落在 `.data/pgdata-test`（默认） |
 *
 * 本地这条路是 S7 引入 PGlite 之后才成立的：在此之前，没有 Supabase 凭证的
 * 环境里这 54 个用例**全部跳过**，等于数据库仓储长期没有回归保护。
 * 现在它们能在完全离线、零账号的前提下跑起来。
 *
 * 注意：用例要求「库中原本没有任何商家」才会执行写操作（见各文件顶部说明），
 * 因此本地模式必须用**独立的测试数据目录**，不能复用 `.data/pgdata` ——
 * 那里是真实演示数据，测试不该去动它。
 */

import { describe } from "vitest";

/** 是否具备可用的数据库（远程或本地） */
export function isDbIntegrationEnabled(): boolean {
  return (
    Boolean(process.env.DATABASE_URL) || process.env.DATA_SOURCE === "local"
  );
}

/**
 * 测试套件分组开关。
 *
 * 没有库时**整组跳过**而不是失败 —— 缺一个本地数据库不该让
 * `pnpm test` 在纯前端环境下整体变红。
 */
export const describeDbSuite = isDbIntegrationEnabled()
  ? describe
  : describe.skip;

/**
 * 前置准备：本地模式下把迁移跑到最新。
 *
 * 必须在任何查询之前调用（各文件的 `beforeAll` 第一行）。
 * 远程模式下是空操作 —— 迁移由 `pnpm db:migrate` 人工负责，
 * 测试不该擅自改动远程库的结构。
 */
export async function prepareDbForTests(): Promise<void> {
  if (process.env.DATA_SOURCE !== "local") {
    return;
  }
  const { ensureLocalDatabaseReady } = await import("@/db/local");
  await ensureLocalDatabaseReady();
}
