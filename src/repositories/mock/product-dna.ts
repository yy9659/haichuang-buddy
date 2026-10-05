import { formatDateTime } from "@/lib/datetime";
import { AppError } from "@/lib/result";
import type { ProductDNA } from "@/types";

import type {
  NewProductDnaInput,
  ProductDnaRepository,
  UpdateProductDnaInput,
} from "../types";
import { findStoredDna, putStoredDna } from "./store";

/** Product DNA 仓储的 Mock 实现 */
export function createMockProductDnaRepository(): ProductDnaRepository {
  return {
    async getByProductId(productId) {
      return findStoredDna(productId) ?? null;
    },

    async create(input: NewProductDnaInput) {
      if (findStoredDna(input.productId)) {
        throw new AppError({
          code: "DB_ERROR",
          message: "该商品已存在 Product DNA",
          detail: `productId=${input.productId}，如需覆盖请调用 update`,
        });
      }
      const dna: ProductDNA = {
        ...input,
        generatedAt: formatDateTime(new Date()),
      };
      putStoredDna(dna);
      return dna;
    },

    async update(productId: string, patch: UpdateProductDnaInput) {
      const current = findStoredDna(productId);
      if (!current) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "该商品尚未生成 Product DNA",
          detail: `productId=${productId}`,
        });
      }
      const next: ProductDNA = {
        ...current,
        ...patch,
        productId: current.productId,
        generatedAt: formatDateTime(new Date()),
      };
      putStoredDna(next);
      return next;
    },
  };
}
