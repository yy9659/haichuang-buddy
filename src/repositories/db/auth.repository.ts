/**
 * 账号与会话仓储 · 数据库实现（S7）
 *
 * 两个仓储放在同一个文件里，因为它们几乎总是一起用（登录 = 读账号 + 写会话），
 * 且共享同一条最关键的约束：**会话必须带商家归属**。
 *
 * ## 为什么 `findValidByTokenHash` 直接 JOIN users
 *
 * 会话本身只存 `user_id`，但每次鉴权都要立刻知道「这属于哪个商家」——
 * 否则中间还得再查一次 users，而这一步在每个请求上都会发生。
 * 一次 JOIN 把三件事一起办掉：会话有效性、账号存在性、商家归属。
 *
 * ## 过期判定用 `now()` 而不是应用时间
 *
 * `expires_at > now()` 里的 `now()` 是**数据库的**当前时间。理由见
 * `SessionRepository.findValidByTokenHash` 的接口注释：
 * 应用与库不在同一台机器时进程时钟可能偏移，而且这样才能防住
 * 「把系统时间调回去以延长会话」。
 */

import { and, eq, gt, lt, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { isUuid } from "@/lib/id";
import { AppError } from "@/lib/result";

import type {
  NewUserInput,
  SessionRecord,
  SessionRepository,
  UserCredentialRecord,
  UserRecord,
  UserRepository,
} from "../types";
import { mapDatabaseError } from "./errors";
import { mapSessionRow, mapUserRow, mapUserCredentialRow } from "./mappers";
import { resolvePrimaryBusinessId } from "./shared";

export function createDbUserRepository(): UserRepository {
  return {
    async findByEmail(email: string): Promise<UserCredentialRecord | null> {
      try {
        const rows = await getDb()
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        const row = rows[0];
        return row ? mapUserCredentialRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载账号");
      }
    },

    async findById(id: string): Promise<UserRecord | null> {
      // 非 uuid 直接当「不存在」：让「猜 id」这条路径连一次查询都不发生
      if (!isUuid(id)) {
        return null;
      }
      try {
        const rows = await getDb()
          .select()
          .from(users)
          .where(eq(users.id, id))
          .limit(1);
        const row = rows[0];
        return row ? mapUserRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载账号");
      }
    },

    async create(input: NewUserInput): Promise<UserRecord> {
      try {
        const businessId = input.businessId ?? (await resolvePrimaryBusinessId());
        if (!isUuid(businessId)) {
          throw new AppError({
            code: "VALIDATION_FAILED",
            message: "创建账号失败：商家标识格式不正确",
            detail: `not a uuid: ${businessId}`,
            retryable: false,
          });
        }

        // 邮箱重复由 users_email_unique 拦下，经 mapDatabaseError 归一为 DB_ERROR
        const rows = await getDb()
          .insert(users)
          .values({
            businessId,
            email: input.email,
            name: input.name,
            passwordHash: input.passwordHash,
          })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "创建账号失败：数据库未返回记录",
          });
        }
        return mapUserRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "创建账号");
      }
    },

    async count(): Promise<number> {
      try {
        const rows = await getDb()
          .select({ total: sql<string>`count(*)` })
          .from(users);
        const total = Number(rows[0]?.total ?? 0);
        return Number.isFinite(total) ? total : 0;
      } catch (cause) {
        throw mapDatabaseError(cause, "统计账号数");
      }
    },
  };
}

export function createDbSessionRepository(): SessionRepository {
  return {
    async findValidByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
      try {
        const rows = await getDb()
          .select({ session: sessions, businessId: users.businessId })
          .from(sessions)
          .innerJoin(users, eq(sessions.userId, users.id))
          .where(
            and(
              eq(sessions.tokenHash, tokenHash),
              // 用数据库时间判定过期，不用应用进程时间
              gt(sessions.expiresAt, sql`now()`),
            ),
          )
          .limit(1);

        const row = rows[0];
        return row ? mapSessionRow(row.session, row.businessId) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "校验登录状态");
      }
    },

    async create(input): Promise<SessionRecord> {
      try {
        if (!isUuid(input.userId)) {
          throw new AppError({
            code: "VALIDATION_FAILED",
            message: "创建会话失败：账号标识格式不正确",
            detail: `not a uuid: ${input.userId}`,
            retryable: false,
          });
        }

        const rows = await getDb()
          .insert(sessions)
          .values({
            userId: input.userId,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
          })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "创建会话失败：数据库未返回记录",
          });
        }

        // 归属商家随账号而来，这里必须再查一次才能真正知道
        const owner = await getDb()
          .select({ businessId: users.businessId })
          .from(users)
          .where(eq(users.id, input.userId))
          .limit(1);

        return mapSessionRow(row, owner[0]?.businessId ?? "");
      } catch (cause) {
        throw mapDatabaseError(cause, "创建会话");
      }
    },

    async deleteByTokenHash(tokenHash: string): Promise<void> {
      try {
        await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash));
      } catch (cause) {
        throw mapDatabaseError(cause, "退出登录");
      }
    },

    async deleteAllForUser(userId: string): Promise<number> {
      if (!isUuid(userId)) {
        return 0;
      }
      try {
        const rows = await getDb()
          .delete(sessions)
          .where(eq(sessions.userId, userId))
          .returning({ id: sessions.id });
        return rows.length;
      } catch (cause) {
        throw mapDatabaseError(cause, "注销全部会话");
      }
    },

    async deleteExpired(): Promise<number> {
      try {
        const rows = await getDb()
          .delete(sessions)
          .where(lt(sessions.expiresAt, sql`now()`))
          .returning({ id: sessions.id });
        return rows.length;
      } catch (cause) {
        throw mapDatabaseError(cause, "清理过期会话");
      }
    },

    async touch(id: string): Promise<void> {
      if (!isUuid(id)) {
        return;
      }
      try {
        await getDb()
          .update(sessions)
          .set({ lastUsedAt: new Date() })
          .where(eq(sessions.id, id));
      } catch (cause) {
        throw mapDatabaseError(cause, "更新会话活跃时间");
      }
    },
  };
}
