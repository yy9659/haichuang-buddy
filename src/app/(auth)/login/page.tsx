import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth/auth-form";
import { AuthVideoShell } from "@/components/auth/auth-video-shell";
import { resolveRoleRedirect, sanitizeNextPath } from "@/lib/auth-redirect";
import { isAdminEmail } from "@/lib/admin";
import { getServerEnv } from "@/lib/env";
import { getCurrentAuthUser } from "@/services/auth.service";

export const metadata: Metadata = {
  title: "登录 · 海创Buddy",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const nextPath = sanitizeNextPath(params.next);

  // 已登录就别再让 TA 看登录页了
  const user = await getCurrentAuthUser();
  if (user) {
    redirect(resolveRoleRedirect(nextPath, isAdminEmail(user.email, getServerEnv().ADMIN_EMAILS)));
  }

  return (
    <AuthVideoShell
      title="欢迎回来"
      description="登录后继续经营你的海产生意。"
    >
      <AuthForm mode="login" nextPath={nextPath} />
    </AuthVideoShell>
  );
}
