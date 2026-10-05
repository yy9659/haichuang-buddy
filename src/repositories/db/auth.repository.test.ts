/**
 * 账号与会话仓储集成测试（S7）
 *
 * 运行条件与开关见 `./db-integration`：
 * - `pnpm test:db` → 本地 PGlite（`.data/pgdata-test`）
 * - 配了 `DATABASE_URL` → 远程 Supabase
 * 两者都没有时整组跳过，保证 `pnpm test` 在纯前端环境下全绿。
 *
 * ## 为什么必须有这组测试
 *
 * 账号与会话是**唯一**无法用 Mock 覆盖到位的两块：
 * - 邮箱唯一性靠 `users_email_unique` 这个真实索引，Mock 只能用「先查一次」近似；
 * - 会话过期靠数据库的 `now()`，Mock 用的是进程时间；
 * - 「删账号会不会把会话一起删掉」靠外键 `ON DELETE CASCADE`。
 * 这三条只要有任意一条不成立，都会表现成「本地测着好好的、上线就串号」。
 *
 * 测试自有数据：新建一个独立的商家，账号与会话都挂在它下面，
 * 结束时删商家（级联带走账号与会话），不污染真实业务数据。
 */

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db";
import { businesses, sessions, users } from "@/db/schema";
import { createSessionToken, hashSessionToken } from "@/lib/session";

import { createDbSessionRepository, createDbUserRepository } from "./auth.repository";
import { describeDbSuite, prepareDbForTests } from "./db-integration";

const userRepository = createDbUserRepository();
const sessionRepository = createDbSessionRepository();

