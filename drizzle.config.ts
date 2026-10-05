import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit 配置
 *
 * 用法：
 *   pnpm db:generate   生成迁移 SQL（离线，不需要数据库连接）
 *   pnpm db:migrate    把迁移应用到数据库（需要 DATABASE_URL）
 *   pnpm db:check      校验 schema 与迁移是否一致
 *   pnpm db:studio     打开可视化数据浏览器
 *
 * 说明：drizzle-kit 不在 Next.js 运行时里，读不到 .env.local，
 * 因此这里用一个零依赖的简易解析器把 .env.local / .env 注入 process.env。
 */

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
      // 已存在的真实环境变量优先，便于 CI 覆盖
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

loadEnvFiles();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  strict: true,
  verbose: true,
  dbCredentials: {
    // generate / check 不需要真实连接；migrate 时若为空会立即报错，不会静默跳过
    url: process.env.DATABASE_URL ?? "",
  },
  migrations: {
    table: "__drizzle_migrations",
    schema: "drizzle",
  },
});
