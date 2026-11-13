import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { businesses, ownerProfiles, sessions, users } from "@/db/schema";
import { AppError } from "@/lib/result";
import { mapUserRow } from "./mappers";

type Session = Pick<typeof sessions.$inferInsert, "tokenHash" | "expiresAt">;
const invalidReset = () => new AppError({ code: "VALIDATION_FAILED", message: "重设链接无效、已使用或已过期，请重新申请。" });

export async function createMerchantAccount(input: {
  email: string; name: string; passwordHash: string; session: Session;
}) {
  return getDb().transaction(async (tx) => {
    const [business] = await tx.insert(businesses).values({
      name: `${input.name}的店铺`, shortName: input.name.slice(0, 8), owner: input.name,
    }).returning({ id: businesses.id });
    const [user] = await tx.insert(users).values({
      email: input.email, name: input.name, passwordHash: input.passwordHash, businessId: business.id,
    }).onConflictDoNothing({ target: users.email }).returning();
    if (!user) throw new AppError({ code: "VALIDATION_FAILED", message: "无法创建账号，请核对信息或直接登录。" });
    await tx.insert(ownerProfiles).values({ businessId: business.id, displayName: input.name, avatarLabel: input.name.slice(0, 1) });
    await tx.insert(sessions).values({ userId: user.id, ...input.session });
    return mapUserRow(user);
  });
}

// PGlite execute returns {rows}; postgres.js returns an array.
function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}
function rowCount(result: unknown): number { return rows(result).length; }

export async function issueVerifiedSession(userId: string, expectedHash: string, session: Session) {
  await getDb().transaction(async (tx) => {
    const [user] = await tx.select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId)).for("update");
    if (user?.hash !== expectedHash) throw new AppError({ code: "UNAUTHORIZED", message: "邮箱或密码不正确" });
    await tx.insert(sessions).values({ userId, ...session });
  });
}

export async function insertPasswordReset(email: string, hash: string) {
  const result = await getDb().execute(sql`
    INSERT INTO password_resets(token_hash,user_id,expires_at)
    SELECT ${hash},id,now() + interval '30 minutes'
    FROM users WHERE email = ${email} AND email_verified_at IS NOT NULL
    RETURNING user_id`);
  return rowCount(result) === 1;
}

export async function consumePasswordReset(hash: string, passwordHash: string) {
  await getDb().transaction(async (tx) => {
    const [token] = rows<{ user_id: string }>(await tx.execute(sql`
      SELECT user_id FROM password_resets WHERE token_hash = ${hash}
        AND consumed_at IS NULL AND expires_at > now()`));
    if (!token) throw invalidReset();
    // Serialize all tokens for this account, also against login session issuance.
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, token.user_id)).for("update");
    if (!user) throw invalidReset();
    const used = await tx.execute(sql`
      UPDATE password_resets SET consumed_at = clock_timestamp()
      WHERE token_hash = ${hash} AND consumed_at IS NULL AND expires_at > clock_timestamp()
      RETURNING token_hash`);
    if (rowCount(used) !== 1) throw invalidReset();
    await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, user.id));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await tx.execute(sql`DELETE FROM password_resets WHERE user_id = ${user.id}`);
  });
}

export async function discardPasswordReset(hash: string) {
  await getDb().execute(sql`DELETE FROM password_resets WHERE token_hash = ${hash}`);
}

export async function takeRateSlot(bucket: string, limit: number, seconds: number): Promise<number> {
  const result = await getDb().execute(sql`
    WITH tick AS (SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS sec),
    slot AS (SELECT sec - (sec % ${seconds}::bigint) AS start FROM tick),
    applied AS (
      INSERT INTO security_rate_windows(bucket,window_start,hits,expires_at)
      SELECT ${bucket},start,1,to_timestamp(start + ${seconds}::bigint) FROM slot
      ON CONFLICT (bucket,window_start) DO UPDATE SET hits = security_rate_windows.hits + 1
        WHERE security_rate_windows.hits < ${limit}
      RETURNING 1
    )
    SELECT CASE WHEN EXISTS(SELECT 1 FROM applied) THEN 0 ELSE
      greatest(1, (SELECT start FROM slot) + ${seconds}::bigint - (SELECT sec FROM tick)) END AS wait`);
  return Number(rows<{ wait: number | string }>(result)[0].wait);
}

