import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth/auth-form";
import { AuthVideoShell } from "@/components/auth/auth-video-shell";
import { resolveRoleRedirect, sanitizeNextPath } from "@/lib/auth-redirect";
import { isAdminEmail } from "@/lib/admin";
import { getServerEnv } from "@/lib/env";
import { getCurrentAuthUser } from "@/services/auth.service";

export const metadata: Metadata = {
  title: "注册 · 海创Buddy",
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const nextPath = sanitizeNextPath(params.next);

  const user = await getCurrentAuthUser();
  if (user) {
    redirect(resolveRoleRedirect(nextPath, isAdminEmail(user.email, getServerEnv().ADMIN_EMAILS)));
  }

  return (
    <AuthVideoShell
      title="创建你的账号"
      description="为你的店铺开启专属 AI 经营空间。"
    >
      <div className="flex flex-col gap-4">
        <AuthForm mode="register" nextPath={nextPath} />
        <p className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-[11px] leading-5 text-white/75">
          注册后可填写店铺资料、添加商品，并建立自己的知识库。
        </p>
      </div>
    </AuthVideoShell>
  );
}
