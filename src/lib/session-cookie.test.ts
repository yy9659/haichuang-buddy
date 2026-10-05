/**
 * 会话 cookie 名策略的单元测试
 *
 * 这些用例锁的是一个**很容易被"顺手改回去"的决定**：cookie 名不能按
 * `NODE_ENV` 选。原因见 `isSecureContext` 的注释 ——
 * `pnpm start` 本地跑生产构建时 NODE_ENV=production 但协议是 http，
 * 用 `__Host-` 前缀会被浏览器直接丢弃，表现为「登录成功却立刻退回登录页」。
 */

import { describe, expect, it } from "vitest";

import {
  isSecureContext,
  SESSION_COOKIE_NAME_DEV,
  SESSION_COOKIE_NAME_PROD,
  SESSION_COOKIE_NAMES,
  sessionCookieName,
} from "./session-cookie";

describe("sessionCookieName", () => {
  it("安全上下文用 __Host- 前缀，否则用普通名字", () => {
    expect(sessionCookieName(true)).toBe(SESSION_COOKIE_NAME_PROD);
    expect(sessionCookieName(false)).toBe(SESSION_COOKIE_NAME_DEV);
  });

  it("两个名字都在 SESSION_COOKIE_NAMES 里（中间件靠它判断请求带没带会话）", () => {
    expect(SESSION_COOKIE_NAMES).toContain(SESSION_COOKIE_NAME_DEV);
    expect(SESSION_COOKIE_NAMES).toContain(SESSION_COOKIE_NAME_PROD);
  });
});

describe("isSecureContext", () => {
  it("x-forwarded-proto 优先于其它一切证据", () => {
    expect(
      isSecureContext({
        forwardedProto: "https",
        host: "example.com",
        nodeEnv: "development",
      }),
    ).toBe(true);
    expect(
      isSecureContext({
        forwardedProto: "http",
        host: "example.com",
        nodeEnv: "production",
      }),
    ).toBe(false);
  });

  it("代理链只取第一跳（x-forwarded-proto 可能是逗号分隔的列表）", () => {
    expect(isSecureContext({ forwardedProto: "https, http" })).toBe(true);
    expect(isSecureContext({ forwardedProto: "http, https" })).toBe(false);
  });

  it("本地直连一律按非安全上下文处理（dev 与 next start 都是 http）", () => {
    for (const host of ["localhost", "localhost:3000", "127.0.0.1:8080", "[::1]:1"]) {
      expect(isSecureContext({ host, nodeEnv: "production" })).toBe(false);
    }
  });

  it("没有代理头、也不是本地：按 NODE_ENV 兜底", () => {
    expect(
      isSecureContext({ host: "haichuang.example.com", nodeEnv: "production" }),
    ).toBe(true);
    expect(
      isSecureContext({ host: "haichuang.example.com", nodeEnv: "development" }),
    ).toBe(false);
  });

  it("什么线索都没有时，只有 production 视为安全", () => {
    expect(isSecureContext({ nodeEnv: "production" })).toBe(true);
    expect(isSecureContext({ nodeEnv: "development" })).toBe(false);
    expect(isSecureContext({})).toBe(false);
  });
});
