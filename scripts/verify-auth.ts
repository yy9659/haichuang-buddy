/**
 * 本地多用户认证端到端验收脚本（S7）
 *
 * 用法（**必须**指向一次性数据目录，见下方安全护栏）：
 *   LOCAL_DB_DIR=.data/pgdata-verify AI_PROVIDER=mock pnpm tsx scripts/verify-auth.ts
 *
 * 为什么 `AI_PROVIDER=mock`：注册新商家时会灌一份起步知识库，那一步要调
 * 向量模型。本脚本验收的是**账号与会话**，不该依赖网络与真实配额。
 *
 * ## 验收什么
 *
 * 1. 首个账号**认领**已有商家（而不是新建一个，让 seed 的数据变成孤儿）
 * 2. 密码只以 scrypt 哈希落库；会话只落 token 的 SHA-256（明文都不出现）
 * 3. 登录：错密码 / 不存在的邮箱返回**同一个**错误（防账号枚举）
 * 4. 第二个账号拿到**自己的**商家，并且**同样**有起步数据
 *    （这一条是 `countForBusiness` 修复的回归保护：早先用 `products.list()`
 *    会让第二个账号的店铺永远空白）
 * 5. 退出只注销自己那条会话，不影响其它会话
 * 6. **重启后数据仍在**，且未过期的会话依然可用
 *
 * ## 安全护栏
 *
 * 脚本会写入并**删除**账号与商家。如果误指向 `.data/pgdata`（真实演示数据），
 * 清理阶段会连带删掉演示商家。所以这里硬性要求 `LOCAL_DB_DIR` 以 `-verify`
 * 结尾 —— 宁愿脚本拒绝运行，也不要它悄悄毁掉演示数据。
 */

import "./lib/env";

import { eq, inArray } from "drizzle-orm";

import { closeDb, getDb } from "@/db";
import { ensureLocalDatabaseReady, resolveLocalDbDir } from "@/db/local";
import { businesses, sessions, users } from "@/db/schema";
import { hashSessionToken } from "@/lib/session";
import { getRepositories } from "@/repositories";
import { registerSchema } from "@/schemas/auth";
import { login, logout, register } from "@/services/auth.service";

const PASSWORD = "haichuang-2026";

