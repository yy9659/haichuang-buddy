/**
 * 数据库错误归一化
 *
 * postgres.js 抛出的错误带有 SQLSTATE 码。仓储实现不直接把这些错误抛给上层，
 * 而是统一收敛为 AppError（携带 code + 面向用户的 message），
 * 由服务层再包一层 Result —— 这样错误文案与前端展示策略保持一致。
 *
 * 常见 SQLSTATE：
 * - 22P02 invalid_text_representation（uuid 格式错误）
 * - 23505 unique_violation
 * - 23503 foreign_key_violation
 * - 23502 not_null_violation
 * - 42P01 undefined_table（迁移未执行）
 */

import { AppError } from "@/lib/result";

/** postgres.js 错误对象的最小可用形状 */
interface PostgresErrorLike {
  code?: string;
  detail?: string;
  message?: string;
  constraint_name?: string;
}

function asPostgresError(cause: unknown): PostgresErrorLike | null {
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  const candidate = cause as PostgresErrorLike;
  return typeof candidate.code === "string" ? candidate : null;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return typeof cause === "string" ? cause : "未知错误";
}

/**
 * 把数据库异常转换为 AppError。
 * @param cause 原始异常
 * @param action 操作名，用于拼接用户可见文案，如「创建商品」
 */
export function mapDatabaseError(cause: unknown, action: string): AppError {
  if (cause instanceof AppError) {
    return cause;
  }

  const pgError = asPostgresError(cause);
  if (!pgError) {
    return new AppError({
      code: "DB_ERROR",
      message: `${action}失败，请稍后重试`,
      detail: describe(cause),
    });
  }

  switch (pgError.code) {
    case "23505":
      return new AppError({
        code: "DB_ERROR",
        message: `${action}失败：数据已存在，请勿重复提交`,
        detail: `unique_violation${
          pgError.constraint_name ? ` (${pgError.constraint_name})` : ""
        }: ${pgError.detail ?? pgError.message ?? ""}`,
        retryable: false,
      });
    case "23503":
      return new AppError({
        code: "DB_ERROR",
        message: `${action}失败：关联数据不存在或已被删除`,
        detail: `foreign_key_violation: ${pgError.detail ?? pgError.message ?? ""}`,
        retryable: false,
      });
    case "23502":
      return new AppError({
        code: "VALIDATION_FAILED",
        message: `${action}失败：必填字段缺失`,
        detail: `not_null_violation: ${pgError.detail ?? pgError.message ?? ""}`,
        retryable: false,
      });
    case "22P02":
      return new AppError({
        code: "VALIDATION_FAILED",
        message: `${action}失败：参数格式不正确`,
        detail: `invalid_text_representation: ${pgError.detail ?? pgError.message ?? ""}`,
        retryable: false,
      });
    case "42P01":
      return new AppError({
        code: "DB_ERROR",
        message: "数据表尚未创建",
        detail: `undefined_table: ${
          pgError.message ?? ""
        }。请先执行 pnpm db:migrate 应用迁移。`,
        retryable: false,
      });
    default:
      return new AppError({
        code: "DB_ERROR",
        message: `${action}失败，请稍后重试`,
        detail: `${pgError.code}: ${pgError.message ?? ""}`,
      });
  }
}
