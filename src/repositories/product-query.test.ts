/**
 * 列表查询归一化的单测
 *
 * 这层逻辑被 Mock 与数据库两个仓储实现共用，一旦口径不一致，
 * 就会出现「切数据源后分页行为变了」这类很难排查的问题，因此重点覆盖边界。
 */

import { describe, expect, it } from "vitest";

import {
  applyProductFilterInMemory,
  buildPaginated,
  normalizeProductQuery,
  toScopeFilter,
} from "./product-query";
import { DEFAULT_PRODUCT_PAGE_SIZE, MAX_PRODUCT_PAGE_SIZE } from "./types";

interface Row {
  name: string;
  subCategory: string;
  origin: string;
  description: string;
  tags: string[];
  category: string;
  analysisStatus: string;
}

const ROWS: Row[] = [
  {
    name: "连江鲜活鲍鱼",
    subCategory: "鲍鱼",
    origin: "福建连江 · 黄岐半岛",
    description: "当日捕捞",
    tags: ["鲜活"],
    category: "海产品",
    analysisStatus: "analyzed",
  },
  {
    name: "黄岐海带",
    subCategory: "海带",
    origin: "福建连江",
    description: "天然日晒",
    tags: ["日晒"],
    category: "干货",
    analysisStatus: "pending",
  },
  {
    name: "连江手工鱼丸",
    subCategory: "鱼丸",
    origin: "福建连江",
    description: "手工捶打",
    tags: ["火锅必备"],
    category: "预制菜",
    analysisStatus: "failed",
  },
  {
    name: "节庆海产礼盒",
    subCategory: "礼盒",
    origin: "福建连江",
    description: "鲍鱼 + 海带组合",
    tags: ["送礼"],
    category: "礼盒",
    analysisStatus: "analyzed",
  },
];

describe("normalizeProductQuery", () => {
  it("缺省时使用默认页码与分页大小", () => {
    const query = normalizeProductQuery();
    expect(query.page).toBe(1);
    expect(query.pageSize).toBe(DEFAULT_PRODUCT_PAGE_SIZE);
    expect(query.filter).toEqual({
      limit: DEFAULT_PRODUCT_PAGE_SIZE,
      offset: 0,
    });
  });

  it("页码从 1 开始换算成 offset", () => {
    const query = normalizeProductQuery({ page: 3, pageSize: 10 });
    expect(query.filter.offset).toBe(20);
    expect(query.filter.limit).toBe(10);
  });

  it("pageSize 被限制在上限内，非法页码退回 1", () => {
    expect(normalizeProductQuery({ pageSize: 10_000 }).pageSize).toBe(
      MAX_PRODUCT_PAGE_SIZE,
    );
    expect(normalizeProductQuery({ page: 0 }).page).toBe(1);
    expect(normalizeProductQuery({ page: -5 }).page).toBe(1);
    expect(normalizeProductQuery({ pageSize: 0 }).pageSize).toBe(
      DEFAULT_PRODUCT_PAGE_SIZE,
    );
  });

  it("空白关键词不作为筛选条件", () => {
    expect(normalizeProductQuery({ keyword: "   " }).filter.keyword).toBeUndefined();
    expect(normalizeProductQuery({ keyword: " 鲍鱼 " }).filter.keyword).toBe("鲍鱼");
  });

  it("分类与分析状态原样下推", () => {
    const query = normalizeProductQuery({
      category: "海产品",
      analysisStatus: "analyzed",
    });
    expect(query.filter.category).toBe("海产品");
    expect(query.filter.analysisStatus).toBe("analyzed");
  });
});

describe("buildPaginated", () => {
  it("计算总页数（向上取整）", () => {
    const page = buildPaginated([1, 2, 3], 10, 1, 3);
    expect(page.total).toBe(10);
    expect(page.totalPages).toBe(4);
  });

  it("空结果时总页数取 1，便于界面展示「第 1 / 1 页」", () => {
    expect(buildPaginated([], 0, 1, 9).totalPages).toBe(1);
  });

  it("total 非法时收敛为 0", () => {
    expect(buildPaginated([], Number.NaN, 1, 9).total).toBe(0);
    expect(buildPaginated([], -3, 1, 9).total).toBe(0);
  });
});

describe("toScopeFilter", () => {
  it("剥离分页窗口，只保留筛选条件", () => {
    expect(
      toScopeFilter({
        keyword: "鲍鱼",
        category: "海产品",
        analysisStatus: "analyzed",
        limit: 9,
        offset: 18,
      }),
    ).toEqual({
      keyword: "鲍鱼",
      category: "海产品",
      analysisStatus: "analyzed",
    });
  });

  it("空筛选返回空对象（用于统计全量）", () => {
    expect(toScopeFilter()).toEqual({});
    expect(toScopeFilter({ limit: 9, offset: 0 })).toEqual({});
  });
});

describe("applyProductFilterInMemory", () => {
  it("关键词匹配名称 / 子类目 / 产地 / 描述 / 标签", () => {
    expect(applyProductFilterInMemory(ROWS, { keyword: "鲍鱼" })).toHaveLength(2);
    expect(applyProductFilterInMemory(ROWS, { keyword: "黄岐" })).toHaveLength(2);
    expect(applyProductFilterInMemory(ROWS, { keyword: "火锅" })).toHaveLength(1);
    expect(applyProductFilterInMemory(ROWS, { keyword: "不存在" })).toHaveLength(0);
  });

  it("分类与分析状态可叠加", () => {
    expect(
      applyProductFilterInMemory(ROWS, {
        category: "海产品",
        analysisStatus: "analyzed",
      }),
    ).toHaveLength(1);
  });

  it("分页窗口生效", () => {
    expect(applyProductFilterInMemory(ROWS, { limit: 2 })).toHaveLength(2);
    expect(
      applyProductFilterInMemory(ROWS, { limit: 2, offset: 2 }).map((r) => r.name),
    ).toEqual(["连江手工鱼丸", "节庆海产礼盒"]);
    expect(applyProductFilterInMemory(ROWS, { offset: 10 })).toHaveLength(0);
  });

  it("不过滤但返回副本，避免调用方改到源数组", () => {
    const result = applyProductFilterInMemory(ROWS);
    expect(result).toHaveLength(ROWS.length);
    expect(result).not.toBe(ROWS);
  });
});
