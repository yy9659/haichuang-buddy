import { describe, expect, it } from "vitest";
import { resolveRoleRedirect } from "./auth-redirect";

describe("管理员与商户登录后进入各自界面", () => {
  it("管理员默认进入管理端，商户旧链接不能带回业务界面", () => {
    for (const path of [undefined, "/dashboard", "/products", "/content", "/public-knowledge", "/analytics"]) {
      expect(resolveRoleRedirect(path, true)).toBe("/admin");
    }
    expect(resolveRoleRedirect("/admin/monitor?status=failed", true)).toBe("/admin/monitor?status=failed");
    expect(resolveRoleRedirect("/admin/knowledge", true)).toBe("/admin/knowledge");
  });
  it("普通商户保留业务落地页，管理端链接回工作台", () => {
    expect(resolveRoleRedirect(undefined, false)).toBe("/dashboard");
    expect(resolveRoleRedirect("/products?category=seafood", false)).toBe("/products?category=seafood");
    expect(resolveRoleRedirect("/admin", false)).toBe("/dashboard");
    expect(resolveRoleRedirect("/admin/knowledge", false)).toBe("/dashboard");
  });
  it("规范化相对片段，阻止通过旧 next 参数跳错界面", () => {
    expect(resolveRoleRedirect("/admin/../products", true)).toBe("/admin");
    expect(resolveRoleRedirect("/products/../admin/knowledge", false)).toBe("/dashboard");
    expect(resolveRoleRedirect("/administrator", true)).toBe("/admin");
  });
  it("拦截站外跳转，登录页和注册页不会形成循环", () => {
    for (const isAdmin of [true, false]) {
      const home = isAdmin ? "/admin" : "/dashboard";
      for (const path of ["https://example.test", "//example.test", "/\\example.test", "/", "/login", "/register?next=/login"]) expect(resolveRoleRedirect(path, isAdmin)).toBe(home);
    }
  });
});
