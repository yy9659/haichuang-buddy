import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * 数据库集成测试专用配置（`pnpm test:db`）
 *
 * 与主配置的差别只有三点，都是为了「跑在本地 PGlite 上」：
 *
 * 1. **只收 `src/repositories/db/**`** —— 这组用例慢（要建库跑迁移），
 *    不该混进日常 `pnpm test` 的快速反馈里。
 * 2. **强制 `DATA_SOURCE=local`** —— 覆盖 `.env.local` 里的 `mock`。
 *    绝不能反过来：如果谁把它改成 `db`，测试就会去打远程库。
 * 3. **关闭文件级并行** —— PGlite 是单进程 WASM 引擎，多个测试文件同时
 *    打开同一个数据目录会互相踩。串行执行同时也保证「上一个文件清干净了，
 *    下一个文件才能认定库是空的」（用例就是这么判断能否写数据的）。
 *
 * 数据目录用 `.data/pgdata-test`，与真实演示数据的 `.data/pgdata` 分开。
 */

for (const file of [".env.local", ".env"]) {
  const filePath = resolve(process.cwd(), file);
  if (!existsSync(filePath)) {
    continue;
  }
  const { readFileSync } = await import("node:fs");
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// 无条件覆盖：本配置存在的唯一目的就是跑本地库
process.env.DATA_SOURCE = "local";
process.env.LOCAL_DB_DIR = process.env.LOCAL_DB_DIR ?? ".data/pgdata-test";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/repositories/db/**/*.test.ts"],
    // PGlite 是单进程引擎，同一数据目录不能被并发打开
    fileParallelism: false,
    reporters: "default",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATA_SOURCE: "local",
      LOCAL_DB_DIR: process.env.LOCAL_DB_DIR,
    },
  },
  resolve: {
    alias: {
      "@": resolve(process.cwd(), "src"),
    },
  },
});
