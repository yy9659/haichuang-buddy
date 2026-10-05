import { normalizeSearchQuery, SEARCH_GROUP_LIMIT, SEARCH_MAX_LENGTH, searchExcerpt, searchShortcuts } from "@/lib/dashboard-search";
import { isContentFormat, isContentPlatform } from "@/lib/content-options";
import { CONTENT_FORMAT_LABEL, CONTENT_PLATFORM_LABEL, CONTENT_STATUS_META, PRODUCT_ANALYSIS_META, WORKFLOW_STATUS_META } from "@/lib/status-meta";
import { getSearchRepository } from "@/repositories/search";
import type { DashboardSearchResponse, SearchGroup, SearchItem, SearchRepository } from "@/types/search";

export async function searchDashboard(businessId: string, input: string, repository: SearchRepository = getSearchRepository()): Promise<DashboardSearchResponse> {
  const query = normalizeSearchQuery(input);
  if (!businessId || query.length > SEARCH_MAX_LENGTH) throw new Error("搜索参数无效");
  const actions = searchShortcuts(query);
  if (!query) return { query, groups: [{ kind: "action", label: "常用操作", items: actions, hasMore: false }] };
  const records = await repository.search(businessId, query, SEARCH_GROUP_LIMIT + 1);
  const group = (kind: SearchGroup["kind"], label: string, items: SearchItem[]): SearchGroup => ({ kind, label, items: items.slice(0, SEARCH_GROUP_LIMIT), hasMore: items.length > SEARCH_GROUP_LIMIT });
  const groups: SearchGroup[] = [
    group("product", "商品档案", records.products.map(item => ({ id: item.id, kind: "product", title: item.title, description: searchExcerpt(item.excerpt, query) || "查看商品资料与卖点", href: `/products/${encodeURIComponent(item.id)}`, badge: PRODUCT_ANALYSIS_META[item.status as keyof typeof PRODUCT_ANALYSIS_META]?.label }))),
    group("content", "推广素材", records.contents.flatMap(item => {
      if (!item.productId || !isContentPlatform(item.platform) || !isContentFormat(item.format)) return [];
      const params = new URLSearchParams({ productId: item.productId, platform: item.platform, format: item.format });
      return [{ id: item.id, kind: "content" as const, title: item.title || "未命名素材", description: `${item.productName} · ${CONTENT_PLATFORM_LABEL[item.platform]} · ${CONTENT_FORMAT_LABEL[item.format]} · ${searchExcerpt(item.excerpt, query, 40)}`, href: `/content?${params}#content-assets`, badge: CONTENT_STATUS_META[item.status as keyof typeof CONTENT_STATUS_META]?.label }];
    })),
    group("workflow", "经营任务", records.workflows.map(item => ({ id: item.id, kind: "workflow", title: item.title, description: `创建于 ${item.excerpt} · 查看本轮计划与执行结果`, href: `/dashboard?workflow=${encodeURIComponent(item.id)}#recent-tasks`, badge: WORKFLOW_STATUS_META[item.status as keyof typeof WORKFLOW_STATUS_META]?.label }))),
    group("action", "相关操作", actions),
  ];
  return { query, groups: groups.filter(item => item.items.length > 0) };
}
