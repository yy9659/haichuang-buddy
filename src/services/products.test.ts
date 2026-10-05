/**
 * 商品服务层单测（Mock 数据源，不需要数据库）
 *
 * 覆盖「服务层必须做到的事」：
 * - 读取：查询参数经解析后真正生效，分页信封口径正确
 * - 写入：先 Zod 校验再动仓储，非法输入必须被拦住
 * - 错误：领域错误码被正确透出（NOT_FOUND / VALIDATION_FAILED / STORAGE_ERROR）
 *
 * 注意：Mock 仓储是进程内可变状态，因此每个用例都自行清理创建的数据。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvCache } from "@/lib/env";
import type { ProductFormValues } from "@/schemas/product";
import { deleteProductImage } from "@/storage";
import { readLocalProductImageAsDataUrl } from "@/storage/local-product-image";

import {
  createProduct,
  deleteProduct,
  getProductDetailView,
  getProductsView,
  updateProduct,
  uploadImage,
} from "./products";

const originalEnv = {
  DATA_SOURCE: process.env.DATA_SOURCE,
  AI_PROVIDER: process.env.AI_PROVIDER,
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

/**
 * 固定为「Mock 数据源 + 未配置对象存储 + Mock 模型」。
 * 显式清掉 Storage 凭证与真实模型配置，否则本机 `.env.local` 一旦填了
 * Supabase / DashScope，这里的断言（imageUploadEnabled === false、
 * provider.providerId === "mock" 等）就会随环境变化而漂移。
 */
function useMockSourceWithoutStorage(): void {
  process.env.DATA_SOURCE = "mock";
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.AI_PROVIDER;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_BASE_URL;
  resetServerEnvCache();
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetServerEnvCache();
}

beforeAll(() => {
  useMockSourceWithoutStorage();
});

beforeEach(() => {
  useMockSourceWithoutStorage();
});

afterAll(() => {
  restoreEnv();
});

function validValues(overrides: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    name: "连江测试用鲜鲍鱼",
    description: "服务层单测数据",
    category: "海产品",
    subCategory: "鲍鱼",
    price: 168,
    unit: "500g",
    stock: 20,
    origin: "福建连江",
    specification: "8-10 头 / 500g",
    storageMethod: "0-4℃ 冷藏",
    shelfLife: "2 天",
    tags: ["测试"],
    ...overrides,
  };
}

