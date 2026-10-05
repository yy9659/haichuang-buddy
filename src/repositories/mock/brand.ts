/**
 * 品牌档案仓储 · Mock 实现（S3-1）
 *
 * 与数据库实现保持同一套语义：
 * - 一个商家一份档案（对应 `brand_profiles_business_id_unique`），
 *   已存在时 create 直接报错，重新生成走 update；
 * - `completeness` 不接受外部传入，一律用 `../brand-profile` 的共享纯函数现算。
 *
 * 初始值为 null（尚未生成），因此界面先进入 empty 态 ——
 * 绝不让 Mock 预置一份「看着像 AI 产出」的假品牌档案。
 */

import { formatDateTime } from "@/lib/datetime";
import { AppError } from "@/lib/result";
import type { BrandProfile } from "@/types";

import { applyBrandProfilePatch, toBrandProfile } from "../brand-profile";
import type {
  BrandRepository,
  NewBrandProfileInput,
  UpdateBrandProfileInput,
} from "../types";
import { findStoredBrandProfile, putStoredBrandProfile } from "./store";

export function createMockBrandRepository(): BrandRepository {
  return {
    async getProfile(): Promise<BrandProfile | null> {
      return findStoredBrandProfile();
    },

    async create(input: NewBrandProfileInput): Promise<BrandProfile> {
      if (findStoredBrandProfile()) {
        throw new AppError({
          code: "DB_ERROR",
          message: "该商家已存在品牌档案",
          detail: "如需覆盖请调用 update（重新生成品牌策略）",
        });
      }
      const profile = toBrandProfile(input, {
        updatedAt: formatDateTime(new Date()),
      });
      putStoredBrandProfile(profile);
      return profile;
    },

    async update(patch: UpdateBrandProfileInput): Promise<BrandProfile> {
      const current = findStoredBrandProfile();
      if (!current) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "该商家尚未生成品牌档案",
          detail: "请先调用 create（首次生成品牌策略）",
        });
      }
      const next = applyBrandProfilePatch(current, patch, {
        updatedAt: formatDateTime(new Date()),
      });
      putStoredBrandProfile(next);
      return next;
    },
  };
}
