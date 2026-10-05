import type * as React from "react";

import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppContent } from "@/components/layout/app-content";
import { unwrapOrThrow } from "@/lib/result";
import { getShellView } from "@/services";
import { getCurrentAuthUser } from "@/services/auth.service";
import { isAdminEmail } from "@/lib/admin";
import { getServerEnv } from "@/lib/env";

/**
 * Dashboard 全局布局
 * 左侧统一 Sidebar + 顶部统一操作栏，所有业务页面共用。
 * 外壳数据（当前品牌 / 通知 / 用户）在服务端一次性取好，避免客户端各自请求。
 *
 * ## 这里是一道**必须**的授权闸门
 *
 * 中间件只能看「cookie 在不在」（edge runtime 连不上数据库）；一个过期、
 * 被注销、或者干脆是伪造的 cookie 会照样通过它。真正「这个 cookie 对应
 * 哪条未过期的会话」只能在服务端、能查库的地方回答 —— 就是这里。
 * 少了这一步，「退出登录后又点浏览器后退」就能看到上一个账号的数据。
 *
 * ## 为什么显式 `force-dynamic`
 *
 * 这一组页面**每一个都依赖请求**：要看请求里的会话 cookie 才知道「当前是谁」，
 * 未登录还要 `redirect` 走人。这种页面在原理上就不存在「预渲染」的版本 ——
 * 构建期没有任何请求可供解析。
 *
 * 不写这一行会发生什么（真实踩过）：`next build` 会把它们当成静态页尝试渲染，
 * 于是 15 个构建 worker **同时打开同一份本地 PGlite 库**去查商家档案，
 * 互相抢锁 → 查询失败 → 构建以「加载品牌档案失败」中断。
 * 失败信息指向的是数据库，而真正的原因在渲染模型选错了 ——
 * 这正是「一个页面能不能静态化」必须由页面的作者明确回答的原因。
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentAuthUser();
  if (!user) {
    redirect("/login");
  }

  const isAdmin = isAdminEmail(user.email, getServerEnv().ADMIN_EMAILS);
  if (isAdmin) redirect("/admin");
  const shell = unwrapOrThrow(await getShellView());

  return (
    <div className="flex min-h-screen bg-[#071c34]">
      <AppSidebar />
      <AppContent shell={shell} user={user}>{children}</AppContent>
    </div>
  );
}
