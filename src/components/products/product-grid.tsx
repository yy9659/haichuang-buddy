"use client";

import { PackageSearch } from "lucide-react";
import * as React from "react";

import { EmptyState } from "@/components/common/empty-state";
import { FadeIn } from "@/components/motion/fade-in";
import { ProductCard } from "@/components/products/product-card";
import {
  ProductToolbar,
  type ProductFilters,
} from "@/components/products/product-toolbar";
import type { Product, ProductCategory } from "@/types";

const INITIAL_FILTERS: ProductFilters = {
  keyword: "",
  category: "all",
  status: "all",
};

/** 商品列表（含前端筛选，Mock 数据） */
export function ProductGrid({ products }: { products: Product[] }) {
  const [filters, setFilters] = React.useState<ProductFilters>(INITIAL_FILTERS);

  const categories = React.useMemo(
    () => Array.from(new Set(products.map((item) => item.category))),
    [products],
  );

  const filtered = React.useMemo(() => {
    const keyword = filters.keyword.trim().toLowerCase();
    return products.filter((product) => {
      const matchKeyword =
        keyword.length === 0 ||
        product.name.toLowerCase().includes(keyword) ||
        product.origin.toLowerCase().includes(keyword) ||
        product.tags.some((tag) => tag.toLowerCase().includes(keyword));
      const matchCategory =
        filters.category === "all" || product.category === filters.category;
      const matchStatus =
        filters.status === "all" || product.analysisStatus === filters.status;
      return matchKeyword && matchCategory && matchStatus;
    });
  }, [filters, products]);

  return (
    <div className="flex flex-col gap-3">
      <ProductToolbar
        filters={filters}
        onChange={setFilters}
        categories={categories as ProductCategory[]}
        resultCount={filtered.length}
      />

      {filtered.length === 0 ? (
        <EmptyState
          title="没有符合条件的商品"
          description="试着调整关键词或筛选条件，或者新增一个连江海产品。"
          icon={<PackageSearch className="size-4" />}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((product, index) => (
            <FadeIn key={product.id} delay={index * 0.03} className="h-full">
              <ProductCard product={product} />
            </FadeIn>
          ))}
        </div>
      )}
    </div>
  );
}
