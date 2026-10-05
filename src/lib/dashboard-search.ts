import type { SearchItem } from "@/types/search";

export const SEARCH_MAX_LENGTH = 80;
export const SEARCH_GROUP_LIMIT = 4;

export function normalizeSearchQuery(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function searchTokens(query: string): string[] {
  return normalizeSearchQuery(query).toLocaleLowerCase().split(" ").filter(Boolean);
}

/** 用户输入中的 %、_ 和反斜杠按普通文字匹配。 */
export function escapeSearchLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function matchesSearch(text: string, query: string): boolean {
  const haystack = normalizeSearchQuery(text).toLocaleLowerCase();
  return searchTokens(query).every(token => haystack.includes(token));
}

export function searchExcerpt(text: string, query: string, length = 72): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const first = searchTokens(query).find(token => normalized.toLocaleLowerCase().includes(token));
  const at = first ? normalized.toLocaleLowerCase().indexOf(first) : 0;
  const start = Math.max(0, at - 18);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, start + length)}${normalized.length > start + length ? "…" : ""}`;
}

const shortcuts: (SearchItem & { keywords: string })[] = [
  { id: "products", kind: "action", title: "管理商品资料", description: "添加商品、上传照片、分析卖点", href: "/products", keywords: "商品经理 商品中心 档案 录入 添加 上传 图片 照片 重新分析" },
  { id: "poster", kind: "action", title: "制作营销海报", description: "选择商品，生成海报文案与可下载海报", href: "/content?format=poster-copy", keywords: "推广素材 内容运营 海报 营销文案 设计 下载" },
  { id: "video", kind: "action", title: "生成短视频脚本", description: "为商品准备分镜和视频旁白", href: "/content?format=short-video", keywords: "推广素材 内容运营 抖音 视频 脚本 分镜 旁白" },
  { id: "sales", kind: "action", title: "记录销售与查看经营建议", description: "记一笔销售、导入流水、分析成本和收入", href: "/analytics#sales-import", keywords: "经营复盘 经营分析师 销售 记录 流水 Excel CSV 导入 收入 成本 利润 建议" },
  { id: "live", kind: "action", title: "练习直播话术", description: "模拟观众提问，准备直播回答", href: "/live", keywords: "直播导演 直播彩排 练习 话术 提问" },
  { id: "service", kind: "action", title: "准备顾客回复", description: "根据商品与知识资料回答顾客问题", href: "/customer-service", keywords: "智能客服 答疑助手 客服 回答 回复 顾客 咨询" },
  { id: "brand", kind: "action", title: "完善品牌介绍", description: "准备店铺定位与老板故事", href: "/brand", keywords: "品牌经理 品牌中心 店铺 介绍 定位 老板 故事" },
];

export function searchShortcuts(query = ""): SearchItem[] {
  const candidates = query ? shortcuts.filter(item => matchesSearch(`${item.title} ${item.description} ${item.keywords}`, query)) : shortcuts.slice(0, 4);
  return candidates.map(item => ({ id: item.id, kind: item.kind, title: item.title, description: item.description, href: item.href }));
}
