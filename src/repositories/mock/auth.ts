/**
 * 账号与会话仓储 · Mock 实现（S7）
 *
 * 与数据库实现的**语义必须完全一致**，否则「切数据源不改上层」这条约定会被破坏。
 * 三处最容易漂、这里逐条对齐：
 *
 * 1. **过期判定**：真实实现用数据库的 `now()`，这里用 `new Date()`。
 *    两者都是「服务端时间」，客户端改不动 —— 这一点必须一致。
 * 2. **`findByEmail` 是最小写敏感匹配**：服务层已经把邮箱归一为小写，
 *    仓储不做二次转换（真实实现同样不做，`users_email_unique` 也是原样比较）。
 * 3. **邮箱重复**：真实实现撞唯一索引抛 DB_ERROR，这里必须**主动查一次**再抛同码错误。
 *    只 push 不检查的话，Mock 下能注册两个同邮箱账号，切到数据库才炸。
 */

import { formatDateTime } from "@/lib/datetime";
import { createLocalId } from "@/lib/id";
import { MOCK_BUSINESS } from "@/lib/mock";
import { AppError } from "@/lib/result";

import type {
  NewUserInput,
  SessionRecord,
  SessionRepository,
  UserCredentialRecord,
  UserRecord,
  UserRepository,
} from "../types";
import {
  countStoredUsers,
  findStoredSessionByTokenHash,
  findStoredUserByEmail,
  findStoredUserById,
  removeExpiredStoredSessions,
  removeStoredSessionByTokenHash,
  removeStoredSessionsByUser,
  putStoredSession,
  putStoredUser,
  touchStoredSession,
  type StoredMockUser,
} from "./store";

/** Mock 是单商家 Demo，账号一律挂在内置商家下 */
function resolveBusinessId(businessId?: string): string {
  return businessId ?? MOCK_BUSINESS.id;
}

function toUserRecord(user: StoredMockUser): UserRecord {
  return {
    id: user.id,
    businessId: user.businessId,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  };
}

function toCredential(user: StoredMockUser): UserCredentialRecord {
  return {
    id: user.id,
    businessId: user.businessId,
    email: user.email,
    name: user.name,
    passwordHash: user.passwordHash,
  };
}

export function createMockUserRepository(): UserRepository {
  return {
    async findByEmail(email: string): Promise<UserCredentialRecord | null> {
      const user = findStoredUserByEmail(email);
      return user ? toCredential(user) : null;
    },

    async findById(id: string): Promise<UserRecord | null> {
      const user = findStoredUserById(id);
      return user ? toUserRecord(user) : null;
    },

    async create(input: NewUserInput): Promise<UserRecord> {
      // 唯一索引在 Mock 里没有对应物，只能显式查一次 —— 否则会出现
      // 「Mock 下能注册两个同邮箱账号，切到数据库立刻炸」这种假绿
      if (findStoredUserByEmail(input.email)) {
        throw new AppError({
          code: "DB_ERROR",
          message: "创建账号失败：邮箱已被占用",
          detail: `duplicate key: users.email = ${input.email}`,
          retryable: false,
        });
      }

      const user: StoredMockUser = {
        id: createLocalId("user"),
        businessId: resolveBusinessId(input.businessId),
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        createdAt: formatDateTime(new Date()),
      };
      putStoredUser(user);
      return toUserRecord(user);
    },

    async count(): Promise<number> {
      return countStoredUsers();
    },
  };
}

export function createMockSessionRepository(): SessionRepository {
  return {
    async findValidByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
      const session = findStoredSessionByTokenHash(tokenHash);
      if (!session) {
        return null;
      }
      // 过期一律当「不存在」：与真实实现的 `expires_at > now()` 同义
      if (session.expiresAt.getTime() <= Date.now()) {
        return null;
      }
      const owner = findStoredUserById(session.userId);
      return {
        id: session.id,
        userId: session.userId,
        businessId: owner?.businessId ?? "",
        createdAt: formatDateTime(session.createdAt),
        expiresAt: formatDateTime(session.expiresAt),
        lastUsedAt: formatDateTime(session.lastUsedAt),
      };
    },

    async create(input): Promise<SessionRecord> {
      const owner = findStoredUserById(input.userId);
      if (!owner) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "创建会话失败：账号不存在",
          detail: `userId=${input.userId}`,
          retryable: false,
        });
      }

      const now = new Date();
      const session = {
        id: createLocalId("session"),
        userId: input.userId,
        tokenHash: input.tokenHash,
        createdAt: now,
        expiresAt: input.expiresAt,
        lastUsedAt: now,
      };
      putStoredSession(session);

      return {
        id: session.id,
        userId: session.userId,
        businessId: owner.businessId,
        createdAt: formatDateTime(session.createdAt),
        expiresAt: formatDateTime(session.expiresAt),
        lastUsedAt: formatDateTime(session.lastUsedAt),
      };
    },

    async deleteByTokenHash(tokenHash: string): Promise<void> {
      removeStoredSessionByTokenHash(tokenHash);
    },

    async deleteAllForUser(userId: string): Promise<number> {
      return removeStoredSessionsByUser(userId);
    },

    async deleteExpired(): Promise<number> {
      return removeExpiredStoredSessions();
    },

    async touch(id: string): Promise<void> {
      touchStoredSession(id);
    },
  };
}
