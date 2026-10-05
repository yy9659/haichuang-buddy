import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest 配置
 *
 * 覆盖范围：
 * - 纯函数（指标计算、时间格式化、id 工具、错误映射）
 * - 仓储契约（数据源切换、Mock 写操作）
 * - 数据库集成测试（src/repositories/db/*.test.ts）：本套件里**整组跳过**，
 *   它们归 `pnpm test:db`（见 vitest.db.config.mts）；只有配置了 DATABASE_URL
 *   时才在本套件中直接打远程库
 */

/** Vitest 不读 Next.js 的 .env.local，这里手动注入，使集成测试可用 */
function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    const filePath = resolve(process.cwd(), file);
    if (!existsSync(filePath)) {
      continue;
    }
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
}

loadEnvFiles();

/**
 * 主测试套件**固定跑 mock 数据源**。
 *
 * 为什么必须在这里写死，而不是「跟随 .env.local」：
 * 应用自身的开发态已经切成 `DATA_SOURCE=local`（本地 PGlite，数据落 .data/pgdata）。
 * 若测试跟随它，`pnpm test` 会连带把 `src/repositories/db/**` 的集成用例一起跑起来 ——
 * 而那组用例会**写入并删除商家记录**，落在**真实的演示数据目录**上。
 * 这不是理论风险：切换数据源后第一次跑 `pnpm test`，就出现了
 * 「测试往 .data/pgdata 里插商家、又被沙箱的 safe-delete 拦下」的连锁失败。
 *
 * 分工也因此更清楚：
 * - `pnpm test`    → 纯 mock 套件，快、零 IO、永远与数据源配置无关；
 * - `pnpm test:db` → 集成套件，由 `vitest.db.config.mts` 强制
 *   `DATA_SOURCE=local` 且指向**独立的** `.data/pgdata-test`。
 *
 * 远程校验（CI / 部署前打 Supabase）的路径仍然保留：只要配了 `DATABASE_URL`，
 * `describeDbSuite` 依旧会启用（见 `src/repositories/db/db-integration.ts`）。
 */
process.env.DATA_SOURCE = "mock";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    reporters: "default",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
