import { MOCK_BUSINESS } from "@/lib/mock";
import { matchesSearch } from "@/lib/dashboard-search";
import { CONTENT_FORMAT_LABEL, CONTENT_PLATFORM_LABEL, CONTENT_STATUS_META, PRODUCT_ANALYSIS_META, WORKFLOW_STATUS_META } from "@/lib/status-meta";
import type { SearchRecords, SearchRepository } from "@/types/search";
import { listStoredAgentWorkflows, listStoredContents, listStoredProducts } from "./store";

export function createMockSearchRepository(): SearchRepository {
  return {
    async search(businessId, query, limit): Promise<SearchRecords> {
      // Mock 商品、素材属于内置演示商家；工作流自身记录所属商家。
      const take = Math.min(Math.max(Math.trunc(limit), 1), 10);
      const products = businessId === MOCK_BUSINESS.id ? listStoredProducts() : [];
      const names = new Map(products.map(item => [item.id, item.name]));
      return {
        products: products.filter(item => matchesSearch(`${item.name} ${item.description} ${item.category} ${item.subCategory} ${item.origin} ${item.specification} ${item.tags.join(" ")} ${PRODUCT_ANALYSIS_META[item.analysisStatus].label}`, query))
          .sort((a, b) => Number(b.name === query) - Number(a.name === query) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, take)
          .map(item => ({ id: item.id, title: item.name, excerpt: [item.origin, item.specification, item.description].filter(Boolean).join(" · "), status: item.analysisStatus })),
        contents: (businessId === MOCK_BUSINESS.id ? listStoredContents() : []).filter(item => names.has(item.productId) && matchesSearch(`${item.title} ${item.hook} ${item.body} ${item.cta} ${item.productName} ${names.get(item.productId)} ${item.hashtags.join(" ")} ${CONTENT_PLATFORM_LABEL[item.platform]} ${CONTENT_FORMAT_LABEL[item.format]} ${CONTENT_STATUS_META[item.status].label}`, query))
          .sort((a, b) => Number(b.title === query) - Number(a.title === query) || (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)).slice(0, take)
          .map(item => ({ id: item.id, title: item.title, excerpt: `${item.hook} ${item.body}`, status: item.status, productId: item.productId, productName: names.get(item.productId), platform: item.platform, format: item.format })),
        workflows: listStoredAgentWorkflows().filter(item => item.businessId === businessId && matchesSearch(`${item.goal} ${WORKFLOW_STATUS_META[item.status].label}`, query))
          .sort((a, b) => Number(b.goal === query) - Number(a.goal === query) || b.createdAt.localeCompare(a.createdAt)).slice(0, take)
          .map(item => ({ id: item.id, title: item.goal, excerpt: item.createdAt, status: item.status })),
      };
    },
  };
}
