"use client";

import { Search, SlidersHorizontal } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { PRODUCT_ANALYSIS_META } from "@/lib/status-meta";
import { cn } from "@/lib/utils";
import type { ProductAnalysisStatus, ProductCategory } from "@/types";

export interface ProductFilters {
  keyword: string;
  category: ProductCategory | "all";
  status: ProductAnalysisStatus | "all";
}

interface ProductToolbarProps {
  filters: ProductFilters;
  onChange: (filters: ProductFilters) => void;
  /** 分类可选项，由调用方根据数据生成 */
  categories: ProductCategory[];
  resultCount: number;
}

const STATUS_OPTIONS: (ProductAnalysisStatus | "all")[] = [
  "all",
  "analyzed",
  "analyzing",
  "pending",
  "failed",
];

/** 商品筛选工具条（纯前端筛选，不接接口） */
export function ProductToolbar({
  filters,
  onChange,
  categories,
  resultCount,
}: ProductToolbarProps) {
  const update = (patch: Partial<ProductFilters>) =>
    onChange({ ...filters, ...patch });

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 shadow-card lg:flex-row lg:items-center">
      <div className="relative flex-1">
        <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.keyword}
          onChange={(event) => update({ keyword: event.target.value })}
          placeholder="搜索商品名称、产地或标签…"
          className="border-transparent bg-muted/70 pl-8 focus-visible:bg-card"
          aria-label="搜索商品"
        />
      </div>

      <div className="flex items-center gap-2">
        <Select
          value={filters.category}
          onChange={(event) =>
            update({ category: event.target.value as ProductCategory | "all" })
          }
          aria-label="按分类筛选"
          className="w-32"
        >
          <option value="all">全部分类</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </Select>

        <Select
          value={filters.status}
          onChange={(event) =>
            update({
              status: event.target.value as ProductAnalysisStatus | "all",
            })
          }
          aria-label="按分析状态筛选"
          className="w-36"
        >
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status === "all"
                ? "全部状态"
                : PRODUCT_ANALYSIS_META[status].label}
            </option>
          ))}
        </Select>

        <span
          className={cn(
            "hidden shrink-0 items-center gap-1 text-[12px] text-muted-foreground lg:inline-flex",
          )}
        >
          <SlidersHorizontal className="size-3.5" />
          {resultCount} 个结果
        </span>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ keyword: "", category: "all", status: "all" })}
        >
          重置
        </Button>
      </div>
    </div>
  );
}
