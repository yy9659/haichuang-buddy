/**
 * 登录后的落地路径（`?next=`）的净化
 *
 * 「登录成功后跳回你原本要去的页面」是标准体验，但 `next` 完全由用户控制，
 * 直接 `redirect(next)` 等于把本站变成一个**开放重定向**跳板：
 * `?next=https://evil.com` 会让人在「刚在海创Buddy登录过」的心理预期下
 * 落到钓鱼站，而地址栏确实出现过本站在先。
 *
 * 只接受**站内绝对路径**，并且显式挡掉三种绕法：
 * - `//evil.com`（协议相对 URL，浏览器会当成 https://evil.com）
 * - `/\evil.com`（反斜杠在多数浏览器里等价于 `/`）
 * - 任何不带前导 `/` 的值
 *
 * 中间件与页面都调它 —— 两边各写一份必然漂，而漂出来的是安全漏洞。
 */

/** 未指定 `next` 时的默认落地页 */
export const DEFAULT_AUTH_REDIRECT = "/dashboard";

export function sanitizeNextPath(
  value: string | string[] | undefined,
  fallback: string = DEFAULT_AUTH_REDIRECT,
): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return fallback;
  }
  return raw;
}

/** 登录落地按账号身份分流，管理员始终留在平台管理界面。 */
export function resolveRoleRedirect(value: string | string[] | undefined, isAdmin: boolean): string {
  const home = isAdmin ? "/admin" : DEFAULT_AUTH_REDIRECT;
  const safePath = sanitizeNextPath(value, home);
  const destination = new URL(safePath, "https://haichuang.invalid");
  const pathname = destination.pathname;
  if (["/", "/login", "/register"].includes(pathname)) return home;
  const adminPath = pathname === "/admin" || pathname.startsWith("/admin/");
  if (isAdmin !== adminPath) return home;
  return `${destination.pathname}${destination.search}${destination.hash}`;
}
