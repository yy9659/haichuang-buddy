"use server";

/**
 * 登录 / 注册 / 退出的 Server Actions
 *
 * 为什么用 Server Actions 而不是 API Route：
 * - 写会话 cookie 需要在**同一次请求**里完成「落库 + 下发 cookie」，
 *   分成两个接口就会出现「会话建好了但 cookie 没写上」的中间态；
 * - 可以复用 `src/schemas` 与 `src/services`，不需要在客户端重复一套校验。
 *
 * 约束：本文件只做「解析入参 → 调服务 → 写 cookie → 失效缓存」，
 * 不含业务规则（业务规则在 service / repository）。
 *
 * 为什么 cookie 读写在这里而不是服务层：Next.js 只允许在 Server Action /
 * Route Handler 里写 cookie。服务层因此只返回明文 token（见 `auth.service`）。
 */

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { fail, type Result } from "@/lib/result";
import { resolveSessionCookiePolicy } from "@/lib/session";
import { isAdminEmail } from "@/lib/admin";
import { resolveRoleRedirect } from "@/lib/auth-redirect";
import { getServerEnv } from "@/lib/env";
import { loginSchema, registerSchema } from "@/schemas/auth";
import { login, logout, register, type AuthUserView } from "@/services/auth.service";

type AuthActionUserView = AuthUserView & { redirectTo: string };
function authActionView(user: AuthUserView, formData: FormData): AuthActionUserView {
  return { ...user, redirectTo: resolveRoleRedirect(readField(formData, "next"), isAdminEmail(user.email, getServerEnv().ADMIN_EMAILS)) };
}

function readField(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * 写入会话 cookie。
 *
 * - `httpOnly`：JS 读不到，XSS 也偷不走会话；
 * - `sameSite: "lax"`：跨站 POST 不带 cookie（挡住 CSRF），
 *   同时不影响「从外部链接点进来」这种正常导航；
 * - `secure` / cookie 名由 `resolveSessionCookiePolicy()` 统一决定：
 *   生产 HTTPS 用 `__Host-` 前缀（浏览器强制 Secure + Path=/ + 无 Domain，
 *   子域名无法覆盖），本地 http 退回普通名字 ——
 *   否则浏览器会直接丢弃那条 cookie，表现为「登录成功但立刻退回登录页」；
 * - `expires` 用会话的到期时间：与库里的 `expires_at` 同源，
 *   真伪判定仍以数据库为准（cookie 是存在用户机器上的，可以随便改）。
 */
async function writeSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const { name, secure } = await resolveSessionCookiePolicy();
  const store = await cookies();
  store.set(name, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: expiresAt,
  });
}

/** 登录态变化后，整个应用的布局（顶栏用户名 / 头像）都要重算 */
function revalidateAuthSurfaces(): void {
  revalidatePath("/", "layout");
}

/** 注册并直接登录 */
export async function registerAction(
  formData: FormData,
): Promise<Result<AuthActionUserView>> {
  const parsed = registerSchema.safeParse({
    email: readField(formData, "email"),
    name: readField(formData, "name"),
    password: readField(formData, "password"),
  });

  if (!parsed.success) {
    // 只回第一条：表单一次只该指一个错，列一长串反而没人看
    const first = parsed.error.issues[0];
    return fail("VALIDATION_FAILED", first?.message ?? "请检查填写内容");
  }

  const result = await register(parsed.data);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  await writeSessionCookie(result.data.token, result.data.expiresAt);
  revalidateAuthSurfaces();

  return { ok: true, data: authActionView(result.data.user, formData) };
}

/** 登录 */
export async function loginAction(
  formData: FormData,
): Promise<Result<AuthActionUserView>> {
  const parsed = loginSchema.safeParse({
    email: readField(formData, "email"),
    password: readField(formData, "password"),
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail("VALIDATION_FAILED", first?.message ?? "请检查填写内容");
  }

  const result = await login(parsed.data);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  await writeSessionCookie(result.data.token, result.data.expiresAt);
  revalidateAuthSurfaces();

  return { ok: true, data: authActionView(result.data.user, formData) };
}

/**
 * 退出登录。
 *
 * 无论服务端删会话成功与否，都清掉本地 cookie —— 否则「删库失败」
 * 会让用户卡在「点了退出但还是登录着」的状态里，比残留一条待过期的
 * 会话记录糟糕得多（那条记录会自己过期）。
 */
export async function logoutAction(): Promise<Result<{ signedOut: boolean }>> {
  const { name } = await resolveSessionCookiePolicy();
  const store = await cookies();
  const token = store.get(name)?.value ?? null;

  const result = await logout(token);
  store.delete(name);
  revalidateAuthSurfaces();

  if (!result.ok) {
    return result;
  }
  return { ok: true, data: { signedOut: true } };
}
