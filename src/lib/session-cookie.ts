/**
 * 会话 cookie 的名字（**零 Node 依赖的纯模块**）
 *
 * 为什么从 `./session` 拆出来：`./session` 要用 `node:crypto` 生成随机 token，
 * 而**中间件跑在 edge runtime**，那边没有 `node:crypto`。中间件只需要知道
 * 「cookie 叫什么」（用来判断请求带没带会话），却因为同一个 import 被拖进
 * 一个跑不起来的运行时 —— 拆开之后，中间件只依赖这个纯模块。
 *
 * ## 为什么生产要加 `__Host-` 前缀
 *
 * 这是浏览器**强制**的加固：带该前缀的 cookie 必须同时满足
 * `Secure + Path=/ + 无 Domain`，否则浏览器直接丢弃。好处是子域名无法覆盖它 ——
 * 否则 `evil.example.com` 能往 `.example.com` 写一个同名 cookie，
 * 造成「会话固定」（session fixation）。
 *
 * 代价：**只允许 HTTPS**。本地开发是 http，浏览器会丢掉带前缀的 cookie，
 * 表现为「登录成功但立刻又退回登录页」，极难排查。所以判据是
 * `isSecureContext()`：**这次请求到底是不是 HTTPS**，而不是 `NODE_ENV`。
 */

export const SESSION_COOKIE_NAME_PROD = "__Host-haichuang_session";
export const SESSION_COOKIE_NAME_DEV = "haichuang_session";

/**
 * 两个可能的 cookie 名。
 *
 * 给中间件用：它只知道「请求带没带会话」，却不该复制一份「该用哪个名字」的
 * 判断逻辑（复制就会漂，而漂出来的表现是「登录了但中间件看不见」）。
 * 对中间件而言，两个名字里**任意一个**有值就等于「带了会话」。
 */
export const SESSION_COOKIE_NAMES: readonly string[] = [
  SESSION_COOKIE_NAME_DEV,
  SESSION_COOKIE_NAME_PROD,
];

/** 按「是否安全上下文」取 cookie 名 */
export function sessionCookieName(isSecureContext: boolean): string {
  return isSecureContext ? SESSION_COOKIE_NAME_PROD : SESSION_COOKIE_NAME_DEV;
}

/**
 * 判断当前是不是**安全上下文**（HTTPS 或 localhost）。
 *
 * 这是「该用哪个 cookie 名」的唯一判据，刻意不用 `NODE_ENV` ——
 * 两者不等价，而且差的那一格恰恰是最容易踩的：
 *
 * | 场景 | NODE_ENV | 实际协议 | 用 `__Host-` 会怎样 |
 * | ---- | -------- | -------- | ------------------- |
 * | `pnpm dev` | development | http | 名字本来就是 dev 名，没影响 |
 * | `pnpm start`（本地跑生产构建） | **production** | http | 浏览器直接丢弃 → 「登录成功却立刻退回登录页」 |
 * | 线上部署 | production | https | 正确，这正是它存在的意义 |
 *
 * 所以判据必须是「这次请求到底是不是 HTTPS」：优先信反向代理给的
 * `x-forwarded-proto`，本地直连按 host 判断。注意 localhost 在浏览器规范里
 * 属于安全上下文，但**cookie 的 `Secure` 属性与之无关** —— `__Host-` 要求的是
 * 传输层是 HTTPS，所以本地 http 只能退回 dev 名。
 */
export function isSecureContext(input: {
  forwardedProto?: string | null;
  host?: string | null;
  nodeEnv?: string | undefined;
}): boolean {
  const proto = input.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (proto) {
    return proto === "https";
  }

  const host = (input.host ?? "").toLowerCase();
  // 本地直连（dev / next start）一律按 http 处理，避免下一代名导致 cookie 被丢
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    return false;
  }

  return input.nodeEnv === "production";
}
