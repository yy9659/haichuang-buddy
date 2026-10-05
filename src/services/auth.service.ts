/**
 * 账号服务（S7）—— 注册 / 登录 / 退出 / 当前用户
 *
 * ## 为什么服务层不写 cookie
 *
 * 「建会话」与「写 cookie」是两件事。前者是数据（库里的 `sessions` 行），
 * 后者是 HTTP 响应的一部分。Next.js 只在 Server Action / Route Handler 里
 * 允许写 cookie，而服务层要保持「可被脚本、测试、其它 Action 复用」。
 * 所以本模块**只负责生成 token 并落库**，把明文 token 交给调用方去写 cookie，
 * 并且保证它除了「写 cookie」之外不会被用在任何地方（不落库、不进日志）。
 *
 * ## 为什么注册要先建商家再建账号
 *
 * `users.business_id` 非空 —— 账号必须一出生就属于某个商家，否则登录进去
 * 每个页面都会撞「尚未创建商家档案」。所以顺序是固定的：
 * 查重 → 判断是否首账号 → 开通商家（认领 / 新建）+ 起步数据 → 建账号 → 发会话。
 *
 * 任何一步失败都会 `throw`，由 `attempt` 收敛成 `Result`，
 * 账号与商家都不会留下半套（起步数据的写入是幂等的：见 provisioning 的说明）。
 */

import { getRepositories } from "@/repositories";
import { hashPassword, verifyPassword } from "@/lib/password";
import { AppError, attempt, type Result } from "@/lib/result";
import { createSessionToken, hashSessionToken, sessionExpiresAt } from "@/lib/session";
import type { LoginInput, RegisterInput } from "@/schemas/auth";

import { provisionBusinessForNewAccount } from "./business-provisioning.service";

/** 可以安全地交给界面的账号视图（**不含任何凭据**） */
export interface AuthUserView {
  id: string;
  email: string;
  name: string;
  businessId: string;
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
}): AuthUserView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    businessId: user.businessId,
  };
}

/** 生成 token → 落库 → 返回明文（仅用于写 cookie） */
async function issueSession(
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const expiresAt = sessionExpiresAt();

  await getRepositories().sessions.create({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });

  return { token, expiresAt };
}

/**
 * 判断一个仓储异常是不是「邮箱已占用」。
 *
 * 正常路径上我们已经先 `findByEmail` 查过一次；这里兜的是**并发注册**
 * （两个请求同时通过了查重）—— 那一次会撞唯一索引，归一化后是
 * `DB_ERROR` + detail 里带约束名。把它翻译成和查重一致的提示，
 * 用户不会看到「数据已存在，请勿重复提交」这种不知道在说什么的文案。
 */
function isDuplicateEmailError(cause: unknown): boolean {
  if (!(cause instanceof AppError)) {
    return false;
  }
  const haystack = `${cause.detail ?? ""} ${cause.message}`;
  return /users_email_unique|duplicate key|已存在|已被占用/.test(haystack);
}

/**
 * 注册。
 *
 * 校验本身由调用方（Server Action）用 `registerSchema` 完成 ——
 * 服务层再次信任入参类型，不重复解析。这里只做业务规则。
 */
export async function register(
  input: RegisterInput,
): Promise<Result<IssuedSession>> {
  return attempt(async () => {
    const repositories = getRepositories();

    const existing = await repositories.users.findByEmail(input.email);
    if (existing) {
      throw new AppError({
        code: "VALIDATION_FAILED",
        message: "该邮箱已被注册，请直接登录",
        retryable: false,
      });
    }

    // 「是不是第一个账号」决定要不要认领已有的演示商家。只能服务端判断 ——
    // 让用户自己选归属商家等于允许任何人认领任意商家。
    const isFirstAccount = (await repositories.users.count()) === 0;

    const provisioned = await provisionBusinessForNewAccount({
      accountName: input.name,
      isFirstAccount,
    });
    if (!provisioned.ok) {
      throw new AppError(provisioned.error);
    }

    const passwordHash = await hashPassword(input.password);

    let created;
    try {
      created = await repositories.users.create({
        email: input.email,
        name: input.name,
        passwordHash,
        businessId: provisioned.data.businessId,
      });
    } catch (cause) {
      if (isDuplicateEmailError(cause)) {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: "该邮箱已被注册，请直接登录",
          retryable: false,
        });
      }
      throw cause;
    }

    const session = await issueSession(created.id);

    return {
      user: toAuthUser(created),
      token: session.token,
      expiresAt: session.expiresAt,
      claimedExistingBusiness: provisioned.data.claimedExisting,
    };
  });
}

/** 登录 */
export async function login(input: LoginInput): Promise<Result<IssuedSession>> {
  return attempt(async () => {
    const repositories = getRepositories();
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

    const session = await issueSession(credential.id);

    return {
      user: toAuthUser(credential),
      token: session.token,
      expiresAt: session.expiresAt,
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
