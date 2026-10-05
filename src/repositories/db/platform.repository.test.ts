import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getDb } from "@/db";
import { agentTasks, businesses, customerConversations, customerMessages, products, users } from "@/db/schema";
import { createDbPlatformRepository } from "./platform.repository";
import { describeDbSuite, prepareDbForTests } from "./db-integration";

describeDbSuite("管理端持久化与平台统计", () => {
  const repo = createDbPlatformRepository(); let businessId = "", knowledgeId = "", taskId = "";
  beforeAll(async () => { await prepareDbForTests(); businessId = (await getDb().insert(businesses).values({ name: "管理端集成测试商户", shortName: "管理测试", location: "测试地区" }).returning())[0].id; });
  afterAll(async () => { if (taskId) await getDb().delete(agentTasks).where(eq(agentTasks.id, taskId)); if (knowledgeId) await repo.deleteKnowledge(knowledgeId); if (businessId) await getDb().delete(businesses).where(eq(businesses.id, businessId)); });
  it("迁移初始化三条参考资料，商户公开读取仅返回已核验发布内容", async () => {
    const all = await repo.listKnowledge(), published = await repo.listKnowledge(true);
    expect(all.filter(row => row.id.startsWith("80000000-"))).toHaveLength(3);
    expect(published.some(row => row.title === "连江鲍鱼地理标志标准")).toBe(true);
    expect(published.some(row => row.title === "冷链运输包赔标准")).toBe(false);
  });
  it("新增、编辑、发布、归档和删除实际入库；非法发布被数据库约束拒绝", async () => {
    const draft = { title: "集成测试公共知识", category: "品质规范" as const, content: "本条用于验证公共知识库实际持久化。", sourceName: "测试资料", sourceUrl: "", tags: ["集成测试"], status: "draft" as const, verified: false };
    const saved = await repo.saveKnowledge(null, draft, "test-admin"); knowledgeId = saved!.id;
    expect((await repo.listKnowledge()).find(row => row.id === knowledgeId)).toMatchObject(draft);
    expect((await repo.listKnowledge(true)).some(row => row.id === knowledgeId)).toBe(false);
    await expect(repo.saveKnowledge(knowledgeId, { ...draft, status: "published" }, "test-admin")).rejects.toThrow();
    const updated = await repo.saveKnowledge(knowledgeId, { ...draft, status: "published", verified: true, content: "更新后的正文已核对并用于验证公开读取。" }, "second-admin");
    expect(updated).toMatchObject({ updatedBy: "second-admin", status: "published" });
    expect((await repo.listKnowledge(true)).find(row => row.id === knowledgeId)).toMatchObject({ verified: true, updatedBy: "second-admin" });
    await repo.saveKnowledge(knowledgeId, { ...draft, status: "archived" }, "second-admin"); expect((await repo.listKnowledge(true)).some(row => row.id === knowledgeId)).toBe(false);
    expect(await repo.deleteKnowledge(knowledgeId)).toBe(true); expect(await repo.saveKnowledge(knowledgeId, draft, "test-admin")).toBeNull(); expect(await repo.deleteKnowledge(knowledgeId)).toBe(false); knowledgeId = "";
  });
  it("注册商户去重、客服咨询计数及失败任务脱敏按实际记录计算", async () => {
    await getDb().insert(users).values([{ businessId, email: `${randomUUID()}@example.test`, name: "测试甲", passwordHash: "test-only-hash" }, { businessId, email: `${randomUUID()}@example.test`, name: "测试乙", passwordHash: "test-only-hash" }]);
    const product = (await getDb().insert(products).values({ businessId, name: "测试手工鱼丸", category: "海产品" }).returning())[0];
    const conversation = (await getDb().insert(customerConversations).values({ businessId, customerName: "测试咨询" }).returning())[0];
    await getDb().insert(customerMessages).values({ conversationId: conversation.id, role: "customer", content: "如何保存" });
    const before = await repo.snapshot(new Date());
    const task = (await getDb().insert(agentTasks).values({ productId: product.id, agentType: "product_agent", title: "失败脱敏测试", status: "failed", input: { businessId }, durationMs: 1000, completedAt: new Date(), errorMessage: "Bearer hidden-key https://api.test/private" }).returning())[0]; taskId = task.id;
    const after = await repo.snapshot(new Date());
    expect(after.merchants).toBeGreaterThanOrEqual(1); expect(after.failed).toBe(before.failed + 1); expect(after.interactions).toBeGreaterThanOrEqual(1);
    expect(after.categories.some(row => row.name === "连江手工鱼丸")).toBe(true);
    const listed = after.recentTasks.find(row => row.id === taskId)!;
    expect(listed).toMatchObject({ businessName: "管理端集成测试商户", durationMs: 1000 }); expect(listed.errorSummary).not.toContain("hidden-key"); expect(listed.errorSummary).not.toContain("https://"); expect(listed).not.toHaveProperty("input"); expect(listed).not.toHaveProperty("output");
  });
});