interface CheckResult {
  label: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(label: string, passed: boolean, detail = ""): void {
  results.push({ label, passed, detail });
  console.log(`  ${passed ? "✅" : "❌"} ${label}${detail ? ` —— ${detail}` : ""}`);
}

function uniqueEmail(label: string): string {
  return `verify-${label}-${Date.now()}@haichuang.test`;
}

async function countRows(table: "users" | "businesses"): Promise<number> {
  const rows =
    table === "users"
      ? await getDb().select({ id: users.id }).from(users)
      : await getDb().select({ id: businesses.id }).from(businesses);
  return rows.length;
}

async function main(): Promise<void> {
  console.log("===== 本地多用户认证端到端验收 =====");

  if (process.env.DATA_SOURCE !== "local") {
    console.error(
      "❌ 必须在 DATA_SOURCE=local 下运行（.env.local 已设为 local，检查是否被覆盖）",
    );
    process.exit(1);
  }

  const dbDir = process.env.LOCAL_DB_DIR ?? "";
  if (!dbDir.endsWith("-verify")) {
    console.error(
      "❌ 拒绝运行：脚本会写入并删除账号与商家，只能指向一次性数据目录。\n" +
        "   请这样运行：\n" +
        "   LOCAL_DB_DIR=.data/pgdata-verify AI_PROVIDER=mock pnpm tsx scripts/verify-auth.ts",
    );
    process.exit(1);
  }

  console.log(`数据目录：${resolveLocalDbDir()}`);
  console.log(`数据源：${process.env.DATA_SOURCE}\n`);

  await ensureLocalDatabaseReady();

  const repositories = getRepositories();
  /** 本次运行创建过的商家；收尾时删除（账号与会话随外键级联带走） */
  const createdBusinessIds: string[] = [];

  // —— [1] 准备「已有商家、但没有账号」的状态（等价于跑过 pnpm db:seed）——
  console.log("[1] 准备基线：一个已有商家、零个账号");
  const seedBusiness =
    (await countRows("businesses")) === 0
      ? await repositories.business.create({
          name: "验收用演示商家",
          shortName: "验收商家",
          description: "由 verify-auth 脚本创建",
          owner: "验收",
          location: "",
          mainCategory: "",
          storeCount: 0,
          channels: [],
        })
      : (await repositories.business.findEarliestProfile());

  const seedBusinessId = seedBusiness?.id ?? "";
  if (seedBusinessId) {
    createdBusinessIds.push(seedBusinessId);
  }
  record("基线商家就绪", Boolean(seedBusinessId), seedBusiness?.name ?? "未取到");

  // —— [2] 首个账号：应当认领基线商家 ——
  console.log("\n[2] 首个账号应认领已有商家，而不是另建一个");
  const emailOne = uniqueEmail("owner");
  const registered = await register(
    registerSchema.parse({ email: emailOne, name: "陈老板", password: PASSWORD }),
  );

  record("注册成功", registered.ok, registered.ok ? emailOne : registered.error.message);
  if (!registered.ok) {
    await finish(createdBusinessIds);
    return;
  }

  const accountOne = registered.data;
  const claimedRight = accountOne.user.businessId === seedBusinessId;
  record(
    "首账号认领了已有商家（seed 数据没有变成孤儿）",
    claimedRight && accountOne.claimedExistingBusiness === true,
    `businessId=${accountOne.user.businessId}`,
  );

  // —— [3] 凭据存储形态 ——
  console.log("\n[3] 凭据存储形态：明文一律不落库");
  const userRow = await getDb()
    .select()
    .from(users)
    .where(eq(users.id, accountOne.user.id))
    .limit(1);
  const storedUser = userRow[0];

  record(
    "密码存的是 scrypt 哈希，不是明文",
    Boolean(storedUser?.passwordHash) &&
      storedUser.passwordHash !== PASSWORD &&
      storedUser.passwordHash.startsWith("scrypt$"),
    storedUser ? `${storedUser.passwordHash.slice(0, 12)}…` : "未取到",
  );

  const sessionRows = await getDb().select().from(sessions);
  const mySession = sessionRows.find((row) => row.userId === accountOne.user.id);
  const storedAsHash =
    mySession !== undefined &&
    mySession.tokenHash === hashSessionToken(accountOne.token) &&
    mySession.tokenHash !== accountOne.token;
  record(
    "会话存的是 token 的 SHA-256，明文 token 不在库里",
    storedAsHash,
    mySession ? `${mySession.tokenHash.slice(0, 12)}…` : "未取到",
  );

  // 这一步复刻 session-context 的鉴权路径：cookie 里的明文 → 哈希 → 查未过期会话
  const resolved = await repositories.sessions.findValidByTokenHash(
    hashSessionToken(accountOne.token),
  );
  record(
    "拿 token 能解析出「哪个商家」（多租户隔离的输入）",
    resolved?.businessId === accountOne.user.businessId,
    resolved ? `businessId=${resolved.businessId}` : "未解析出会话",
  );

  // —— [4] 登录语义 ——
  console.log("\n[4] 登录：错误一律同一句话，成功签发新会话");
  const wrongPassword = await login({ email: emailOne, password: "wrong-password" });
  const unknownEmail = await login({
    email: uniqueEmail("ghost"),
    password: PASSWORD,
  });

  const sameError =
    !wrongPassword.ok &&
    !unknownEmail.ok &&
    wrongPassword.error.code === "UNAUTHORIZED" &&
    wrongPassword.error.message === unknownEmail.error.message;
  record("密码错误与邮箱不存在不可区分（防账号枚举）", sameError);
  record(
    "该提示不泄露账号是否存在",
    !wrongPassword.ok && wrongPassword.error.message === "邮箱或密码不正确",
  );

  const loggedIn = await login({ email: emailOne, password: PASSWORD });
  record(
    "密码正确时登录成功，且签发的是新会话",
    loggedIn.ok && loggedIn.data.token !== accountOne.token,
  );
  if (!loggedIn.ok) {
    await finish(createdBusinessIds);
    return;
  }
  const secondSessionToken = loggedIn.data.token;

  // —— [5] 第二个账号：必须拿到自己的商家与起步数据 ——
  console.log("\n[5] 第二个账号拿到独立的商家与起步数据");
  const emailTwo = uniqueEmail("second");
  const secondAccount = await register(
    registerSchema.parse({ email: emailTwo, name: "林老板", password: PASSWORD }),
  );

  record("第二个账号注册成功", secondAccount.ok);
  if (!secondAccount.ok) {
    await finish(createdBusinessIds);
    return;
  }

  const secondBusinessId = secondAccount.data.user.businessId;
  createdBusinessIds.push(secondBusinessId);

  record(
    "两个账号的商家互不相同（数据隔离的前提）",
    secondBusinessId !== accountOne.user.businessId,
    `${accountOne.user.businessId} ≠ ${secondBusinessId}`,
  );
  record(
    "第二个账号不是「认领」已有商家",
    secondAccount.data.claimedExistingBusiness === false,
  );

  const secondProductCount =
    await repositories.products.countForBusiness(secondBusinessId);
  const firstProductCount = await repositories.products.countForBusiness(
    accountOne.user.businessId,
  );
  record(
    "两家店各自都有起步商品（第二个账号不会看到空店铺）",
    secondProductCount > 0 && firstProductCount > 0,
    `A=${firstProductCount} 件，B=${secondProductCount} 件`,
  );

  // —— [6] 退出登录 ——
  console.log("\n[6] 退出只注销自己那条会话");
  const logoutResult = await logout(secondSessionToken);
  const afterLogout = await repositories.sessions.findValidByTokenHash(
    hashSessionToken(secondSessionToken),
  );
  const otherStillValid = await repositories.sessions.findValidByTokenHash(
    hashSessionToken(accountOne.token),
  );

  record("退出成功且该会话立刻失效", logoutResult.ok && afterLogout === null);
  record(
    "同一账号的其它会话不受影响（不是「一退全退」）",
    otherStillValid !== null,
  );

  // —— [7] 重启后数据仍在 ——
  console.log("\n[7] 持久化：关闭连接再重开，账号与会话仍在");
  await closeDb();
  await ensureLocalDatabaseReady();

  const userAfterRestart = await getDb()
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, accountOne.user.id))
    .limit(1);
  record(
    "重启后账号仍在",
    userAfterRestart[0]?.email === emailOne,
    userAfterRestart[0]?.email ?? "未找到",
  );

  const sessionAfterRestart = await repositories.sessions.findValidByTokenHash(
    hashSessionToken(accountOne.token),
  );
  record(
    "重启后未过期的会话依然可用",
    sessionAfterRestart?.userId === accountOne.user.id,
  );

  await finish(createdBusinessIds);
}

/** 汇总 + 清理。删除商家会级联带走本次创建的账号与会话 */
async function finish(createdBusinessIds: string[]): Promise<void> {
  console.log("\n[8] 清理本次写入的测试数据");
  if (createdBusinessIds.length > 0) {
    await getDb().delete(businesses).where(inArray(businesses.id, createdBusinessIds));
    record("已删除本次创建的商家（账号与会话级联清理）", true);
  }

  const failed = results.filter((item) => !item.passed);
  console.log("\n===== 汇总 =====");
  console.log(
    `共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`,
  );

  await closeDb();

  if (failed.length > 0) {
    console.error("\n❌ 认证端到端验收未通过：");
    for (const item of failed) {
      console.error(`   · ${item.label}${item.detail ? ` —— ${item.detail}` : ""}`);
    }
    process.exit(1);
  }

  console.log("\n✅ 认证端到端验收通过：注册、登录、隔离、退出、重启后保留全部成立。");
}

void main().catch(async (error) => {
  console.error("\n脚本异常终止：", error);
  try {
    await closeDb();
  } catch {
    // 收尾失败不掩盖原始错误
  }
  process.exit(1);
});