export async function acquireModelLease(businessId: string, daily: number, concurrent: number, leaseMs: number) {
  return getDb().transaction(async (tx) => {
    const [owner] = await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).for("update");
    if (!owner) throw new AppError({ code: "UNAUTHORIZED", message: "找不到当前商户" });
    const [usage] = rows<{ active: number; used: number; day: string; wait: number }>(await tx.execute(sql`
      WITH t AS (SELECT clock_timestamp() AT TIME ZONE 'Asia/Shanghai' AS local_time)
      SELECT to_char(local_time,'YYYY-MM-DD') AS day,
        ceil(extract(epoch FROM date_trunc('day',local_time) + interval '1 day' - local_time))::int AS wait,
        coalesce((SELECT calls FROM ai_daily_usage WHERE business_id = ${businessId}
          AND day = to_char(local_time,'YYYY-MM-DD')),0) AS used,
        (SELECT count(*)::int FROM ai_call_leases WHERE business_id = ${businessId}
          AND expires_at > clock_timestamp()) AS active FROM t`));
    if (usage.used >= daily) throw new AppError({ code: "QUOTA_EXCEEDED", message: "今日 AI 调用次数已用完，北京时间次日 00:00 恢复。", retryAfterSeconds: usage.wait });
    if (usage.active >= concurrent) throw new AppError({ code: "RATE_LIMITED", message: "AI 并发已达上限，请等待正在执行的任务完成（建议 10 秒后再试）。", retryAfterSeconds: 10 });
    await tx.execute(sql`INSERT INTO ai_daily_usage(business_id,day,calls) VALUES (${businessId},${usage.day},1)
      ON CONFLICT(business_id,day) DO UPDATE SET calls = ai_daily_usage.calls + 1`);
    const [lease] = rows<{ id: string }>(await tx.execute(sql`
      INSERT INTO ai_call_leases(business_id,expires_at)
      VALUES (${businessId},clock_timestamp() + ${leaseMs}::double precision * interval '1 millisecond') RETURNING id`));
    return lease.id;
  });
}

export async function releaseModelLease(businessId: string, id: string) {
  await getDb().execute(sql`DELETE FROM ai_call_leases WHERE business_id = ${businessId} AND id = ${id}`);
}

export async function administerAccount(id: string, email: string, operation: "grant" | "revoke" | "verify", operator: string) {
  await getDb().transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(and(eq(users.id, id), eq(users.email, email))).for("update");
    if (!user) throw new Error("现有账号 ID 与邮箱不匹配");
    const role = operation === "grant" ? "admin" : operation === "revoke" ? "merchant" : user.role;
    await tx.update(users).set({ role, ...(operation === "verify" ? { emailVerifiedAt: new Date() } : {}) }).where(eq(users.id, id));
    if (role !== user.role) await tx.delete(sessions).where(eq(sessions.userId, id));
    await tx.execute(sql`INSERT INTO security_role_audit(user_id,old_role,new_role,operator)
      VALUES (${id},${user.role},${role},${operation + ":" + operator})`);
  });
}

export async function pruneSecurityRecords() {
  await getDb().transaction(async (tx) => {
    for (const statement of [
      sql`DELETE FROM security_rate_windows WHERE expires_at <= now()`,
      sql`DELETE FROM account_invites WHERE expires_at <= now()`,
      sql`DELETE FROM password_resets WHERE expires_at <= now()`,
      sql`DELETE FROM ai_call_leases WHERE expires_at <= now()`,
      sql`DELETE FROM ai_daily_usage WHERE day < to_char(now() AT TIME ZONE 'Asia/Shanghai' - interval '90 days','YYYY-MM-DD')`,
      sql`DELETE FROM sessions WHERE expires_at <= now()`,
    ]) await tx.execute(statement);
  });
}

/** Only called by the offline restore tool after explicit operator confirmation. */
export async function invalidateRestoredCredentials() {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM sessions`);
    await tx.execute(sql`DELETE FROM account_invites`);
    await tx.execute(sql`DELETE FROM password_resets`);
  });
}
