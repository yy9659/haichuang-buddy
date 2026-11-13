import { getRepositories } from "@/repositories";
import { hashPassword, verifyPassword } from "@/lib/password";
import { AppError, attempt, type Result } from "@/lib/result";
import { createSessionToken, hashSessionToken, sessionExpiresAt } from "@/lib/session";
import type { LoginInput, RegisterInput } from "@/schemas/auth";

import { createMerchantAccount, issueVerifiedSession } from "@/repositories/db/security.repository";
import { getDataSource } from "@/lib/env";
import { enforceAuthLimit } from "./security-limits.service";
import { provisionBusinessForNewAccount } from "./business-provisioning.service";

/** 可以安全地交给界面的账号视图（**不含任何凭据**） */
export interface AuthUserView {
  id: string;
  email: string;
  name: string;
  businessId: string;
  role: "merchant" | "admin";
}

/**
 * 一次成功登录 / 注册的产物。
 *
 * `token` 是**明文**会话凭据，调用方拿到后应当立刻写进 `Set-Cookie`
 * 并丢弃引用 —— 数据库里只有它的 SHA-256。
 */
export interface IssuedSession {
  user: AuthUserView;
  token: string;
  expiresAt: Date;
  /** 注册时是否认领了已有的演示商家（登录时为 undefined） */
  claimedExistingBusiness?: boolean;
}

/**
 * 账号不存在时用来「陪跑」的假哈希。
 *
 * 若账号不存在就立刻返回，攻击者可以用响应时间区分「邮箱没注册」与
 * 「密码错了」—— 前者几乎瞬时返回，后者要跑一次 scrypt。恒等地跑一次
 * 哈希校验，把这条时间侧信道抹平。
 *
 * 只在本进程内算一次：`hashPassword` 本身就是 scrypt，每次登录都算一遍
 * 等于把登录耗时翻倍。
 */
let dummyPasswordHash: Promise<string> | null = null;

function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= hashPassword("haichuang-timing-equalizer");
  return dummyPasswordHash;
}

function toAuthUser(user: {
  id: string;
  email: string;
  name: string;
  businessId: string;
  role: "merchant" | "admin";
}): AuthUserView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    businessId: user.businessId,
    role: user.role,
  };
}

/** Atomic account creation; a public signup never claims any pre-existing business. */
export async function register(input: RegisterInput, requestHeaders?: Pick<Headers, "get">): Promise<Result<IssuedSession>> {
  return attempt(async () => {
    await enforceAuthLimit("register", input.email, requestHeaders);
    const token = createSessionToken();
    const expiresAt = sessionExpiresAt();
    const session = { tokenHash: hashSessionToken(token), expiresAt };
    const passwordHash = await hashPassword(input.password);
    if (getDataSource() !== "mock") {
      const user = await createMerchantAccount({
        email: input.email, name: input.name, passwordHash, session,
      });
      return { user: toAuthUser(user), token, expiresAt };
    }

    const repositories = getRepositories();
    if (await repositories.users.findByEmail(input.email)) {
      throw new AppError({ code: "VALIDATION_FAILED", message: "无法创建账号，请核对信息。" });
    }
    const business = await provisionBusinessForNewAccount({ accountName: input.name, isFirstAccount: false });
    if (!business.ok) throw new AppError(business.error);
    const user = await repositories.users.create({ email: input.email, name: input.name, passwordHash, businessId: business.data.businessId });
    await repositories.sessions.create({ userId: user.id, ...session });
    return { user: toAuthUser(user), token, expiresAt };
  });
}

/** 登录 */
export async function login(input: LoginInput, requestHeaders?: Pick<Headers, "get">): Promise<Result<IssuedSession>> {
  return attempt(async () => {
    const repositories = getRepositories();
    await enforceAuthLimit("login", input.email, requestHeaders);
    const credential = await repositories.users.findByEmail(input.email);

    /**
     * 「账号不存在」与「密码错误」返回**完全相同**的错误。
     * 区分开来等于对外提供一个「这个邮箱注册过没有」的探测接口。
     */
    const invalidCredentials = new AppError({
      code: "UNAUTHORIZED",
      message: "邮箱或密码不正确",
      retryable: false,
    });

    if (!credential) {
      await verifyPassword(input.password, await getDummyPasswordHash());
      throw invalidCredentials;
    }

    const matches = await verifyPassword(input.password, credential.passwordHash);
    if (!matches) {
      throw invalidCredentials;
    }

    const token = createSessionToken();
    const expiresAt = sessionExpiresAt();
    const session = { tokenHash: hashSessionToken(token), expiresAt };
    if (getDataSource() === "mock") await repositories.sessions.create({ userId: credential.id, ...session });
    else await issueVerifiedSession(credential.id, credential.passwordHash, session);

    return {
      user: toAuthUser(credential),
      token,
      expiresAt,
    };
  });
}

/**
 * 退出登录：删掉这条会话。
 *
 * 入参是 cookie 里的**明文 token**（服务层负责哈希），不是哈希 ——
 * 让调用方去哈希会把「token 怎么存」这件事泄漏到 Action 层。
 * token 为空或不存在时静默成功（幂等）：重复点「退出」不该报错。
 */
export async function logout(
  token: string | null,
): Promise<Result<{ revoked: boolean }>> {
  return attempt(async () => {
    if (!token) {
      return { revoked: false };
    }
    await getRepositories().sessions.deleteByTokenHash(hashSessionToken(token));
    return { revoked: true };
  });
}

/**
 * 当前请求的登录账号；未登录返回 null。
 *
 * 供外壳（顶栏用户名 / 头像）与需要「我是谁」的页面使用。
 * 它不抛「未登录」错误 —— 那是路由守卫（layout / middleware）的职责，
 * 这里只是一个查询。
 */
export async function getCurrentAuthUser(): Promise<AuthUserView | null> {
  const { getSessionContext } = await import("@/repositories/db/session-context");
  const context = await getSessionContext();

  if (context.kind !== "request" || !context.userId) {
    return null;
  }

  const user = await getRepositories().users.findById(context.userId);
  return user ? toAuthUser(user) : null;
}
