/**
 * 商品服务层
 *
 * 定位：把「页面要什么数据」「表单写入要经过哪些步骤」讲清楚，
 * 不关心数据存在 Mock 内存还是 Supabase PostgreSQL。
 *
 * 铁律（对应技术文档第 37 章与 S1-2 任务书）：
 * - Service 不直接操作数据库，一律经 Repository；
 * - 所有写入必须先用 Zod 校验（validateProductForm）；
 * - 所有对外函数返回 Result<T>，不抛异常，由页面/action 决定展示方式。
 *
 * 图片例外说明：图片文件存储（本地目录或 Supabase Storage）不是数据库，
 * 因此本文件直接调用 `src/storage`，不额外包一层 Repository。
 */

import { summarizeProducts, type ProductSummary } from "@/analytics/metrics";
import { getDataSource, isStorageConfigured, type DataSourceId } from "@/lib/env";
import type { RawSearchParams } from "@/lib/search-params";
import { attempt, fail, ok, toAppError, unwrapOrThrow, type Result } from "@/lib/result";
import { getRepositories, getDataSourceStatus, type ProductListQuery } from "@/repositories";
import {
  parseProductImageFile,
  parseProductId,
  parseProductListQuery,
  validateProductForm,
  type ParsedProductImage,
  type ProductFormValues,
  type ProductImageFileInput,
} from "@/schemas/product";
import {
  deleteProductImage,
  uploadProductImage,
  type UploadedProductImage,
} from "@/storage";
import { saveLocalProductImage } from "@/storage/local-product-image";
import type { Product, ProductDNA } from "@/types";

import {
  getProductAnalysisState,
  type ProductAnalysisState,
} from "./product-agent.service";

