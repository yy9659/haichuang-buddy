"use client";

/**
 * 登录 / 注册表单（客户端）
 *
 * 为什么用「提交处理函数 + useTransition」而不是 `useActionState`：
 * 成功之后要做**客户端跳转**（`router.replace`），并且要在跳转前把
 * 「下一个地址」`nextPath` 带上 —— 用 `useActionState` 的话这部分要么
 * 塞进 state、要么在 effect 里监听，比直接写清楚更绕。
 *
 * 表单值用非受控（`defaultValue` + FormData）：密码框不需要每次输入都
 * 触发 React 重渲染，也顺带避免了「受控密码框在自动填充时拿不到值」这个老问题。
 */

import { ArrowRight, Loader2, Lock, Mail, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { loginAction, registerAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN_LENGTH } from "@/schemas/auth";

export interface AuthFormProps {
  mode: "login" | "register";
  /** 登录 / 注册成功后的落地路径（已由服务端校验为站内路径） */
  nextPath: string;
}

export function AuthForm({ mode, nextPath }: AuthFormProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const isRegister = mode === "register";
  const glassInputClass =
    "border-white/25 bg-white/15 pl-8 text-white placeholder:text-white/60 focus-visible:border-white/70 focus-visible:bg-white/20 focus-visible:ring-white/25";

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 在异步提交前读取表单，固定本次提交的输入。
    const formData = new FormData(event.currentTarget);
    formData.set("next", nextPath);
    setError(null);

    startTransition(async () => {
      const result = isRegister
        ? await registerAction(formData)
        : await loginAction(formData);

      if (!result.ok) {
        setError(result.error.message);
        return;
      }

      // 会话 cookie 已在 Action 里写好；replace 而不是 push，
      // 避免用户点「后退」回到表单再提交一次
      router.replace(result.data.redirectTo);
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {isRegister ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name" className="text-white">你的称呼</Label>
          <div className="relative">
            <UserRound className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-white/70" />
            <Input
              id="name"
              name="name"
              autoComplete="name"
              placeholder="例如：陈老板"
              required
              maxLength={32}
              className={glassInputClass}
            />
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email" className="text-white">邮箱</Label>
        <div className="relative">
          <Mail className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-white/70" />
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
            className={glassInputClass}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password" className="text-white">密码</Label>
        <div className="relative">
          <Lock className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-white/70" />
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={isRegister ? "new-password" : "current-password"}
            placeholder={isRegister ? `至少 ${PASSWORD_MIN_LENGTH} 位` : "输入密码"}
            required
            className={glassInputClass}
          />
        </div>
        {isRegister ? (
          <p className="text-[11px] text-white/70">
            密码至少 {PASSWORD_MIN_LENGTH} 位。系统只保存加盐哈希，无法反推原文。
          </p>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-200/30 bg-rose-500/20 px-3 py-2 text-[12px] leading-5 text-white"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} className="mt-1 w-full">
        {pending ? (
          <>
            <Loader2 className="animate-spin" />
            {isRegister ? "正在创建账号…" : "正在登录…"}
          </>
        ) : (
          <>
            {isRegister ? "创建账号并进入" : "登录"}
            <ArrowRight />
          </>
        )}
      </Button>

      <p className="text-center text-[12px] text-white/80">
        {isRegister ? "已经有账号了？" : "还没有账号？"}
        <Link
          href={
            isRegister
              ? `/login${nextPath === "/dashboard" ? "" : `?next=${encodeURIComponent(nextPath)}`}`
              : `/register${nextPath === "/dashboard" ? "" : `?next=${encodeURIComponent(nextPath)}`}`
          }
          className="ml-1 font-medium text-white underline-offset-4 hover:underline"
        >
          {isRegister ? "去登录" : "免费注册"}
        </Link>
      </p>
    </form>
  );
}
