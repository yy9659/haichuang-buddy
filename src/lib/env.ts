/**
 * 服务端环境变量校验（Zod）
 *
 * 设计要点：
 * - 惰性求值：只在真正需要时才解析 process.env，避免缺少凭证阻断 `pnpm build`
 * - 缺失即报错：需要凭证的能力会抛出带缺失清单的 AppError，而不是静默失败
 * - 禁止在客户端组件中 import 本模块
 *
 * 对应技术文档第 34 章「环境变量」
 */

import { z } from "zod";

import { AppError } from "./result";

/** AI 提供方。`mock` 为本地确定性实现（无需凭证）；其余为真实模型提供方 */
export const AI_PROVIDERS = [
  "mock",
  "dashscope",
  "openai",
  "deepseek",
  "custom",
] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/**
 * 数据来源。
 *
 * - `mock`  —— 进程内内存数据（S0 起的演示态，**重启即还原**，绝不落库）
 * - `local` —— 本地 PGlite（WASM 版 PostgreSQL），数据落在 `.data/pgdata`，
 *              重启后仍在；无需安装 PostgreSQL、无需 Docker、无需任何账号
 * - `db`    —— 远程 Supabase PostgreSQL（部署态，需 DATABASE_URL）
 *
 * 三者共用同一套仓储接口与迁移，切换只改这一行。
 */
export const DATA_SOURCES = ["mock", "local", "db"] as const;
export type DataSourceId = (typeof DATA_SOURCES)[number];

const serverEnvSchema = z.object({
  DATA_SOURCE: z.enum(DATA_SOURCES).default("mock"),
  ADMIN_EMAILS: z.string().default(""),

  // —— 数据层（本地 PGlite）——
  /**
   * 本地数据库数据目录，默认 `.data/pgdata`（相对项目根）。
   * 相对路径按 `process.cwd()` 解析；填绝对路径则原样使用。
   */
  LOCAL_DB_DIR: z.string().min(1).optional(),

  // —— 数据层（Supabase PostgreSQL）——
  DATABASE_URL: z.string().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // —— 模型层（通用）——
  AI_PROVIDER: z.enum(AI_PROVIDERS).optional(),
  AI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().min(1).optional(),
  AI_MODEL_FAST: z.string().min(1).optional(),
  AI_MODEL_REASONING: z.string().min(1).optional(),
  AI_MODEL_VISION: z.string().min(1).optional(),
  AI_MODEL_EMBEDDING: z.string().min(1).optional(),

  // —— 模型层（阿里云百炼 DashScope 专用）——
  // 与 AI_API_KEY 并存是为兼容「不同提供方各配各的 key」；
  // 取 key 时先看 DASHSCOPE_API_KEY，再回退 AI_API_KEY。
  DASHSCOPE_API_KEY: z.string().min(1).optional(),
  DASHSCOPE_BASE_URL: z.string().min(1).optional(),
  /** 单次模型调用超时（毫秒）。视觉模型较慢，默认 90s */
  AI_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  // 海报创意背景：使用百炼原生接口，独立于文本兼容接口。
  WANXIANG_API_KEY: z.preprocess((v) => v === "" ? undefined : v, z.string().min(1).optional()),
  WANXIANG_BASE_URL: z.preprocess((v) => v === "" ? undefined : v, z.string().url().optional()),
  WANXIANG_MODEL: z.preprocess((v) => v === "" ? undefined : v, z.enum(["wan2.6-t2i", "wan2.5-t2i-preview", "wan2.2-t2i-flash"]).default("wan2.6-t2i")),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cachedEnv: ServerEnv | null = null;

/**
 * 读取并校验服务端环境变量。
 * 解析失败会抛出 AppError，消息中列出所有不合法的字段，便于一次补齐。
 */
export function getServerEnv(): ServerEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  // .env.example 允许尚未启用的凭证留空；dotenv 读取后会得到空字符串。
  // 将空值视作未配置，让 Mock / local 模式和按需的凭证校验正常工作。
  const input = Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => [
      key,
      value?.trim() === "" ? undefined : value,
    ]),
  );
  const parsed = serverEnvSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "服务端环境变量配置不合法",
      detail: issues,
    });
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

/** 仅测试使用：清空缓存，便于在不同 env 下重复解析 */
export function resetServerEnvCache(): void {
  cachedEnv = null;
}

function requireKeys(keys: (keyof ServerEnv)[], purpose: string): void {
  const env = getServerEnv();
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: `尚未配置${purpose}所需的凭证`,
      detail: `缺少环境变量：${missing.join(", ")}（请写入 .env.local）`,
      retryable: false,
    });
  }
}

/** 数据库类能力入口调用，缺少凭证时给出明确的缺失清单 */
export function requireDatabaseEnv(): void {
  requireKeys(["DATABASE_URL"], "数据库");
}

/** 对象存储（Supabase Storage）类能力入口调用 */
export function requireStorageEnv(): void {
  requireKeys(
    ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
    "图片存储",
  );
}

/**
 * 模型类能力入口调用，缺少凭证时给出明确的缺失清单。
 *
 * 注意 `dashscope` 的取值链：优先 `DASHSCOPE_API_KEY`，回退通用 `AI_API_KEY` ——
 * 这样只想换模型、不想改变量名的人也能跑起来。
 */
export function requireAiEnv(providerId?: AiProviderId): void {
  const env = getServerEnv();
  const target = providerId ?? env.AI_PROVIDER;

  if (target === "dashscope") {
    if (env.DASHSCOPE_API_KEY || env.AI_API_KEY) {
      return;
    }
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "尚未配置通义千问（DashScope）所需的凭证",
      detail:
        "缺少环境变量：DASHSCOPE_API_KEY（或回退用的 AI_API_KEY）。请写入 .env.local。",
      retryable: false,
    });
  }

  requireKeys(
    ["AI_PROVIDER", "AI_API_KEY", "AI_BASE_URL", "AI_MODEL_FAST"],
    "模型服务",
  );
}

/** 解析 DashScope 的 API Key：优先专用变量，其次通用 AI_API_KEY */
export function resolveDashScopeApiKey(): string | undefined {
  const env = getServerEnv();
  return env.DASHSCOPE_API_KEY ?? env.AI_API_KEY;
}

/** 单次模型调用的超时时间（毫秒）；视觉模型较慢，默认 90s */
export function getAiTimeoutMs(): number {
  return getServerEnv().AI_TIMEOUT_MS ?? 90_000;
}

/** 当前是否已配置数据库（用于决定走真实数据源还是 Mock 兜底） */
export function isDatabaseConfigured(): boolean {
  return Boolean(getServerEnv().DATABASE_URL);
}

/**
 * 当前是否已配置对象存储。
 * 注意：这里刻意不做「有 URL 但无 service role key」的半配置放行 ——
 * 缺一不可，否则上传会在运行时才炸。
 */
export function isStorageConfigured(): boolean {
  const env = getServerEnv();
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

/** 当前是否已配置模型服务 */
export function isAiConfigured(): boolean {
  const env = getServerEnv();
  const provider = env.AI_PROVIDER ?? "mock";

  if (provider === "mock") {
    return true;
  }
  if (provider === "dashscope") {
    return Boolean(env.DASHSCOPE_API_KEY || env.AI_API_KEY);
  }
  return Boolean(env.AI_API_KEY && env.AI_BASE_URL && env.AI_MODEL_FAST);
}

/** 当前生效的数据来源 */
export function getDataSource(): DataSourceId {
  return getServerEnv().DATA_SOURCE;
}
