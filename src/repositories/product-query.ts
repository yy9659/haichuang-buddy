/**
 * 商品列表查询的归一化（纯函数）
 *
 * 为什么要独立成文件：
 * Mock 与数据库两个仓储实现必须对「第几页、每页多少条、关键词怎么裁」有
 * **完全一致**的解释，否则切数据源后分页行为会变。把这段逻辑收敛成纯函数，
 * 两边共用，并且可以脱离数据库单测。
 */

import type { Paginated, ProductFilter, ProductListQuery } from "./types";
import {
  DEFAULT_PRODUCT_PAGE_SIZE,
  MAX_PRODUCT_PAGE_SIZE,
} from "./types";

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : fallback;
}

export interface NormalizedProductQuery {
  /** 可直接下推给仓储实现的筛选条件（含 limit / offset） */
  filter: ProductFilter;
  page: number;
  pageSize: number;
}

/**
 * 归一化列表查询：页码从 1 开始，pageSize 限制在 [1, MAX]，
 * 关键词与分类的空值统一成 undefined（避免把 "" 当成筛选条件）。
 */
export function normalizeProductQuery(
  query?: Partial<ProductListQuery>,
): NormalizedProductQuery {
  const page = toPositiveInt(query?.page, 1);
  const pageSize = Math.min(
    toPositiveInt(query?.pageSize, DEFAULT_PRODUCT_PAGE_SIZE),
    MAX_PRODUCT_PAGE_SIZE,
  );

  const keyword = query?.keyword?.trim();

  const filter: ProductFilter = {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
  if (keyword) {
    filter.keyword = keyword;
  }
  if (query?.category) {
    filter.category = query.category;
  }
  if (query?.analysisStatus) {
    filter.analysisStatus = query.analysisStatus;
  }

  return { filter, page, pageSize };
}

/**
 * 组装分页信封。
 * total 为 0 时 totalPages 取 1 —— 前端展示「第 1 / 1 页」比「第 1 / 0 页」自然，
 * 分页按钮也用同一口径判断禁用状态。
 */
export function buildPaginated<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): Paginated<T> {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  return {
    items,
    total: safeTotal,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(safeTotal / pageSize)),
  };
}

/** 去掉分页窗口，只保留筛选条件（统计总数时必须用这个口径） */
export function toScopeFilter(filter?: ProductFilter): ProductFilter {
  const scope: ProductFilter = {};
  if (filter?.keyword) {
    scope.keyword = filter.keyword;
  }
  if (filter?.category) {
    scope.category = filter.category;
  }
  if (filter?.analysisStatus) {
    scope.analysisStatus = filter.analysisStatus;
  }
  return scope;
}

/** 在内存集合上应用筛选与分页（Mock 实现使用；语义与 SQL 版保持一致） */
export function applyProductFilterInMemory<T extends {
  name: string;
  subCategory: string;
  origin: string;
  description: string;
  tags: string[];
  category: string;
  analysisStatus: string;
}>(items: T[], filter?: ProductFilter): T[] {
  if (!filter) {
    return [...items];
  }

  const keyword = filter.keyword?.trim().toLowerCase();
  const matched = items.filter((item) => {
    if (filter.analysisStatus && item.analysisStatus !== filter.analysisStatus) {
      return false;
    }
    if (filter.category && item.category !== filter.category) {
      return false;
    }
    if (keyword) {
      const haystack = [
        item.name,
        item.subCategory,
        item.origin,
        item.description,
        item.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(keyword)) {
        return false;
      }
    }
    return true;
  });

  const offset = filter.offset && filter.offset > 0 ? filter.offset : 0;
  const end = filter.limit ? offset + filter.limit : undefined;
  return matched.slice(offset, end);
}
