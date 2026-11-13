import { createSessionToken, hashSessionToken } from "@/lib/session";
import { AppError, attempt } from "@/lib/result";
import { hashPassword } from "@/lib/password";
import { consumePasswordReset, discardPasswordReset, insertPasswordReset } from "@/repositories/db/security.repository";
import { accountMailer } from "./account-mail.service";
import { enforceAuthLimit } from "./security-limits.service";

/** Schedule identical work from the public request, without waiting on lookup or delivery. */
export async function requestPasswordReset(
  email: string,
  defer: (task: () => Promise<void>) => void,
  requestHeaders?: Pick<Headers, "get">,
) {
  return attempt(async () => {
    await enforceAuthLimit("forgot", email, requestHeaders);
    const send = accountMailer();
    defer(async () => {
      const token = createSessionToken();
      const hash = hashSessionToken(token);
      try {
        if (!await insertPasswordReset(email, hash)) return;
        try { await send(email, token); }
        catch { await discardPasswordReset(hash); throw new Error("delivery failed"); }
      } catch {
        console.warn("[account-recovery] 邮件任务未完成（无凭据或收件人信息）");
      }
    });
    return { message: "若该邮箱符合找回条件且邮件成功投递，请查收重设说明；也可联系管理员。" };
  });
}

export async function resetAccountPassword(token: string, password: string, requestHeaders?: Pick<Headers, "get">) {
  return attempt(async () => {
    const hash = hashSessionToken(token);
    await enforceAuthLimit("reset", hash, requestHeaders);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError({ code: "VALIDATION_FAILED", message: "重设链接无效，请重新申请。" });
    await consumePasswordReset(hash, await hashPassword(password));
    return { message: "密码已重设，所有设备已退出，请使用新密码登录。" };
  });
}
