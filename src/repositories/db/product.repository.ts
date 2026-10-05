/**
 * 商品仓储 · 数据库实现（Drizzle + Supabase PostgreSQL）
 *
 * 职责边界：只管「怎么读写商品表」，不含任何业务规则与 AI 逻辑，
 * 也不做权限判断 —— 那些属于服务层与后续的 Agent 层。
 *
 * ## 但「这张表的哪几行属于你」是仓储层的事（S7）
 *
 * 与权限无关：`resolvePrimaryBusinessId()` 解析的是**租户范围**，
 * 而「当前商家是谁」的答案只有会话上下文知道（见 `./shared`）。
 * 因此商品列表 / 计数 / id 列表 / 更新 / 删除**一律**强制拼上
 * `business_id = 当前商家`，而不是交给调用方记得传。
 *
 * 这条约束不是可选的礼貌：少了它，第二个账号的商品列表里会出现
 * 第一个账号的商品，且改 / 删也照样生效 —— 不报错、不提示，
 * 只是安静地把别人的家底摊开、甚至替别人改掉。
 *
 * 越权的表现刻意与「不存在」完全一致（改 / 删命中 0 行 → `NOT_FOUND`）：
 * 分开返回等于提供了一个枚举接口，能探测出「哪些商品 id 真实存在」。
 *
 * 错误策略：所有数据库异常经 mapDatabaseError 收敛为 AppError，
 * 由服务层包成 Result 返回给页面。
 */

import { and, count as sqlCount, desc, eq, ilike, or, type SQL } from "drizzle-orm";

import { getDb } from "@/db";
import { products } from "@/db/schema";
import { isUuid } from "@/lib/id";
import { AppError } from "@/lib/result";
import type { Product } from "@/types";

