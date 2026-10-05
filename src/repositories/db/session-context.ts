/**
 * 请求级会话上下文（S7）—— 多租户隔离的**唯一枢纽**
 *
 * ## 它解决什么问题
 *
 * 在此之前，「当前商家」的答案是 `findPrimaryBusinessIdOrNull()`：
 * **库里最早创建的那条商家记录**。单商家 Demo 下永远正确，
 * 但一旦有第二个账号注册进来，两个人就会共用同一份数据 —— 而且是静默共用，
 * 页面上没有任何迹象。
 *
 * 逐个仓储去加 `businessId` 参数要改十几处读写路径，漏一处就是一次数据泄漏，
 * 且不会报错。所以口径统一收在这里：**仓储问「当前商家」，由本模块回答**。
 * 换句话说是把「多租户」这件事从「每个仓储各自记得过滤」变成了
 * 「一个函数记得」——后者才有机会被测试覆盖。
 *
 * ## 三种情形，必须分得清
 *
 * | 情形 | 答案 |
 * | ---- | ---- |
 * | 在请求里，且带了有效会话 | 该账号所属的 `businessId` |
 * | 在请求里，但没有/无效会话 | **null**（绝不回落到「最早的商家」） |
 * | 不在请求里（脚本、测试、CRON） | 回落到「最早的商家」，保持脚本可用 |
 *
 * 第二行是安全底线：如果没登录也回落到第一条商家的数据，那么
 * 「中间件漏配一个路径」就等于「所有人都能读第一个租户的数据」。
 *
 * ## 为什么走仓储而不是直接查库
 *
 * 最初的实现直接 `getDb().select()...`，结果 `DATA_SOURCE=mock` 下
 * `getDb()` 会明确抛错（见 `@/db/gateway`）—— 于是「mock 模式能不能登录」
 * 变成了一个和本模块无关的实现细节泄漏。改走
 * `repositories.sessions.findValidByTokenHash()` 之后，本地 PGlite、
 * 远程 Postgres、内存 Mock 三种数据源共用同一条路径。
 *
 * ## 为什么可以放在仓储层
 *
 * 它读 cookie、又读数据，看起来「哪一层都不太像」。但它是**仓储内部**
 * 「当前商家是谁」这一问的实现细节，放在这里才不需要 service / 仓储互相 import。
 * 它不返回任何业务数据，只返回一个 id —— 出不了这个边界。
 */

import { cache } from "react";

import { cookies } from "next/headers";

import { hashSessionToken, resolveSessionCookiePolicy } from "@/lib/session";

export interface RequestSessionContext {
  kind: "request";
  /** 有效会话所属商家；无有效会话时为 null */
  businessId: string | null;
  userId: string | null;
  sessionId: string | null;
  /** cookie 里带着的 token 哈希；无有效会话时为 null */
  tokenHash: string | null;
}

export interface NoRequestContext {
  kind: "no-request";
}

export type SessionContext = RequestSessionContext | NoRequestContext;

/** 请求内但会话无效（或压根没带）时的空上下文 */
function emptyRequestContext(): RequestSessionContext {
  return {
    kind: "request",
    businessId: null,
    userId: null,
    sessionId: null,
    tokenHash: null,
  };
}

/**
 * 读出本请求的会话上下文。
 *
 * 用 React 的 `cache()` 包一层：一次页面渲染里仓储会被调用几十次
 * （每个列表、每个统计各一次），不缓存就会打几十次
 * `sessions ⋈ users`。`cache()` 的作用域正好是「一次请求」，
 * 比手工挂全局变量安全得多 —— 后者在并发请求之间会串数据。
 */
export const getSessionContext = cache(
  async (): Promise<SessionContext> => {
    let token: string | undefined;

    try {
      const store = await cookies();
      // cookie 名与「写 cookie」的 Action 走同一个策略（见 resolveSessionCookiePolicy）
      const { name } = await resolveSessionCookiePolicy();
      token = store.get(name)?.value;
    } catch {
      /**
       * `cookies()` 在请求作用域之外会抛错 —— 脚本（`pnpm db:seed`）、
       * vitest 里就是这种情况。这不是异常，而是「没有请求」的正常信号。
       */
      return { kind: "no-request" };
    }

    if (!token) {
      return emptyRequestContext();
    }

    const tokenHash = hashSessionToken(token);

    /**
     * 延迟 import：`@/repositories` → `./db` → `./shared` → 本模块，
     * 顶层 import 会形成模块初始化环。放进函数体后，环在运行期自然解开。
     */
    const { getRepositories } = await import("@/repositories");
    const session = await getRepositories().sessions.findValidByTokenHash(tokenHash);

    if (!session) {
      return emptyRequestContext();
    }

    return {
      kind: "request",
      // 理论上会话的 businessId 一定有值；用 `|| null` 兜住老数据里的空串
      businessId: session.businessId || null,
      userId: session.userId,
      sessionId: session.id,
      tokenHash,
    };
  },
);
