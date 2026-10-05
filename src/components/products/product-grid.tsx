"use client";

/**
 * 商品列表容器
 *
 * 与 S1-1 的区别：筛选与分页从「前端内存过滤」改为「URL 参数驱动的服务端查询」。
 * 这样关键词 / 分类 / 状态在数据量变大、数据源切到数据库之后依然成立，
 * 而组件层只负责收集输入与构建 URL。
 *
 * 数据流：
 *   输入变化 → router.push(/products?keyword=…&page=1) → 服务端重新查询
 *   → page.tsx 重新渲染 → 本组件拿到新的 products / pagination
 *
 * 为什么搜索框不做受控组件：
 *   每个字符都 setState 会带来额外渲染，而且"本地状态 ↔ URL 状态"的同步
 *   很容易写出 effect 里的级联更新。这里改成非受控输入 + ref 读值，
 *   外部变化（重置、浏览器前进后退）时直接写回 DOM。
 */

import { PackageSearch } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { EmptyState } from "@/components/common/empty-state";
import { FadeIn } from "@/components/motion/fade-in";
import { ProductCard } from "@/components/products/product-card";
import { ProductCreateDialog } from "@/components/products/product-form-dialog";
import { ProductGridSkeleton } from "@/components/products/product-grid-skeleton";
import { ProductPagination } from "@/components/products/product-pagination";
import { ProductToolbar } from "@/components/products/product-toolbar";
import { Button } from "@/components/ui/button";
import { PRODUCT_CATEGORIES } from "@/lib/product-options";
import type { ProductListQueryInput } from "@/schemas/product";
import type { ProductPagination as ProductPaginationMeta } from "@/services/products";
import type { Product, ProductAnalysisStatus, ProductCategory } from "@/types";

/** 关键词防抖时长（毫秒） */
const KEYWORD_DEBOUNCE_MS = 400;

/** 用当前查询 + 变更字段拼出商品列表 URL（纯函数，便于阅读与复用） */
export function buildProductsHref(
  current: ProductListQueryInput,
  patch: Partial<ProductListQueryInput>,
): string {
  const merged = { ...current, ...patch };
  const params = new URLSearchParams();
  if (merged.keyword) {
    params.set("keyword", merged.keyword);
  }
  if (merged.category !== "all") {
    params.set("category", merged.category);
  }
  if (merged.status !== "all") {
    params.set("status", merged.status);
  }
  if (merged.page > 1) {
    params.set("page", `${merged.page}`);
  }
  const queryString = params.toString();
  return queryString ? `/products?${queryString}` : "/products";
}

interface ProductGridProps {
  products: Product[];
  pagination: ProductPaginationMeta;
  query: ProductListQueryInput;
  /** 全部商品数量（不受筛选影响），用于工具条上的对比展示 */
  totalCount: number;
  imageUploadEnabled: boolean;
}

/** 商品网格：工具条 + 分页 + 加载 / 空结果状态 */
export function ProductGrid({
  products,
  pagination,
  query,
  totalCount,
  imageUploadEnabled,
}: ProductGridProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 始终指向最新查询条件，供防抖回调使用（回调触发时已跨渲染） */
  const queryRef = React.useRef(query);

  React.useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // 外部条件变化（点重置、浏览器前进后退）时把值写回非受控输入框；
  // 输入框处于聚焦状态时不动，避免覆盖用户正在输入的内容。
  React.useEffect(() => {
    const input = searchRef.current;
    if (!input || document.activeElement === input) {
      return;
    }
    if (input.value.trim() !== query.keyword) {
      input.value = query.keyword;
    }
  }, [query.keyword]);

  // 卸载时清掉未触发的防抖定时器
  React.useEffect(
    () => () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    },
    [],
  );

  const navigate = React.useCallback(
    (patch: Partial<ProductListQueryInput>) => {
      const current = queryRef.current;
      startTransition(() => {
        router.push(buildProductsHref(current, patch));
      });
    },
    [router],
  );

  const submitKeyword = React.useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed === queryRef.current.keyword) {
        return;
      }
      navigate({ keyword: trimmed, page: 1 });
    },
    [navigate],
  );

  const handleKeywordInput = (value: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      submitKeyword(value);
    }, KEYWORD_DEBOUNCE_MS);
  };

  const handleReset = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    if (searchRef.current) {
      searchRef.current.value = "";
    }
    navigate({ keyword: "", category: "all", status: "all", page: 1 });
  };

  const hasFilter =
    query.keyword.length > 0 || query.category !== "all" || query.status !== "all";

  return (
    <div className="flex flex-col gap-3">
      <ProductToolbar
        keyword={query.keyword}
        category={query.category}
        status={query.status}
        inputRef={searchRef}
        onKeywordInput={handleKeywordInput}
        onKeywordSubmit={() => submitKeyword(searchRef.current?.value ?? "")}
        onCategoryChange={(category: ProductCategory | "all") =>
          navigate({ category, page: 1 })
        }
        onStatusChange={(status: ProductAnalysisStatus | "all") =>
          navigate({ status, page: 1 })
        }
        onReset={handleReset}
        categories={PRODUCT_CATEGORIES}
        resultCount={pagination.total}
        totalCount={totalCount}
        pending={pending}
      />

      {pending ? (
        <ProductGridSkeleton count={Math.min(pagination.pageSize, 6)} />
      ) : products.length === 0 ? (
        <ProductGridEmpty
          hasFilter={hasFilter}
          page={pagination.page}
          total={pagination.total}
          imageUploadEnabled={imageUploadEnabled}
          onReset={handleReset}
          onFirstPage={() => navigate({ page: 1 })}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {products.map((product, index) => (
            <FadeIn key={product.id} delay={index * 0.03} className="h-full">
              <ProductCard product={product} />
            </FadeIn>
          ))}
        </div>
      )}

      {pagination.totalPages > 1 ? (
        <ProductPagination
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          pageSize={pagination.pageSize}
          pending={pending}
          onPageChange={(page) => navigate({ page })}
        />
      ) : null}
    </div>
  );
}

/** 空结果有三种成因，分别给出可执行的下一步 */
function ProductGridEmpty({
  hasFilter,
  page,
  total,
  imageUploadEnabled,
  onReset,
  onFirstPage,
}: {
  hasFilter: boolean;
  page: number;
  total: number;
  imageUploadEnabled: boolean;
  onReset: () => void;
  onFirstPage: () => void;
}) {
  if (total > 0 && page > 1) {
    return (
      <EmptyState
        title="这一页没有商品"
        description="筛选条件没变，但页码超出了范围（通常是筛选后结果变少了）。"
        icon={<PackageSearch className="size-4" />}
        action={
          <Button
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={onFirstPage}
          >
            回到第一页
          </Button>
        }
      />
    );
  }

  if (hasFilter) {
    return (
      <EmptyState
        title="没有符合条件的商品"
        description="试着调整关键词、分类或分析状态，或者直接新增一个连江海产品。"
        icon={<PackageSearch className="size-4" />}
        action={
          <Button variant="outline" size="sm" className="mt-1" onClick={onReset}>
            清除筛选
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      title="还没有商品"
      description="添加第一个商品。保存后可继续完善商品分析。"
      icon={<PackageSearch className="size-4" />}
      action={
        <ProductCreateDialog
          imageUploadEnabled={imageUploadEnabled}
          className="mt-1"
        />
      }
    />
  );
}