describe("getProductsView", () => {
  it("默认返回第一页与统计信息，数据源标记为 mock", async () => {
    const result = await getProductsView();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const view = result.data;
    expect(view.dataSource).toBe("mock");
    expect(view.products).toHaveLength(6);
    expect(view.pagination.total).toBe(6);
    expect(view.pagination.page).toBe(1);
    expect(view.pagination.totalPages).toBe(1);
    expect(view.summary.total).toBe(6);
    // Mock 数据源没有配置对象存储，图片上传入口应当是关闭的
    expect(view.imageUploadEnabled).toBe(false);
  });

  it("关键词筛选会影响当页数据与 total，但不影响统计卡片", async () => {
    const result = await getProductsView({ keyword: "鲍鱼" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const view = result.data;
    expect(view.products.length).toBeGreaterThan(0);
    // 每页 9 条 > 结果数，因此当页条数即筛选后的总数
    expect(view.pagination.total).toBe(view.products.length);
    // 统计卡片始终基于全量商品
    expect(view.summary.total).toBe(6);
  });

  it("分类筛选生效", async () => {
    const result = await getProductsView({ category: "干货" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(
      result.data.products.every((item) => item.category === "干货"),
    ).toBe(true);
  });

  it("页码越界时返回空页但保留总数（前端据此提示回到第一页）", async () => {
    const result = await getProductsView({ page: "5" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.products).toHaveLength(0);
    expect(result.data.pagination.page).toBe(5);
    expect(result.data.pagination.total).toBe(6);
  });

  it("非法的查询参数不会抛错，退回默认视图", async () => {
    const result = await getProductsView({
      category: "不存在的分类",
      status: "unknown",
      page: "abc",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.query.category).toBe("all");
    expect(result.data.products).toHaveLength(6);
  });
});

describe("createProduct", () => {
  it("校验通过后写入仓储，状态为 pending", async () => {
    const created = await createProduct({ values: validValues() });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(created.data.name).toBe("连江测试用鲜鲍鱼");
    expect(created.data.price).toBe(168);
    expect(created.data.analysisStatus).toBe("pending");
    expect(created.data.imageUrl).toBeNull();
    expect(created.data.metrics).toEqual({
      views: 0,
      inquiries: 0,
      conversions: 0,
    });

    const list = await getProductsView();
    expect(list.ok && list.data.pagination.total).toBe(7);

    await deleteProduct(created.data.id);
  });

  it("非法字段被拦住，且不会写进仓储", async () => {
    const before = await getProductsView();
    const beforeTotal = before.ok ? before.data.pagination.total : -1;

    const failed = await createProduct({ values: validValues({ name: "鲍" }) });
    expect(failed.ok).toBe(false);
    if (failed.ok) {
      return;
    }
    expect(failed.error.code).toBe("VALIDATION_FAILED");
    expect(failed.error.message).toContain("商品名称");

    const after = await getProductsView();
    expect(after.ok && after.data.pagination.total).toBe(beforeTotal);
  });
});

describe("updateProduct", () => {
  it("能改字段并保留未传字段", async () => {
    const created = await createProduct({ values: validValues() });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const updated = await updateProduct(created.data.id, {
      values: validValues({ price: 199, stock: 5, tags: ["改价"] }),
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      return;
    }
    expect(updated.data.id).toBe(created.data.id);
    expect(updated.data.price).toBe(199);
    expect(updated.data.stock).toBe(5);
    expect(updated.data.tags).toEqual(["改价"]);

    await deleteProduct(created.data.id);
  });

  it("id 不合法时直接失败，不触达仓储", async () => {
    const result = await updateProduct("../../etc/passwd", {
      values: validValues(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("商品不存在时透出 NOT_FOUND", async () => {
    const result = await updateProduct("prod_missing", {
      values: validValues(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.retryable).toBe(false);
    }
  });
});

describe("deleteProduct", () => {
  it("删除后查不到，重复删除返回 NOT_FOUND", async () => {
    const created = await createProduct({ values: validValues() });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const removed = await deleteProduct(created.data.id);
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      // 没有图片时跳过对象存储清理
      expect(removed.data.imageCleanup).toBe("skipped");
    }

    const detailList = await getProductsView();
    expect(
      detailList.ok &&
        detailList.data.products.some((item) => item.id === created.data.id),
    ).toBe(false);

    const again = await deleteProduct(created.data.id);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("getProductDetailView", () => {
  it("返回商品、DNA 与分析上下文（含模型通道状态）", async () => {
    const result = await getProductDetailView("prod_001");
    expect(result.ok).toBe(true);
    if (!result.ok || !result.data) {
      return;
    }

    const view = result.data;
    expect(view.product.id).toBe("prod_001");
    // Mock 数据里 prod_001 已有 DNA
    expect(view.dna).not.toBeNull();
    expect(view.dna?.productId).toBe("prod_001");
    // 本组用例显式清掉了 Storage 凭证
    expect(view.imageUploadEnabled).toBe(false);
    // 分析上下文：没有跑过分析 → 没有任务记录；模型通道是 Mock
    expect(view.analysis.latestTask).toBeNull();
    expect(view.analysis.provider.providerId).toBe("mock");
    expect(view.analysis.provider.isMock).toBe(true);
    expect(view.analysis.provider.usable).toBe(true);
  });

  it("没有 DNA 的商品返回 dna=null（页面据此显示「等待 AI 商品分析」）", async () => {
    const created = await createProduct({ values: validValues() });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const result = await getProductDetailView(created.data.id);
    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.dna).toBeNull();
      expect(result.data.product.analysisStatus).toBe("pending");
    }

    await deleteProduct(created.data.id);
  });

  it("商品不存在时返回 data=null，由页面走 notFound", async () => {
    const result = await getProductDetailView("prod_missing");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });
});

describe("uploadImage", () => {
  const file = {
    size: 2048,
    type: "image/png",
    name: "baoyu.png",
    arrayBuffer: async () => new ArrayBuffer(2048),
  };

  it("文件本身不合法时先失败，不依赖存储配置", async () => {
    const result = await uploadImage(
      { ...file, type: "application/pdf" },
      { name: "连江鲜活鲍鱼" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("未配置对象存储时给出可操作的错误，而不是静默跳过", async () => {
    const result = await uploadImage(file, { name: "连江鲜活鲍鱼" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORAGE_ERROR");
      expect(result.error.message).toContain("尚未配置图片存储");
      expect(result.error.detail).toContain("NEXT_PUBLIC_SUPABASE_URL");
    }
  });

  it("local 数据源把图片写入文件，数据库只需保存短路径", async () => {
    process.env.DATA_SOURCE = "local";
    resetServerEnvCache();

    const result = await uploadImage(file, { name: "连江鲜活鲍鱼" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      try {
        expect(result.data.url).toMatch(/^\/api\/product-images\/[a-f0-9]{32}\.png$/);
        expect(result.data.url.length).toBeLessThan(80);
        expect(result.data.size).toBe(2048);
        const image = await readLocalProductImageAsDataUrl(result.data.url);
        expect(image.ok).toBe(true);
        if (image.ok) {
          expect(image.data).toMatch(/^data:image\/png;base64,/);
        }
      } finally {
        await deleteProductImage(result.data.url);
      }
    }
  });
});
