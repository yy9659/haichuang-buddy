import { expect, it, vi } from "vitest";

it("页面和 Route Handler 重复加载 Mock 模块后仍读取同一份新商品、素材、工作流和会话", async () => {
  const first = await import("./store");
  const product = { ...first.listStoredProducts()[0], id: "shared-search-product", name: "跨接口新增鱼丸" };
  const content = { ...first.listStoredContents()[0], id: "shared-search-content", productId: product.id, title: "跨接口新海报" };
  first.putStoredProduct(product); first.putStoredContent(content);
  first.putStoredAgentWorkflow({ id: "shared-search-workflow", businessId: "business", goal: "跨接口新目标", status: "idle", plan: null, summary: null, errorMessage: null, createdAt: "2026-10-04 10:00", completedAt: null });
  first.putStoredUser({ id: "shared-search-user", email: "search-state@example.test", businessId: "business", name: "测试", passwordHash: "test-only", createdAt: "2026-10-04" });
  first.putStoredSession({ id: "shared-search-session", userId: "shared-search-user", tokenHash: "test-only-hash", createdAt: new Date(), expiresAt: new Date(Date.now() + 100000), lastUsedAt: new Date() });
  try {
    vi.resetModules();
    const second = await import("./store");
    expect(second.findStoredProduct(product.id)).toBe(product);
    expect(second.listStoredContents().find(item => item.id === content.id)).toBe(content);
    expect(second.findStoredAgentWorkflow("shared-search-workflow")?.goal).toBe("跨接口新目标");
    expect(second.findStoredUserById("shared-search-user")?.name).toBe("测试");
    expect(second.findStoredSessionByTokenHash("test-only-hash")?.userId).toBe("shared-search-user");
  } finally {
    first.removeStoredProduct(product.id); first.removeStoredAgentWorkflow("shared-search-workflow");
    first.removeStoredSessionByTokenHash("test-only-hash");
    const users = first.listStoredUsers(); const index = users.findIndex(item => item.id === "shared-search-user"); if (index >= 0) users.splice(index, 1);
  }
});
