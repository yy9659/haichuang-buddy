/**
 * 路由守卫（Next.js 16 的 `proxy` 约定，旧名 `middleware`）
 *
 * 关于文件名：Next.js 16 把 `middleware.ts` 更名为 `proxy.ts`，导出的函数也从
 * `middleware` 改成 `proxy`（语义不变，只是澄清「它是应用前面的一层网络代理」，
 * 而不是 Express 那种中间件）。沿用旧名字仍能跑，但每次启动都会打一条弃用警告。
 *
 * ## 它做什么 / 不做什么
 *
 * 只做一件事：**没带会话 cookie 就不许进业务页面**，并顺手把「你原本要去哪」
 * 记进 `?next=`，登录后能直接跳回去。
 *
 * 它**不做**会话有效性校验 —— 这一层跑在 edge runtime，连不上数据库，
 * 只能看到「cookie 在不在」。真正的校验在 `(app)/layout.tsx`
 * （服务端、能查 `sessions` 表）。两层各司其职：
 * 这一层负责把绝大多数「压根没登录」的请求在**渲染之前**就挡掉（省一次 RSC 渲染），
 * 布局负责兜住「cookie 在但会话已失效 / 被伪造」。
 *
 * ## 为什么是「默认拒绝」而不是列白名单
 *
 * 早期实现习惯列一串受保护路径（/dashboard、/products…）。问题在于：
 * 将来新增一个页面，忘了往列表里加，那个页面就是**公开**的 —— 而且不报错。
 * 反过来写「只有登录/注册是公开的，其余全部要登录」，新增页面默认是安全的，
 * 漏配的代价从「数据泄漏」降级为「用户被多挡了一次」。
 */

import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAMES } from "@/lib/session-cookie";

/** 不需要登录即可访问的路径（精确匹配） */
const PUBLIC_PATHS = new Set(["/login", "/register"]);

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  // 搜索接口自行校验完整会话，并返回 JSON 401，避免弹出登录页 HTML。
  if (pathname === "/api/search") return NextResponse.next();

  /**
   * 两个可能的 cookie 名都看。
   *
   * 「该用哪个名字（`__Host-` 还是普通名）」取决于这次请求是不是 HTTPS，
   * 判据在 `@/lib/session-cookie` 的 `isSecureContext()`。这一层**不复制那份判断**：
   * 复制就会漂，而漂的表现是「已经登录了，却被说成没登录」——
   * 用户看到自己刚登录就被踢回登录页。对这里来说，
   * 任意一个名字有值就等于「带了会话」，剩下的交给能做真实校验的布局层。
   */
  const hasSessionCookie = SESSION_COOKIE_NAMES.some((name) =>
    Boolean(request.cookies.get(name)?.value),
  );
  if (hasSessionCookie) {
    return NextResponse.next();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);

  return NextResponse.redirect(loginUrl);
}

export const config = {
  /**
   * 排除静态资源与图片优化端点：它们不需要登录，也不该被重定向到登录页
   * （否则页面样式与图片会一起 302，表现为「白屏但 URL 变成了 /login」）。
   */
  matcher: [
    "/((?!_next/static|_next/image|assets/|favicon.ico|.*\\.(?:svg|png|jpe?g|gif|webp|avif|ico|txt|xml|json|webmanifest|mp4|webm)$).*)",
  ],
};
