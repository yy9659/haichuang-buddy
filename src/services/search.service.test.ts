import { describe, expect, it, vi } from "vitest";
import { searchDashboard } from "./search.service";
import { escapeSearchLike, matchesSearch, normalizeSearchQuery, SEARCH_GROUP_LIMIT } from "@/lib/dashboard-search";
import { MOCK_BUSINESS } from "@/lib/mock";
import { createMockSearchRepository } from "@/repositories/mock/search";
import type { SearchRecords, SearchRepository } from "@/types/search";

describe("首页检索", () => {
  it("大小写、全角文字、多空格与多关键词匹配；通配符按原文", () => {
    expect(normalizeSearchQuery("  Ｅｘｃｅｌ\n  鱼丸 ")).toBe("Excel 鱼丸");
    expect(matchesSearch("海报 鱼丸推广", "鱼丸 海报")).toBe(true);
    expect(matchesSearch("鱼丸推广", "鱼丸 海报")).toBe(false);
    expect(matchesSearch("普通商品", "%")).toBe(false);
    expect(escapeSearchLike("50%_\\" )).toBe("50\\%\\_\\\\");
  });
  it("空关键词展示常用入口，过长关键词拒绝查询", async () => {
    const search = vi.fn(), repository = { search };
    const result = await searchDashboard("current-business", "   ", repository);
    expect(result.groups[0]).toMatchObject({ kind: "action", label: "常用操作" });
    expect(search).not.toHaveBeenCalled();
    await expect(searchDashboard("current-business", "鱼".repeat(81), repository)).rejects.toThrow();
    await expect(searchDashboard("", "鱼丸", repository)).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });
  it("搜索结果有上限，素材槽位和历史任务链接定位到原记录", async () => {
    const records: SearchRecords = {
      products: Array.from({ length: 5 }, (_, index) => ({ id: `product-${index}`, title: "鱼丸", excerpt: "福建连江手工鱼丸", status: "analyzed" })),
      contents: [{ id: "content-1", title: "好吃的鱼丸", excerpt: "手打鱼丸", productId: "product & 1", productName: "鱼丸", platform: "wechat", format: "poster-copy", status: "draft" }],
      workflows: [{ id: "workflow-old", title: "推广鱼丸", excerpt: "2026-09-01 10:00", status: "completed" }],
    };
    const search = vi.fn().mockResolvedValue(records);
    const result = await searchDashboard("current-business", "鱼丸", { search });
    expect(search).toHaveBeenCalledWith("current-business", "鱼丸", SEARCH_GROUP_LIMIT + 1);
    const product = result.groups.find(group => group.kind === "product")!;
    expect(product.items).toHaveLength(4); expect(product.hasMore).toBe(true);
    const link = new URL(result.groups.find(group => group.kind === "content")!.items[0].href, "http://localhost");
    expect(link.searchParams.get("productId")).toBe("product & 1"); expect(link.searchParams.get("format")).toBe("poster-copy"); expect(link.hash).toBe("#content-assets");
    expect(result.groups.find(group => group.kind === "workflow")!.items[0].href).toBe("/dashboard?workflow=workflow-old#recent-tasks");
  });
  it("格式异常的旧素材不生成无法打开的链接，未命中返回空结果", async () => {
    const repository: SearchRepository = { search: async () => ({ products: [], workflows: [], contents: [{ id: "bad", title: "未知格式", excerpt: "", status: "draft", productId: "p", format: "old-format", platform: "wechat" }] }) };
    expect((await searchDashboard("business", "不匹配的词", repository)).groups).toEqual([]);
  });
  it("海报、视频和销售词语可以找到实际模块入口", async () => {
    const repository: SearchRepository = { search: async () => ({ products: [], workflows: [], contents: [] }) };
    expect((await searchDashboard("business", "海报", repository)).groups[0].items[0].href).toBe("/content?format=poster-copy");
    expect((await searchDashboard("business", "销售", repository)).groups[0].items[0].href).toBe("/analytics#sales-import");
  });
  it("Mock 搜商品和对应内容，演示商家以外不泄漏种子记录", async () => {
    const repository = createMockSearchRepository();
    const own = await repository.search(MOCK_BUSINESS.id, "鱼丸", 5);
    expect(own.products.some(item => item.title.includes("鱼丸"))).toBe(true);
    expect(await repository.search("foreign-business", "鱼丸", 5)).toEqual({ products: [], contents: [], workflows: [] });
  });
});
