/**
 * 账号服务单元测试（Mock 数据源）
 *
 * 覆盖的是**业务规则**，不是存储细节（存储细节由 `auth.repository.test.ts`
 * 打真实 Postgres 验证）：
 * - 注册必须先准备好商家，账号才能带 businessId 出生；
 * - 邮箱重复要在服务层就被翻译成「可读提示」，而不是把 DB_ERROR 抛给界面；
 * - 登录失败**不能**区分「邮箱不存在」与「密码错误」（防账号枚举）；
 * - 密码只以 scrypt 哈希落库；会话只以 token 哈希落库。
 *
 * 测试隔离：Mock 仓储是**模块级单例**（进程内一份），所以每个用例前
 * 清空账号与会话表，否则上一个用例注册的邮箱会污染下一个。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvCache } from "@/lib/env";
import { MOCK_BUSINESS } from "@/lib/mock";
import { hashSessionToken } from "@/lib/session";
import {
  clearStoredSessions,
  clearStoredUsers,
  findStoredSessionByTokenHash,
  findStoredUserByEmail,
} from "@/repositories/mock/store";
import { registerSchema } from "@/schemas/auth";

import { getCurrentAuthUser, login, logout, register } from "./auth.service";

process.env.DATA_SOURCE = "mock";
resetServerEnvCache();

const VALID_PASSWORD = "haichuang-2026";

function credentials(email: string) {
  return {
    email,
    name: "陈老板",
    password: VALID_PASSWORD,
  };
}

beforeEach(() => {
  clearStoredUsers();
  clearStoredSessions();
});

describe("register", () => {
  it("首个账号认领演示商家，并拿到会话 token", async () => {
    const result = await register(credentials("first@haichuang.test"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.user.email).toBe("first@haichuang.test");
    expect(result.data.user.businessId).toBe(MOCK_BUSINESS.id);
    expect(result.data.claimedExistingBusiness).toBe(true);
    expect(result.data.token).not.toBe("");
    expect(result.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("密码只以 scrypt 哈希落库，明文不出现", async () => {
    await register(credentials("hash@haichuang.test"));

    const stored = findStoredUserByEmail("hash@haichuang.test");
    expect(stored).toBeDefined();
    expect(stored?.passwordHash).not.toBe(VALID_PASSWORD);
    expect(stored?.passwordHash.startsWith("scrypt$")).toBe(true);
  });

  it("会话只落 token 的哈希，明文 token 不入库", async () => {
    const result = await register(credentials("session@haichuang.test"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(findStoredSessionByTokenHash(result.data.token)).toBeUndefined();
    expect(
      findStoredSessionByTokenHash(hashSessionToken(result.data.token)),
    ).toBeDefined();
  });

  it("邮箱重复返回可读提示，而不是数据库错误", async () => {
    await register(credentials("dup@haichuang.test"));
    const second = await register(credentials("dup@haichuang.test"));

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("VALIDATION_FAILED");
    expect(second.error.message).toContain("已被注册");
  });

  it("邮箱归一化由 schema 完成：大小写不同的同一邮箱被判重", async () => {
    /**
     * 服务层**不做**邮箱归一化 —— 那是 `registerSchema` 的职责（见其注释：
     * 「邮箱大小写不敏感」是业务规则）。所以这里必须先过一遍 schema，
     * 拿到的才是服务层真正会收到的入参；直接手搓小写入参调用服务，
     * 测的是一个现实中不存在的调用路径。
     */
    const first = registerSchema.parse({
      email: "Mixed@Haichuang.Test",
      name: "陈老板",
      password: VALID_PASSWORD,
    });
    expect(first.email).toBe("mixed@haichuang.test");
    expect((await register(first)).ok).toBe(true);

    const second = registerSchema.parse({
      email: "MIXED@haichuang.TEST",
      name: "另一位",
      password: VALID_PASSWORD,
    });
    const result = await register(second);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("已被注册");
  });
});

describe("login", () => {
  it("凭据正确时签发一条新会话", async () => {
    const registered = await register(credentials("login@haichuang.test"));
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const result = await login({
      email: "login@haichuang.test",
      password: VALID_PASSWORD,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.user.id).toBe(registered.data.user.id);
    // 每次登录都是新会话，与注册时那条不同
    expect(result.data.token).not.toBe(registered.data.token);
  });

  it("密码错误与邮箱不存在返回**完全相同**的错误（防账号枚举）", async () => {
    await register(credentials("exists@haichuang.test"));

    const wrongPassword = await login({
      email: "exists@haichuang.test",
      password: "definitely-wrong",
    });
    const unknownEmail = await login({
      email: "nobody@haichuang.test",
      password: VALID_PASSWORD,
    });

    expect(wrongPassword.ok).toBe(false);
    expect(unknownEmail.ok).toBe(false);
    if (wrongPassword.ok || unknownEmail.ok) return;

    expect(wrongPassword.error.code).toBe("UNAUTHORIZED");
    expect(wrongPassword.error.message).toBe(unknownEmail.error.message);
    expect(wrongPassword.error.message).toBe("邮箱或密码不正确");
  });
});

describe("logout", () => {
  it("退出后该会话立即失效，重复退出幂等", async () => {
    const registered = await register(credentials("logout@haichuang.test"));
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const token = registered.data.token;
    expect(findStoredSessionByTokenHash(hashSessionToken(token))).toBeDefined();

    const first = await logout(token);
    expect(first.ok).toBe(true);
    expect(findStoredSessionByTokenHash(hashSessionToken(token))).toBeUndefined();

    const second = await logout(token);
    expect(second.ok).toBe(true);
  });

  it("token 为空时不报错（未登录点退出）", async () => {
    const result = await logout(null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.revoked).toBe(false);
  });
});

describe("getCurrentAuthUser", () => {
  it("没有请求作用域（脚本 / 测试）时返回 null，而不是抛异常", async () => {
    // vitest 里没有 Next.js 请求上下文，`cookies()` 会抛错；
    // 这正是「脚本 / CRON」的形态，应当被当成「未登录」而不是故障。
    await expect(getCurrentAuthUser()).resolves.toBeNull();
  });
});
