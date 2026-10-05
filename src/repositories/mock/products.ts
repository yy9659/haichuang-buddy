import { createLocalId } from "@/lib/id";
import { formatDateTime } from "@/lib/datetime";
import { MOCK_BUSINESS } from "@/lib/mock";
import { AppError } from "@/lib/result";
import type { Product } from "@/types";

import {
  applyProductFilterInMemory,
  buildPaginated,
  normalizeProductQuery,
  toScopeFilter,
} from "../product-query";
import type {
  NewProductInput,
  ProductFilter,
  ProductRepository,
  UpdateProductInput,
} from "../types";
import {
  findStoredDna,
  findStoredProduct,
  listStoredProductIds,
  listStoredProducts,
  putStoredProduct,
  removeStoredProduct,
} from "./store";

/** 商品仓储的 Mock 实现（S0 起使用，S1-1 补齐写操作，S1-2 补分页与检索） */
export function createMockProductRepository(): ProductRepository {
  return {
    async list(filter: ProductFilter | undefined) {
      return applyProductFilterInMemory(listStoredProducts(), filter);
    },

    async count(filter?: ProductFilter) {
      // 统计时忽略分页窗口，否则永远得到「当前页条数」
      return applyProductFilterInMemory(
        listStoredProducts(),
        toScopeFilter(filter),
      ).length;
    },

    async listPage(query) {
      const { filter, page, pageSize } = normalizeProductQuery(query);
      const items = applyProductFilterInMemory(listStoredProducts(), filter);
      const total = applyProductFilterInMemory(
        listStoredProducts(),
        toScopeFilter(filter),
      ).length;
      return buildPaginated(items, total, page, pageSize);
    },

    async listIds() {
      return listStoredProductIds();
    },

    /**
     * 指定商家的商品数。
     *
     * Mock 只有内置商家持有全部种子商品 —— 与 `belongsToBusiness` 同一口径，
     * 传别的商家得到 0（而不是「所有商品都算你的」）。
     */
    async countForBusiness(businessId: string) {
      if (businessId !== MOCK_BUSINESS.id) {
        return 0;
      }
      return listStoredProducts().length;
    },

    async getById(id) {
      return findStoredProduct(id) ?? null;
    },

    /**
     * 单商家 Demo：内置商家拥有全部种子商品。
     *
     * 语义与数据库实现一致 —— 数据库那边查的是 `products.business_id`，
     * 这里查的是「商品存在，且问的是内置商家」。传别的商家 id 会得到 false，
     * 因此「跨商家挂商品」在 Mock 下同样会被拦下，不会等到上线才暴露。
     */
    async belongsToBusiness(businessId, productId) {
      return businessId === MOCK_BUSINESS.id && Boolean(findStoredProduct(productId));
    },

    async getDna(productId) {
      // 只覆盖已分析完成的商品，缺失即为「尚未生成」
      return findStoredDna(productId) ?? null;
    },

    async create(input: NewProductInput) {
      const now = new Date();
      const product: Product = {
        id: createLocalId("prod"),
        name: input.name,
        description: input.description ?? "",
        category: input.category,
        subCategory: input.subCategory ?? "",
        price: input.price,
        unit: input.unit ?? "",
        stock: input.stock ?? 0,
        origin: input.origin ?? "",
        specification: input.specification ?? "",
        storageMethod: input.storageMethod ?? "",
        shelfLife: input.shelfLife ?? "",
        imageUrl: input.imageUrl ?? null,
        analysisStatus: input.analysisStatus ?? "pending",
        updatedAt: formatDateTime(now),
        metrics: { views: 0, inquiries: 0, conversions: 0 },
        tags: input.tags ? [...input.tags] : [],
      };
      putStoredProduct(product);
      return product;
    },

    async update(id: string, patch: UpdateProductInput) {
      const current = findStoredProduct(id);
      if (!current) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "商品不存在或已被删除",
          detail: `productId=${id}`,
        });
      }
      const next: Product = {
        ...current,
        ...patch,
        // id 与经营数据不允许通过 update 覆盖
        id: current.id,
        metrics: current.metrics,
        tags: patch.tags ? [...patch.tags] : current.tags,
        imageUrl: patch.imageUrl === undefined ? current.imageUrl : patch.imageUrl,
        updatedAt: formatDateTime(new Date()),
      };
      Object.assign(current, next);
      return current;
    },

    async delete(id: string) {
      if (!removeStoredProduct(id)) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "商品不存在或已被删除",
          detail: `productId=${id}`,
        });
      }
    },
  };
}
