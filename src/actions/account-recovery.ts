"use server";

import { after } from "next/server";
import { emailField, resetPasswordSchema } from "@/schemas/auth";
import { fail, type Result } from "@/lib/result";
import { requestPasswordReset, resetAccountPassword } from "@/services/account-recovery.service";

function publicResult(result: Result<{ message: string }>): Result<{ message: string }> {
  return result.ok ? result : { ok: false, error: { ...result.error, detail: undefined } };
}

export async function forgotPasswordAction(form: FormData) {
  const email = emailField.safeParse(form.get("email"));
  if (!email.success) return fail("VALIDATION_FAILED", "请输入有效的邮箱。");
  return publicResult(await requestPasswordReset(email.data, (task) => after(task)));
}

export async function resetPasswordAction(form: FormData) {
  const input = resetPasswordSchema.safeParse({ token: form.get("token"), password: form.get("password") });
  if (!input.success) return fail("VALIDATION_FAILED", input.error.issues[0]?.message ?? "请核对输入。");
  return publicResult(await resetAccountPassword(input.data.token, input.data.password));
}