import {
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
import { mapDatabaseError } from "./errors";
import { mapProductRow } from "./mappers";
import { createDbProductDnaRepository } from "./product-dna.repository";
import { resolvePrimaryBusinessId } from "./shared";

/**
 * 解析商品归属商家。
 *
 * 显式传入优先（`create` 与注册流程用），否则取**当前会话的商家**。
 * 「最早创建的一条」已经是历史：那是单商家时期的兜底，多账号下会让
 * 两个人共用同一份数据（无请求作用域的脚本仍然回落到它，见 `./shared`）。
 */
async function resolveBusinessId(explicit?: string): Promise<string> {
  return explicit ?? resolvePrimaryBusinessId();
}

/**
 * 列表 / 统计共用的条件：**第一个条件永远是「当前商家」**。
 *
 * 为什么不放进 `ProductFilter`：那会留下「某个调用方忘了传就不隔离」的口子，
 * 而这种漏法在单账号下完全看不出来。强制拼上才是安全的默认值。
 */
async function buildScopeConditions(
  filter: ProductFilter | undefined,
): Promise<SQL[]> {
  const businessId = await resolvePrimaryBusinessId();
  const conditions: SQL[] = [eq(products.businessId, businessId)];

  if (!filter) {
    return conditions;
  }
  if (filter.analysisStatus) {
    conditions.push(eq(products.analysisStatus, filter.analysisStatus));
  }
  if (filter.category) {
    conditions.push(eq(products.category, filter.category));
  }
  const keyword = filter.keyword?.trim();
  if (keyword) {
    const pattern = `%${keyword}%`;
    const keywordCondition = or(
      ilike(products.name, pattern),
      ilike(products.subCategory, pattern),
      ilike(products.origin, pattern),
      ilike(products.description, pattern),
    );
    if (keywordCondition) {
      conditions.push(keywordCondition);
    }
  }
  return conditions;
}

/** 列表查询（支持筛选 + 分页窗口）。limit / offset 缺省时不加限制 */
async function listProducts(filter?: ProductFilter): Promise<Product[]> {
  try {
    const conditions = await buildScopeConditions(filter);
    const base = getDb()
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(desc(products.updatedAt), desc(products.createdAt))
      // $dynamic 允许按需追加 limit / offset，且保持同一类型可赋值
      .$dynamic();

    const withLimit =
      filter?.limit !== undefined ? base.limit(filter.limit) : base;
    const withOffset =
      filter?.offset !== undefined ? withLimit.offset(filter.offset) : withLimit;

    const rows = await withOffset;
    return rows.map(mapProductRow);
  } catch (cause) {
    throw mapDatabaseError(cause, "加载商品列表");
  }
}

/**
 * 统计筛选后的商品总数。
 * 必须用 toScopeFilter 去掉 pagination 窗口，否则统计的是「当前页条数」。
 */
async function countProducts(filter?: ProductFilter): Promise<number> {
  try {
    const conditions = await buildScopeConditions(toScopeFilter(filter));
    const rows = await getDb()
      .select({ value: sqlCount() })
      .from(products)
      .where(and(...conditions));
    return Number(rows[0]?.value ?? 0);
  } catch (cause) {
    throw mapDatabaseError(cause, "统计商品数量");
  }
}

export function createDbProductRepository(): ProductRepository {
  return {
    list: listProducts,

    count: countProducts,

    async listPage(query) {
      const { filter, page, pageSize } = normalizeProductQuery(query);
      // 两次查询并发，减少一次往返
      const [items, total] = await Promise.all([
        listProducts(filter),
        countProducts(filter),
      ]);
      return buildPaginated(items, total, page, pageSize);
    },

    async listIds() {
      try {
        const businessId = await resolvePrimaryBusinessId();
        const rows = await getDb()
          .select({ id: products.id })
          .from(products)
          .where(eq(products.businessId, businessId))
          .orderBy(desc(products.updatedAt));
        return rows.map((row) => row.id);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载商品 ID 列表");
      }
    },

    /**
     * 指定商家的商品数。
     *
     * 非 uuid 直接返回 0 —— 与 `getById` 同样的短路理由：不能把
     * 「参数不像 id」变成 Postgres 的 `22P02` 报错。
     */
    async countForBusiness(businessId) {
      if (!isUuid(businessId)) {
        return 0;
      }
      try {
        const rows = await getDb()
          .select({ value: sqlCount() })
          .from(products)
          .where(eq(products.businessId, businessId));
        return Number(rows[0]?.value ?? 0);
      } catch (cause) {
        throw mapDatabaseError(cause, "统计商家商品数");
      }
    },

    async getById(id) {
      // URL 参数可能不是 uuid，先短路避免 Postgres 抛 22P02
      if (!isUuid(id)) {
        return null;
      }
      try {
        const rows = await getDb()
          .select()
          .from(products)
          .where(eq(products.id, id))
          .limit(1);
        const row = rows[0];
        return row ? mapProductRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载商品详情");
      }
    },

    /**
     * 归属判断。
     *
     * `getById` 刻意不带商家条件（它是「取某商品」的通用读），
     * 因此归属只能在这里单独回答。两个 id 都必须先过 uuid 格式校验：
     * 直接把它们丢给 Postgres 会抛 `22P02`，
     * 而这个方法在业务上只是「不是你的商品」，不该表现成数据库故障。
     *
     * 查询只取 id、只取一行：这是一个布尔判断，拉回整行商品
     * 只会让每次知识写入都多传一堆用不到的字段。
     */
    async belongsToBusiness(businessId, productId) {
      if (!isUuid(businessId) || !isUuid(productId)) {
        return false;
      }
      try {
        const rows = await getDb()
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.id, productId), eq(products.businessId, businessId)))
          .limit(1);
        return rows.length > 0;
      } catch (cause) {
        throw mapDatabaseError(cause, "校验商品归属");
      }
    },

    async getDna(productId) {
      return createDbProductDnaRepository().getByProductId(productId);
    },

    async create(input: NewProductInput): Promise<Product> {
      try {
        const businessId = await resolveBusinessId(input.businessId);
        const rows = await getDb()
          .insert(products)
          .values({
            businessId,
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
            tags: input.tags ?? [],
            analysisStatus: input.analysisStatus ?? "pending",
          })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "创建商品失败：数据库未返回记录",
          });
        }
        return mapProductRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "创建商品");
      }
    },

    async update(id: string, patch: UpdateProductInput): Promise<Product> {
      if (!isUuid(id)) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "商品不存在或已被删除",
          detail: `productId=${id}`,
        });
      }
      try {
        // 归属与写入在同一条语句里判定：先查后改会留下竞态窗口
        const businessId = await resolvePrimaryBusinessId();
        // 只写入显式传入的字段；updatedAt 始终刷新
        const values: Partial<typeof products.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (patch.name !== undefined) values.name = patch.name;
        if (patch.description !== undefined) values.description = patch.description;
        if (patch.category !== undefined) values.category = patch.category;
        if (patch.subCategory !== undefined) values.subCategory = patch.subCategory;
        if (patch.price !== undefined) values.price = patch.price;
        if (patch.unit !== undefined) values.unit = patch.unit;
        if (patch.stock !== undefined) values.stock = patch.stock;
        if (patch.origin !== undefined) values.origin = patch.origin;
        if (patch.specification !== undefined) values.specification = patch.specification;
        if (patch.storageMethod !== undefined) values.storageMethod = patch.storageMethod;
        if (patch.shelfLife !== undefined) values.shelfLife = patch.shelfLife;
        if (patch.imageUrl !== undefined) values.imageUrl = patch.imageUrl;
        if (patch.tags !== undefined) values.tags = patch.tags;
        if (patch.analysisStatus !== undefined) {
          values.analysisStatus = patch.analysisStatus;
        }

        const rows = await getDb()
          .update(products)
          .set(values)
          .where(and(eq(products.id, id), eq(products.businessId, businessId)))
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "商品不存在或已被删除",
            detail: `productId=${id}`,
          });
        }
        return mapProductRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新商品");
      }
    },

    async delete(id: string): Promise<void> {
      if (!isUuid(id)) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "商品不存在或已被删除",
          detail: `productId=${id}`,
        });
      }
      try {
        const businessId = await resolvePrimaryBusinessId();
        const rows = await getDb()
          .delete(products)
          .where(and(eq(products.id, id), eq(products.businessId, businessId)))
          .returning({ id: products.id });
        if (rows.length === 0) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "商品不存在或已被删除",
            detail: `productId=${id}`,
          });
        }
      } catch (cause) {
        throw mapDatabaseError(cause, "删除商品");
      }
    },
  };
}
