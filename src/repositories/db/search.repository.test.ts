import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getDb } from "@/db";
import { agentWorkflows, businesses, contents, products } from "@/db/schema";
import { createDbSearchRepository } from "./search.repository";
import { describeDbSuite, prepareDbForTests } from "./db-integration";

describeDbSuite("跨模块检索真实数据库", () => {
  const repository = createDbSearchRepository();
  const owned: string[] = []; let own = "", foreign = "", productId = "", contentId = "", workflowId = "";
  beforeAll(async () => {
    await prepareDbForTests();
    for (const name of ["搜索测试甲", "搜索测试乙"]) owned.push((await getDb().insert(businesses).values({ name: `${name}-${randomUUID()}`, shortName: name }).returning())[0].id);
    [own, foreign] = owned;
    productId = (await getDb().insert(products).values({ businessId: own, name: "连江手工鱼丸", category: "海产品", origin: "福建连江", description: "现做鱼丸，新鲜弹牙", tags: ["手打"] }).returning())[0].id;
    const otherProduct = (await getDb().insert(products).values({ businessId: foreign, name: "连江手工鱼丸", category: "海产品", description: "别人的私有商品" }).returning())[0];
    contentId = (await getDb().insert(contents).values({ businessId: own, productId, productName: "旧商品名", platform: "wechat", format: "poster-copy", title: "一丸三吃", body: "晚餐煮汤，热乎好吃", status: "approved" }).returning())[0].id;
    await getDb().insert(contents).values({ businessId: foreign, productId: otherProduct.id, platform: "wechat", format: "poster-copy", title: "他人的鱼丸海报" });
    // 即使旧记录错误地挂了另一个商家的商品，也不能透出那件商品。
    await getDb().insert(contents).values({ businessId: own, productId: otherProduct.id, platform: "douyin", format: "short-video", title: "异常归属鱼丸素材" });
    workflowId = (await getDb().insert(agentWorkflows).values({ businessId: own, goal: "为鱼丸准备朋友圈海报", status: "completed", createdAt: new Date("2025-01-01") }).returning())[0].id;
    await getDb().insert(agentWorkflows).values({ businessId: foreign, goal: "为鱼丸准备朋友圈海报", status: "failed" });
    await getDb().insert(products).values([{ businessId: own, name: "含100%_\\符号的鱼丸", category: "海产品" }, ...Array.from({ length: 8 }, (_, index) => ({ businessId: own, name: `批次鱼丸${index}`, category: "海产品" as const }))]);
  });
  afterAll(async () => { for (const id of owned) await getDb().delete(businesses).where(eq(businesses.id, id)); });

  it("全部类别按会话商户筛选，错误归属素材也被排除", async () => {
    const result = await repository.search(own, "鱼丸", 10);
    expect(result.products.some(item => item.id === productId)).toBe(true);
    expect(result.contents.map(item => item.id)).toEqual([contentId]);
    expect(result.workflows.map(item => item.id)).toEqual([workflowId]);
    expect(result.products.some(item => item.excerpt.includes("别人的"))).toBe(false);
    expect(await repository.search(randomUUID(), "鱼丸", 5)).toEqual({ products: [], contents: [], workflows: [] });
  });
  it("跨字段多关键词、中文内容类型与状态可检索", async () => {
    const result = await repository.search(own, "鱼丸 朋友圈 海报 已确认", 5);
    expect(result.contents.map(item => item.id)).toEqual([contentId]);
    expect(result.products).toHaveLength(0); expect(result.workflows).toHaveLength(0);
    expect((await repository.search(own, "晚餐", 5)).contents[0].id).toBe(contentId);
    expect((await repository.search(own, "福建 手打", 5)).products[0].id).toBe(productId);
  });
  it("通配符、反斜杠和注入文本仅作文字匹配，结果数量有上限", async () => {
    for (const query of ["%", "_", "\\", "100%_\\"]) expect((await repository.search(own, query, 10)).products.map(item => item.title)).toEqual(["含100%_\\符号的鱼丸"]);
    expect(await repository.search(own, "' OR 1=1 --", 10)).toEqual({ products: [], contents: [], workflows: [] });
    expect((await repository.search(own, "鱼丸", 5)).products).toHaveLength(5);
  });
});
