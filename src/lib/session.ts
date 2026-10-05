/**
 * 登录会话的原语（token 生成与哈希、有效期）
 *
 * ## 与 `./session-cookie` 的分工
 *
 * 「cookie 叫什么名字」在 `./session-cookie` —— 那是一个零 Node 依赖的纯模块，
 * 因为**中间件（edge runtime）也要读它**，而本文件依赖 `node:crypto`。
 * 这里转出那几个常量与函数，只是为了让既有的 `from "@/lib/session"` 调用方
 * 不必改 import。
 *
 * 本文件只有**纯函数与常量**，不碰数据库、不碰 `next/headers` ——
 * 因此它既能被服务层用，也能被任何服务端模块用。
 * 把 cookie 读写、会话落库这些副作用留在各自的层里。
 */

import { randomBytes } from "node:crypto";

import { sha256Hex } from "./hash";
import { isSecureContext, sessionCookieName } from "./session-cookie";

export {
  SESSION_COOKIE_NAME_DEV,
  SESSION_COOKIE_NAME_PROD,
  SESSION_COOKIE_NAMES,
  sessionCookieName,
} from "./session-cookie";

/**
 * 本次请求该用哪个会话 cookie 名，以及要不要加 `Secure`。
 *
 * 写 cookie（Server Action）与读 cookie（仓储层判断当前商家）**必须用同一个答案** ——
 * 两边各判断一次，只要判据有一丝不同，就会出现「写进去的名字读不出来」，
 * 表现成「登录成功但一刷新就退出登录」。所以判断只在这里做一次。
 *
 * 判据见 `@/lib/session-cookie` 的 `isSecureContext()`。
 */
export interface SessionCookiePolicy {
  name: string;
  /** 是否给 cookie 加 `Secure`（`__Host-` 前缀要求它必须为 true） */
  secure: boolean;
}

export async function resolveSessionCookiePolicy(): Promise<SessionCookiePolicy> {
  let forwardedProto: string | null = null;
  let host: string | null = null;

  try {
    const { headers } = await import("next/headers");
    const store = await headers();
    forwardedProto = store.get("x-forwarded-proto");
    host = store.get("host");
  } catch {
    // 无请求作用域（脚本 / 测试 / 构建期）：走下面的 NODE_ENV 兜底
  }

  const secure = isSecureContext({
    forwardedProto,
    host,
    nodeEnv: process.env.NODE_ENV,
  });

  return { name: sessionCookieName(secure), secure };
}

/**
 * 会话有效期（毫秒）—— 30 天。
 *
 * cookie 的 `maxAge` 与数据库里的 `expires_at` 用同一个值，但**判定以后者为准**：
 * cookie 存在用户的浏览器里，是可以随意改的，过期时间不能由它说了算。
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 生成会话 token（明文）。
 *
 * 32 字节 = 256 位随机量，由 `randomBytes`（CSPRNG）产生。
 * 明文 token 只在「写 cookie」这一处出现，随后立刻被哈希，
 * **数据库里只有哈希** —— 库被读走也无法直接拿去登录。
 */
export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** token → 入库用的哈希（复用 `@/lib/hash` 的 SHA-256，不另开一份实现） */
export function hashSessionToken(token: string): string {
  return sha256Hex(token);
}

/** 由「现在」推出会话到期时间 */
export function sessionExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}
