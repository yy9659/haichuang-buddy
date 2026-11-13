import { headers } from "next/headers";
import { getServerEnv } from "@/lib/env";
import { sha256Hex } from "@/lib/hash";
import { configuredAppOrigin, trustedClientSource } from "@/lib/public-security";
import { AppError } from "@/lib/result";
import { takeRateSlot } from "@/repositories/db/security.repository";

const limits = {
  login: { source: 40, account: 8, seconds: 900 },
  register: { source: 12, account: 5, seconds: 3600 },
  forgot: { source: 15, account: 4, seconds: 3600 },
  reset: { source: 15, account: 5, seconds: 1800 },
} as const;

export async function enforceAuthLimit(kind: keyof typeof limits, account: string, requestHeaders?: Pick<Headers, "get">) {
  const env = getServerEnv();
  // In-memory demonstration is not a public account backend.
  if (env.DATA_SOURCE === "mock") {
    const host = configuredAppOrigin()?.hostname;
    if (process.env.NODE_ENV !== "production" && host &&
        ["localhost", "127.0.0.1", "[::1]"].includes(host) && (kind === "login" || kind === "register")) return;
    throw new AppError({ code: "VALIDATION_FAILED", message: "此功能需要持久化账号数据库。" });
  }
  const source = trustedClientSource(requestHeaders ?? await headers(), env.TRUSTED_PROXY_SECRET);
  const rule = limits[kind];
  for (const [dimension, value, limit] of [
    ["source", source, rule.source], ["account", account, rule.account],
  ] as const) {
    const wait = await takeRateSlot(kind + ":" + dimension + ":" + sha256Hex(value), limit, rule.seconds);
    if (wait) throw new AppError({
      code: "RATE_LIMITED", message: `操作过于频繁，请在 ${Math.ceil(wait / 60)} 分钟后重试。`, retryAfterSeconds: wait,
    });
  }
}
