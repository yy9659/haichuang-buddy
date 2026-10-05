export type SearchKind = "product" | "content" | "workflow" | "action";

export interface SearchItem {
  id: string;
  kind: SearchKind;
  title: string;
  description: string;
  href: string;
  badge?: string;
}

export interface SearchGroup {
  kind: SearchKind;
  label: string;
  items: SearchItem[];
  hasMore: boolean;
}

export interface DashboardSearchResponse {
  query: string;
  groups: SearchGroup[];
}

/** 仓储只返回结果摘要，不返回图片、完整文案、模型输入或任务日志。 */
export interface SearchRecord {
  id: string;
  title: string;
  excerpt: string;
  status: string;
  productId?: string;
  productName?: string;
  platform?: string;
  format?: string;
}

export interface SearchRecords {
  products: SearchRecord[];
  contents: SearchRecord[];
  workflows: SearchRecord[];
}

export interface SearchRepository {
  search(businessId: string, query: string, limit: number): Promise<SearchRecords>;
}
