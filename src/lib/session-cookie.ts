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
 * Secure 由服务端配置的 APP_ORIGIN 判定，不采信请求转发头。
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
