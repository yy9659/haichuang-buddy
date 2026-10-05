import type * as React from "react";

/**
 * 登录 / 注册页的独立外壳。
 *
 * 刻意放在 `(app)` 之外：`(app)/layout.tsx` 会去取「当前商家的品牌与老板分身」，
 * 而未登录时那些查询会（按设计）返回 UNAUTHORIZED —— 让登录页挂在它下面，
 * 会变成「未登录 → 渲染登录页 → 渲染失败 → 报错」，永远进不去。
 * 路由组 `(auth)` 不产生 URL 段，所以地址仍然是 `/login`、`/register`。
 *
 * `force-dynamic` 与 `(app)` 同因：这两页也要读请求里的会话 cookie
 * （已登录就直接跳走），因此同样不存在可预渲染的版本。
 * 让它们在构建期去查库，只会多一次「构建 worker 抢本地库锁」的机会。
 */
export const dynamic = "force-dynamic";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
