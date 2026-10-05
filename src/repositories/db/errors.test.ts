import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/result";

import { mapDatabaseError } from "./errors";

/** 构造一个形似 postgres.js 错误的异常 */
function postgresError(code: string, extra: Record<string, string> = {}): Error {
  return Object.assign(new Error(`pg error ${code}`), { code, ...extra });
}

describe("mapDatabaseError", () => {
  it("AppError 原样返回，避免二次包装丢失错误码", () => {
    const original = new AppError({ code: "NOT_FOUND", message: "商品不存在" });
    expect(mapDatabaseError(original, "更新商品")).toBe(original);
  });

  it("唯一约束冲突 → DB_ERROR 且不可重试", () => {
    const error = mapDatabaseError(
      postgresError("23505", { constraint_name: "products_business_name_unique" }),
      "创建商品",
    );
    expect(error.code).toBe("DB_ERROR");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("已存在");
  });

  it("外键冲突 → 提示关联数据不存在", () => {
    const error = mapDatabaseError(postgresError("23503"), "创建商品");
    expect(error.code).toBe("DB_ERROR");
    expect(error.message).toContain("关联数据");
  });

  it("uuid 格式错误 → VALIDATION_FAILED", () => {
    expect(mapDatabaseError(postgresError("22P02"), "加载商品详情").code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("表不存在 → 提示先执行迁移", () => {
    const error = mapDatabaseError(postgresError("42P01"), "加载商品列表");
    expect(error.code).toBe("DB_ERROR");
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain("pnpm db:migrate");
  });

  it("未知异常 → DB_ERROR 且可重试，detail 保留原始信息", () => {
    const error = mapDatabaseError(new Error("connection reset"), "加载商品列表");
    expect(error.code).toBe("DB_ERROR");
    expect(error.retryable).toBe(true);
    expect(error.detail).toContain("connection reset");
  });

  it("非 Error 抛出物也能处理", () => {
    expect(mapDatabaseError("boom", "加载商品列表").detail).toBe("boom");
    expect(mapDatabaseError(undefined, "加载商品列表").code).toBe("DB_ERROR");
  });
});
