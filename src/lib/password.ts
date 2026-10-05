/**
 * 密码哈希（scrypt）
 *
 * 为什么是 `node:crypto` 的 scrypt，而不是 bcrypt / argon2：
 * 那两者都需要**原生编译**的依赖。本项目要能在零构建工具链的机器上直接跑起来
 * （这正是选 PGlite 而不选 PostgreSQL 的同一条理由）；而 scrypt 是 Node 内置的
 * 内存硬（memory-hard）算法，破解成本与 bcrypt 同级，官方也明确推荐用它替代
 * PBKDF2 做口令派生。少一个原生依赖，就少一类「装不上」的故障。
 *
 * ## 存储格式
 *
 * ```text
 * scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 * ```
 *
 * 参数**一起存进字符串**，而不是写死在代码里。这样将来调高 N 时：
 * 老用户下次登录仍能用记录里的 N 校验成功，无需强制改密；
 * 若哪天要做「登录时顺手升级哈希」，判据也只是「记录里的 N 小于当前 N」。
 * 只存 `salt$hash` 的话，参数一改，全部老密码立刻失效。
 *
 * ## 两条硬规矩
 *
 * 1. **只存哈希，不存明文**，也不存可逆加密值（可逆 = 泄露即明文）。
 * 2. 校验用 `timingSafeEqual` 定长比较。用 `===` 比较摘要会随「前几个字节是否相同」
 *    产生可测量的时间差，攻击者能据此一个字节一个字节地试出正确摘要。
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/** scrypt 参数。N 必须是 2 的幂 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** 派生密钥长度（字节） */
const KEY_LENGTH = 64;
/** 盐长度（字节） */
const SALT_LENGTH = 16;
/**
 * 显式给足内存上限。
 *
 * scrypt 的内存开销约为 `128 * N * r` = 128 × 16384 × 8 = **16 MB**，
 * 而 Node 的默认 `maxmem` 是 32 MB —— 看起来够，但默认值随 Node 版本变动过，
 * 且一旦 `maxmem` 不够，scrypt 会直接抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`，
 * 表现为「注册功能突然坏了」。这里留一倍余量写死，杜绝这类环境差异。
 */
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;

const PREFIX = "scrypt";

/** 把回调式 scrypt 包成 Promise */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

/**
 * 生成密码哈希。返回可直接入库的字符串。
 *
 * 每次调用都用新的随机盐 —— 同一个密码两次注册会得到完全不同的哈希，
 * 攻击者无法用彩虹表批量比对，也无法从哈希相同推断「这两个人密码一样」。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEM,
  });
  return [
    PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/** 解析存储格式；格式不对或参数不合法返回 null（不抛异常） */
function parseStored(
  stored: string,
): { N: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) {
    return null;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N <= 0 ||
    r <= 0 ||
    p <= 0 ||
    // N 必须是 2 的幂，否则 scrypt 会抛错
    (N & (N - 1)) !== 0
  ) {
    return null;
  }
  try {
    const salt = Buffer.from(parts[4] ?? "", "base64");
    const hash = Buffer.from(parts[5] ?? "", "base64");
    if (salt.length === 0 || hash.length === 0) {
      return null;
    }
    return { N, r, p, salt, hash };
  } catch {
    return null;
  }
}

/**
 * 校验密码。
 *
 * 任何异常（格式损坏、参数越界、scrypt 内部错误）一律返回 **false**，
 * 绝不向上抛。理由：「哈希字段被写坏」这件事在调用方没有更好的处理方式，
 * 而抛出异常会让「登录接口 500」与「密码错误」在日志里长得一样 ——
 * 前者是故障、后者是正常的用户输入，混在一起会让真正的故障被淹没。
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) {
    return false;
  }

  try {
    const derived = await scryptAsync(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAX_MEM,
    });
    // 长度不等时 timingSafeEqual 会抛错，先挡掉
    if (derived.length !== parsed.hash.length) {
      return false;
    }
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}