describeDbSuite("账号与会话仓储（集成测试）", () => {
  let businessId = "";

  /** 每个用例用独立邮箱，避免同一数据目录反复跑时互相踩 */
  function uniqueEmail(label: string): string {
    return `test-${label}-${randomUUID().slice(0, 8)}@haichuang.test`;
  }

  beforeAll(async () => {
    await prepareDbForTests();

    const inserted = await getDb()
      .insert(businesses)
      .values({
        name: "[集成测试] 账号与会话",
        shortName: "账号测试",
        description: "由 pnpm test:db 自动创建，测试结束后删除",
        owner: "测试账号",
        location: "",
        mainCategory: "",
        storeCount: 0,
        channels: [],
      })
      .returning({ id: businesses.id });

    businessId = inserted[0]?.id ?? "";
    expect(businessId).not.toBe("");
  });

  afterAll(async () => {
    if (businessId) {
      // 账号与会话通过外键级联删除
      await getDb().delete(businesses).where(eq(businesses.id, businessId));
    }
    await closeDb();
  });

  describe("UserRepository", () => {
    it("创建后能按邮箱读回凭据（含哈希），按 id 读回记录（不含哈希）", async () => {
      const email = uniqueEmail("roundtrip");
      const created = await userRepository.create({
        email,
        name: "陈老板",
        passwordHash: "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
        businessId,
      });

      expect(created.businessId).toBe(businessId);
      expect(created.email).toBe(email);
      // 安全底线：通用记录里绝不能带密码哈希
      expect(created).not.toHaveProperty("passwordHash");

      const credential = await userRepository.findByEmail(email);
      expect(credential?.id).toBe(created.id);
      // 登录校验需要哈希，所以凭据记录里必须有
      expect(credential?.passwordHash).toBe("scrypt$16384$8$1$c2FsdA==$aGFzaA==");

      const byId = await userRepository.findById(created.id);
      expect(byId?.email).toBe(email);
      expect(byId).not.toHaveProperty("passwordHash");
    });

    it("邮箱重复被唯一索引拦下，并归一为可读错误", async () => {
      const email = uniqueEmail("dup");
      await userRepository.create({
        email,
        name: "第一位",
        passwordHash: "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
        businessId,
      });

      await expect(
        userRepository.create({
          email,
          name: "第二位",
          passwordHash: "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
          businessId,
        }),
      ).rejects.toMatchObject({ code: "DB_ERROR" });
    });

    it("邮箱匹配区分大小写（归一化是服务层的职责）", async () => {
      const email = uniqueEmail("CaseSensitive");
      await userRepository.create({
        email,
        name: "大小写",
        passwordHash: "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
        businessId,
      });

      expect(await userRepository.findByEmail(email)).not.toBeNull();
      expect(await userRepository.findByEmail(email.toLowerCase())).toBeNull();
    });

    it("findById 收到非 uuid 直接当不存在，不触发数据库报错", async () => {
      expect(await userRepository.findById("not-a-uuid")).toBeNull();
    });

    it("count() 统计的是全库账号数", async () => {
      const before = await userRepository.count();
      await userRepository.create({
        email: uniqueEmail("count"),
        name: "计数",
        passwordHash: "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
        businessId,
      });
      expect(await userRepository.count()).toBe(before + 1);
    });
  });

  describe("SessionRepository", () => {
    async function createUser(label: string): Promise<string> {
      const created = await userRepository.create({
        email: uniqueEmail(label),
        name: "会话账号",
        passwordHash: "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
        businessId,
      });
      return created.id;
    }

    it("会话带回账号所属商家（鉴权一次 JOIN 拿到三件事）", async () => {
      const userId = await createUser("session-ok");
      const token = createSessionToken();
      const tokenHash = hashSessionToken(token);

      const session = await sessionRepository.create({
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      });

      expect(session.userId).toBe(userId);
      expect(session.businessId).toBe(businessId);

      const found = await sessionRepository.findValidByTokenHash(tokenHash);
      expect(found?.id).toBe(session.id);
      expect(found?.businessId).toBe(businessId);
      // 返回的记录里不该有 token 哈希：它是查询条件，不是展示内容
      expect(found).not.toHaveProperty("tokenHash");
    });

    it("已过期的会话查不到（判定用的是数据库的 now()）", async () => {
      const userId = await createUser("session-expired");
      const tokenHash = hashSessionToken(createSessionToken());

      await sessionRepository.create({
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() - 60_000),
      });

      expect(await sessionRepository.findValidByTokenHash(tokenHash)).toBeNull();
    });

    it("退出登录后会话立刻失效，且重复退出不报错", async () => {
      const userId = await createUser("session-logout");
      const tokenHash = hashSessionToken(createSessionToken());
      await sessionRepository.create({
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        sessionRepository.findValidByTokenHash(tokenHash),
      ).resolves.not.toBeNull();

      await sessionRepository.deleteByTokenHash(tokenHash);
      expect(await sessionRepository.findValidByTokenHash(tokenHash)).toBeNull();

      // 幂等：第二次删除不该抛
      await expect(sessionRepository.deleteByTokenHash(tokenHash)).resolves.toBeUndefined();
    });

    it("deleteAllForUser 一次性注销该账号的全部会话（改密码 / 踢下线）", async () => {
      const userId = await createUser("session-all");
      await sessionRepository.create({
        userId,
        tokenHash: hashSessionToken(createSessionToken()),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await sessionRepository.create({
        userId,
        tokenHash: hashSessionToken(createSessionToken()),
        expiresAt: new Date(Date.now() + 60_000),
      });

      expect(await sessionRepository.deleteAllForUser(userId)).toBe(2);
      expect(await sessionRepository.deleteAllForUser(userId)).toBe(0);
    });

    it("deleteExpired 只删过期的那批", async () => {
      const userId = await createUser("session-sweep");
      const liveHash = hashSessionToken(createSessionToken());
      const staleHash = hashSessionToken(createSessionToken());

      await sessionRepository.create({
        userId,
        tokenHash: liveHash,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await sessionRepository.create({
        userId,
        tokenHash: staleHash,
        expiresAt: new Date(Date.now() - 60_000),
      });

      expect(await sessionRepository.deleteExpired()).toBeGreaterThanOrEqual(1);
      // 未过期的那条必须活着
      expect(await sessionRepository.findValidByTokenHash(liveHash)).not.toBeNull();
      expect(await sessionRepository.findValidByTokenHash(staleHash)).toBeNull();
    });

    it("touch 刷新最近使用时间", async () => {
      const userId = await createUser("session-touch");
      const tokenHash = hashSessionToken(createSessionToken());
      const created = await sessionRepository.create({
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const before = await sessionRepository.findValidByTokenHash(tokenHash);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await sessionRepository.touch(created.id);
      const after = await sessionRepository.findValidByTokenHash(tokenHash);

      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(new Date(after!.lastUsedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(before!.lastUsedAt).getTime(),
      );
    });

    it("删除账号会级联删掉它的会话（外键 ON DELETE CASCADE）", async () => {
      const userId = await createUser("session-cascade");
      const tokenHash = hashSessionToken(createSessionToken());
      await sessionRepository.create({
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await getDb().delete(users).where(eq(users.id, userId));

      const rows = await getDb()
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, userId));
      expect(rows).toHaveLength(0);
    });
  });
});
