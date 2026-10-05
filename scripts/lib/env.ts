/**
 * 脚本用环境变量加载器
 *
 * tsx / drizzle-kit 不在 Next.js 运行时里，读不到 `.env.local`。
 * 这里用一个零依赖的解析器把 `.env.local` / `.env` 注入 process.env，
 * 规则与 `drizzle.config.ts`、`vitest.config.mts` 保持一致：
 * 已存在的真实环境变量优先（便于 CI 覆盖）。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadFile(file: string): void {
  const filePath = resolve(process.cwd(), file);
  if (!existsSync(filePath)) {
    return;
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

loadFile(".env.local");
loadFile(".env");

export {};
