/**
 * 注册 / 登录输入校验的单元测试
 *
 * 这里锁的是两条**有意的取舍**：
 * 1. 邮箱大小写不敏感 —— 归一化在 schema 做，服务层只接受归一后的值；
 * 2. 登录**不校验密码长度** —— 让「密码必须 ≥8 位」成为登录接口的报错，
 *    等于顺手告诉对方「这个账号的密码不足 8 位」。
 */

import { describe, expect, it } from "vitest";

import {
  loginSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  registerSchema,
} from "./auth";

describe("registerSchema", () => {
  it("邮箱统一转小写并去空格（Foo@X.com 与 foo@x.com 是同一个账号）", () => {
    const parsed = registerSchema.parse({
      email: "  Foo@Example.COM  ",
      name: "陈老板",
      password: "haichuang-2026",
    });
    expect(parsed.email).toBe("foo@example.com");
  });

  it("密码短于下限被拒，且给出可读提示", () => {
    const result = registerSchema.safeParse({
      email: "a@b.com",
      name: "陈老板",
      password: "x".repeat(PASSWORD_MIN_LENGTH - 1),
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it("密码超过上限被拒（挡住「提交 10MB 字符串」这类请求）", () => {
    const result = registerSchema.safeParse({
      email: "a@b.com",
      name: "陈老板",
      password: "x".repeat(PASSWORD_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it("称呼为空被拒", () => {
    const result = registerSchema.safeParse({
      email: "a@b.com",
      name: "   ",
      password: "haichuang-2026",
    });
    expect(result.success).toBe(false);
  });

  it("邮箱格式不合法被拒", () => {
    const result = registerSchema.safeParse({
      email: "not-an-email",
      name: "陈老板",
      password: "haichuang-2026",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("**不**校验密码长度：短密码只会在「校验失败」里露出来，登录只管对不对", () => {
    const result = loginSchema.safeParse({ email: "a@b.com", password: "x" });
    expect(result.success).toBe(true);
  });

  it("仍然要求密码非空（空串属于「没填」，不是「密码错误」）", () => {
    const result = loginSchema.safeParse({ email: "a@b.com", password: "" });
    expect(result.success).toBe(false);
  });

  it("邮箱同样做归一化，保证登录能命中注册时写下的那一条", () => {
    const parsed = loginSchema.parse({
      email: "Foo@Example.COM",
      password: "whatever",
    });
    expect(parsed.email).toBe("foo@example.com");
  });
});