/** 本地模式把图片写到磁盘；远程 / Mock 模式仍要求云存储。 */
function isProductImageUploadEnabled(): boolean {
  return getDataSource() === "local" || isStorageConfigured();
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

/** 分页信息（不含当页数据，当页数据在 products 字段） */
export interface ProductPagination {
  /** 筛选后的总条数 */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 商品中心列表页所需数据 */
export interface ProductsView {
  products: Product[];
  /** 统计卡片的数字来源：始终基于「全部商品」，不受筛选影响 */
  summary: ProductSummary;
  pagination: ProductPagination;
  /** 归一化后的查询条件，回填到筛选控件 */
  query: ReturnType<typeof parseProductListQuery>;
  /** 是否具备图片上传能力 */
  imageUploadEnabled: boolean;
  /** 当前数据来源，用于在界面上如实标注「演示数据 / 本地库 / 数据库」 */
  dataSource: DataSourceId;
}

/**
 * 商品列表视图。
 * 传参为 URL 的 searchParams，服务内部完成解析与容错。
 */
export async function getProductsView(
  rawQuery?: RawSearchParams,
): Promise<Result<ProductsView>> {
  return attempt(
    async () => {
      const query = parseProductListQuery(rawQuery);
      const repositories = getRepositories();

      const listQuery: ProductListQuery = {
        page: query.page,
        pageSize: query.pageSize,
      };
      if (query.keyword) {
        listQuery.keyword = query.keyword;
      }
      if (query.category !== "all") {
        listQuery.category = query.category;
      }
      if (query.status !== "all") {
        listQuery.analysisStatus = query.status;
      }

      // 分页结果用于网格；全量列表用于统计卡片（Demo 量级下代价可接受）
      const [page, all] = await Promise.all([
        repositories.products.listPage(listQuery),
        repositories.products.list(),
      ]);

      return {
        products: page.items,
        summary: summarizeProducts(all),
        pagination: {
          total: page.total,
          page: page.page,
          pageSize: page.pageSize,
          totalPages: page.totalPages,
        },
        query,
        imageUploadEnabled: isProductImageUploadEnabled(),
        dataSource: getDataSourceStatus().dataSource,
      } satisfies ProductsView;
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载商品列表失败"),
  );
}

/** Product DNA 详情页所需数据；data 为 null 表示商品不存在 */
export interface ProductDetailView {
  product: Product;
  dna: ProductDNA | null;
  /** 是否具备图片上传能力（决定编辑对话框里的图片入口是否可用） */
  imageUploadEnabled: boolean;
  /**
   * 分析上下文：最近一次 Agent 任务 + 当前模型通道状态。
   * 与 `dna` 分开是因为两者语义不同 ——
   * `dna` 是「当前生效的事实」，`latestTask` 是「历史运行记录」。
   */
  analysis: ProductAnalysisState;
}

export async function getProductDetailView(
  id: string,
): Promise<Result<ProductDetailView | null>> {
  return attempt(
    async () => {
      const repositories = getRepositories();
      const product = await repositories.products.getById(id);
      if (!product) {
        return null;
      }

      /**
       * 归属校验（S7 多租户）。
       *
       * `products.getById` 是「取某商品」的通用读，**刻意不带商家条件**
       * （见仓储接口注释），所以「它是不是当前商家的」必须在这里单独回答。
       * 少了这一步：任何账号只要拿到一个商品 id，就能打开别人商品的分析页
       * —— 列表已经隔离了，详情却漏着，等于隔离只做了一半。
       *
       * 「不是你的」与「不存在」都返回 null，界面统一走 not-found。
       * 两者可区分就等于提供了一个探测接口，能枚举出哪些商品真实存在；
       * 这与客服会话那边「不存在 / 不是你的合并成 NOT_FOUND」是同一套取舍。
       */
      const profile = unwrapOrThrow(
        await attempt(
          () => repositories.business.getProfile(),
          (cause) => toAppError(cause, "DB_ERROR", "加载商家资料失败"),
        ),
      );
      if (!profile) {
        return null;
      }
      const owned = await repositories.products.belongsToBusiness(
        profile.id,
        product.id,
      );
      if (!owned) {
        return null;
      }

      // DNA 与任务记录互相独立，并发取
      const [dna, analysis] = await Promise.all([
        repositories.products.getDna(product.id),
        getProductAnalysisState(product.id),
      ]);

      // 这里**不吞错**：任务记录读不出来说明数据库本身有问题，
      // 交给 upload 的 error.tsx 统一兜底，比显示一个「看似正常」的页面诚实。
      const analysisState = unwrapOrThrow(analysis);

      return {
        product,
        dna,
        imageUploadEnabled: isProductImageUploadEnabled(),
        analysis: analysisState,
      } satisfies ProductDetailView;
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载商品详情失败"),
  );
}

/**
 * 商品 id 列表。
 * 当前保留给后续用途（sitemap、批量分析任务分发）。
 * 注意：商品详情页**不做**构建期预渲染 —— 数据来自数据库时，
 * 构建机上不一定有可用连接，预渲染会直接让 build 失败。
 */
export async function listProductIds(): Promise<Result<string[]>> {
  return attempt(
    () => getRepositories().products.listIds(),
    (cause) => toAppError(cause, "DB_ERROR", "加载商品 ID 列表失败"),
  );
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

/** 新增 / 编辑商品的入参：表单值 + 已上传图片的公开 URL */
export interface ProductWritePayload {
  values: ProductFormValues;
  /** null 表示"清除图片"，undefined 表示"不改动" */
  imageUrl?: string | null;
}

/** 新增商品：先 Zod 校验，再落库 */
export async function createProduct(
  payload: ProductWritePayload,
): Promise<Result<Product>> {
  const values = validateProductForm(payload.values);
  if (!values.ok) {
    return values;
  }

  return attempt(
    () =>
      getRepositories().products.create({
        ...values.data,
        imageUrl: payload.imageUrl ?? null,
        // 新商品一律等待商品经理 Agent 分析（S2 阶段）
        analysisStatus: "pending",
      }),
    (cause) => toAppError(cause, "DB_ERROR", "创建商品失败"),
  );
}

/** 编辑商品：字段为全量覆盖（与编辑表单一致） */
export async function updateProduct(
  id: unknown,
  payload: ProductWritePayload,
): Promise<Result<Product>> {
  const productId = parseProductId(id);
  if (!productId.ok) {
    return productId;
  }
  const values = validateProductForm(payload.values);
  if (!values.ok) {
    return values;
  }

  return attempt(
    () =>
      getRepositories().products.update(productId.data, {
        ...values.data,
        // 未传 imageUrl 时不覆盖原有图片
        ...(payload.imageUrl === undefined ? {} : { imageUrl: payload.imageUrl }),
      }),
    (cause) => toAppError(cause, "DB_ERROR", "保存商品失败"),
  );
}

/** 图片清理结果：删商品时顺带删图，删图失败不应让删商品失败 */
export type ImageCleanupResult = "deleted" | "skipped" | "failed";

export interface DeleteProductResult {
  id: string;
  imageCleanup: ImageCleanupResult;
}

/**
 * 删除商品。
 * 顺序很重要：先删数据库记录（业务主结果），再尽力清理对象存储里的图片。
 * 图片删除失败只记录状态，不回滚 —— 否则会出现「用户以为没删掉」的困扰。
 */
export async function deleteProduct(
  id: unknown,
): Promise<Result<DeleteProductResult>> {
  const productId = parseProductId(id);
  if (!productId.ok) {
    return productId;
  }

  const repositories = getRepositories();

  const existing = await attempt(
    () => repositories.products.getById(productId.data),
    (cause) => toAppError(cause, "DB_ERROR", "加载商品失败"),
  );
  if (!existing.ok) {
    return existing;
  }

  const removed = await attempt(
    () => repositories.products.delete(productId.data),
    (cause) => toAppError(cause, "DB_ERROR", "删除商品失败"),
  );
  if (!removed.ok) {
    return removed;
  }

  let imageCleanup: ImageCleanupResult = "skipped";
  const imageUrl = existing.data?.imageUrl;
  if (imageUrl) {
    const cleaned = await deleteProductImage(imageUrl);
    imageCleanup = cleaned.ok ? "deleted" : "failed";
  }

  return ok({ id: productId.data, imageCleanup });
}

/**
 * 上传商品图片（任务书中的 `uploadImage()`）。
 * 只负责「校验 + 保存图片」，不写数据库 —— 图片 URL 由调用方
 * 一并提交给 createProduct / updateProduct，避免出现半个商品。
 */
export async function uploadImage(
  file: ProductImageFileInput,
  options: { name: string },
): Promise<Result<UploadedProductImage>> {
  const parsed: Result<ParsedProductImage> = await parseProductImageFile(file);
  if (!parsed.ok) {
    return parsed;
  }

  if (getDataSource() === "local") {
    return saveLocalProductImage({
      data: parsed.data.data,
      contentType: parsed.data.contentType,
      fileName: parsed.data.fileName,
      name: options.name,
    });
  }

  if (!isStorageConfigured()) {
    return fail(
      "STORAGE_ERROR",
      "尚未配置图片存储",
      "缺少环境变量：NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（请写入 .env.local）",
    );
  }

  return uploadProductImage({
    data: parsed.data.data,
    contentType: parsed.data.contentType,
    fileName: parsed.data.fileName,
    name: options.name,
  });
}

/** 需要 File 的结构契约，从 schema 模块透出，避免页面重复声明 */
export type { ProductImageFileInput };
