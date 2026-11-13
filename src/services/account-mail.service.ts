import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getServerEnv } from "@/lib/env";
import { configuredAppOrigin } from "@/lib/public-security";
import { AppError } from "@/lib/result";
import { assetDataDirectory } from "@/storage/asset-directory";

export type AccountMail = (to: string, token: string) => Promise<void>;

export function accountMailer(): AccountMail {
  const env = getServerEnv();
  const origin = configuredAppOrigin();
  const file = env.MAIL_MODE === "file" && process.env.NODE_ENV !== "production" &&
    origin && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (!origin || (!file && !(env.MAIL_MODE === "resend" && env.MAIL_API_KEY && env.MAIL_FROM))) {
    throw new AppError({ code: "VALIDATION_FAILED", message: "邮件服务尚未启用，请联系管理员。", retryable: false });
  }
  return async (to, token) => {
    const link = new URL("/reset-password", origin);
    // Fragment is not sent to HTTP access logs / referrers. It is read only by the form.
    link.hash = token;
    const subject = "海创Buddy 密码重设";
    const body = `${subject}\n\n请使用以下链接（30 分钟内有效，仅能使用一次）：\n${link.href}\n\n如非本人操作，请忽略此邮件。`;
    if (file) {
      const dir = path.join(assetDataDirectory(), "dev-mail");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(dir, randomUUID() + ".eml"), `[仅本地开发邮件]\n收件人: ${to}\n${body}\n`, { flag: "wx", mode: 0o600 });
      return;
    }
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { Authorization: "Bearer " + env.MAIL_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text: body }),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("mail rejected");
    } catch {
      // Never include provider payload, headers or recovery URLs in errors.
      throw new AppError({ code: "UNKNOWN", message: "邮件服务暂时不可用，请稍后再试。" });
    }
  };
}
