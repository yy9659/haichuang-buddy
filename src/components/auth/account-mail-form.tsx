"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { forgotPasswordAction, resetPasswordAction } from "@/actions/account-recovery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN_LENGTH } from "@/schemas/auth";
import { useLinkToken } from "./use-link-token";

export function AccountMailForm({ mode }: { mode: "forgot" | "reset" }) {
  const [token, setToken] = useLinkToken(mode === "reset");
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [pending, start] = useTransition();
  const action = mode === "forgot" ? forgotPasswordAction : resetPasswordAction;
  return <form method="post" className="flex max-w-md flex-col gap-4 text-white" onSubmit={(event) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    start(async () => {
      try {
        const result = await action(fields);
        setSuccess(result.ok);
        setMessage(result.ok ? result.data.message : result.error.message);
        if (result.ok && mode === "reset") setToken("");
      } catch {
        setMessage("操作未完成，请稍后重试。");
      }
    });
  }}>
    {!(success && mode === "reset") && <>
      {mode === "reset" ? <>
        <Label htmlFor="reset-token">重设凭据</Label>
        <Input id="reset-token" name="token" type="password" value={token} onChange={(event) => setToken(event.target.value)} maxLength={43} required autoComplete="off" />
        <Label htmlFor="new-password">新密码</Label>
        <Input id="new-password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={128} required />
      </> : <>
        <Label htmlFor="account-email">账号邮箱</Label>
        <Input id="account-email" name="email" type="email" autoComplete="email" maxLength={254} required />
      </>}
      <Button type="submit" disabled={pending}>{pending ? "处理中…" : mode === "forgot" ? "申请重设" : "保存新密码"}</Button>
    </>}
    {message && <p role="status" className="text-sm">{message}</p>}
    <Link href="/login" className="text-sm underline">返回登录</Link>
  </form>;
}
