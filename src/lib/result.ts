/**
 * 统一结果信封与错误模型
 * 对应技术文档第 21 章「错误与降级策略」与第 37 章开发纪律
 *
 * 约定：
 * - 读取类服务返回 Result<T>，调用方可用 unwrapOrThrow 走异常流，或自行分支做降级
 * - 写入类服务（S1 起）必须返回 Result<T>，由调用方显式分支
 * - 禁止吞掉错误、禁止把 AI 原始输出当成可信数据
 */

/** 全站错误码。前端据此决定文案与是否展示「重新执行」 */
export const ERROR_CODES = [
  /** 资源不存在 */
  "NOT_FOUND",
  /** 入参未通过 Zod 校验 */
  "VALIDATION_FAILED",
  /** 数据库读写失败 */
  "DB_ERROR",
  /** 文件存储失败 */
  "STORAGE_ERROR",
  /** 模型调用超时 */
  "MODEL_TIMEOUT",
  /** 模型服务暂时不可用 */
  "MODEL_UNAVAILABLE",
  /** 模型输出未通过 Zod Schema 校验（含纠错重试后仍失败） */
  "SCHEMA_INVALID",
  /**
   * 模型产出的**经营计划**结构合法、但经过合法性校验仍不可执行
   * （循环依赖 / 引用不存在的商品 / 内容任务缺平台…）。
   *
   * 为什么不复用 SCHEMA_INVALID：两者对编排层意味着完全不同的处置 ——
   * 结构问题说明这个模型压根听不懂任务编排（多半是提示词或档位选错了），
   * 而计划不合法说明它听懂了、只是排错了，把违规清单回喂一次通常就能修好。
   * 合成一个码后，这两种情况在日志与重试策略里就分不开了。
   */
  "PLAN_INVALID",
  /** 模型配额耗尽 */
  "QUOTA_EXCEEDED",
  /** 触发限流 */
  "RATE_LIMITED",
  /** 未登录或无权访问 */
  "UNAUTHORIZED",
  /** 能力尚未实现（分阶段开发期间的占位） */
  "NOT_IMPLEMENTED",
  /** 未归类异常 */
  "UNKNOWN",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 错误码 → 是否可重试。前端只在 retryable 为 true 时展示「重新执行」 */
const RETRYABLE_BY_CODE: Record<ErrorCode, boolean> = {
  NOT_FOUND: false,
  VALIDATION_FAILED: false,
  DB_ERROR: true,
  STORAGE_ERROR: true,
  MODEL_TIMEOUT: true,
  MODEL_UNAVAILABLE: true,
  SCHEMA_INVALID: true,
  PLAN_INVALID: true,
  QUOTA_EXCEEDED: false,
  RATE_LIMITED: true,
  UNAUTHORIZED: false,
  NOT_IMPLEMENTED: false,
  UNKNOWN: true,
};

/** 序列化友好的错误结构，可直接返回给前端 */
export interface AppErrorShape {
  code: ErrorCode;
  /** 面向用户的中文提示 */
  message: string;
  /** 面向开发者的补充信息，仅进日志，不直接展示 */
  detail?: string;
  /** 是否可重试 */
  retryable: boolean;
}

/** 可抛出的业务错误，携带错误码与可重试标记 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(shape: Omit<AppErrorShape, "retryable"> & { retryable?: boolean }, options?: { cause?: unknown }) {
    super(shape.message, options);
    this.name = "AppError";
    this.code = shape.code;
    this.detail = shape.detail;
    this.retryable = shape.retryable ?? RETRYABLE_BY_CODE[shape.code];
  }

  toShape(): AppErrorShape {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
      retryable: this.retryable,
    };
  }
}

/** 统一结果信封 */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppErrorShape };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail(
  code: ErrorCode,
  message: string,
  detail?: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      detail,
      retryable: RETRYABLE_BY_CODE[code],
    },
  };
}

/** 把任意抛出物转换为标准错误结构 */
export function toAppError(
  cause: unknown,
  fallbackCode: ErrorCode = "UNKNOWN",
  fallbackMessage = "操作失败，请稍后重试",
): AppErrorShape {
  if (cause instanceof AppError) {
    return cause.toShape();
  }
  if (cause instanceof Error) {
    return {
      code: fallbackCode,
      message: fallbackMessage,
      detail: cause.message,
      retryable: RETRYABLE_BY_CODE[fallbackCode],
    };
  }
  return {
    code: fallbackCode,
    message: fallbackMessage,
    detail: typeof cause === "string" ? cause : undefined,
    retryable: RETRYABLE_BY_CODE[fallbackCode],
  };
}

/**
 * 包裹一次可能失败的异步操作，把异常收敛为 Result。
 * 所有数据库 / 模型 / 存储调用都应经过这里，避免未处理的 rejection。
 */
export async function attempt<T>(
  operation: () => Promise<T>,
  onError?: (cause: unknown) => AppErrorShape,
): Promise<Result<T>> {
  try {
    return ok(await operation());
  } catch (cause) {
    return { ok: false, error: onError ? onError(cause) : toAppError(cause) };
  }
}

/** 读取类服务使用：失败即抛出 AppError，由 Next.js 错误边界统一兜底 */
export function unwrapOrThrow<T>(result: Result<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new AppError(result.error);
}

/** 需要在失败时优雅降级时使用 */
export function unwrapOr<T>(result: Result<T>, fallback: T): T {
  return result.ok ? result.data : fallback;
}
