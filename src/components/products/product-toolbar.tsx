"use client";

import { Loader2, Search, SlidersHorizontal } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { PRODUCT_ANALYSIS_META } from "@/lib/status-meta";
import type { ProductAnalysisStatus, ProductCategory } from "@/types";

interface ProductToolbarProps {
  /** URL 上正在生效的关键词（用于判断是否处于筛选态） */
  keyword: string;
  category: ProductCategory | "all";
  status: ProductAnalysisStatus | "all";
  /**
   * 搜索框是非受控的：输入过程完全不触发 React 渲染，
   * 只把值交给父组件做防抖。外部变化（重置 / 前进后退）由父组件写回 DOM。
   */
  inputRef: React.RefObject<HTMLInputElement | null>;
  onKeywordInput: (value: string) => void;
  onKeywordSubmit: () => void;
  onCategoryChange: (value: ProductCategory | "all") => void;
  onStatusChange: (value: ProductAnalysisStatus | "all") => void;
  onReset: () => void;
  /** 分类可选项 */
  categories: readonly ProductCategory[];
  /** 当前筛选结果条数 */
  resultCount: number;
  /** 全部商品条数（用于「3 / 6 个结果」这类对比展示） */
  totalCount: number;
  /** 是否正在服务端筛选 */
  pending: boolean;
}

const STATUS_OPTIONS: (ProductAnalysisStatus | "all")[] = [
  "all",
  "analyzed",
  "analyzing",
  "pending",
  "failed",
];

/**
 * 商品筛选工具条。
 *
 * 筛选条件由 URL 查询参数驱动（服务端过滤），这里只负责收集输入：
 * - 关键词输入不触发渲染，父组件做 400ms 防抖后请求服务端；
 * - 下拉框变化立即触发查询。
 */
export function ProductToolbar({
  keyword,
  category,
  status,
  inputRef,
  onKeywordInput,
  onKeywordSubmit,
  onCategoryChange,
  onStatusChange,
  onReset,
  categories,
  resultCount,
  totalCount,
  pending,
}: ProductToolbarProps) {
  const hasFilter =
    keyword.length > 0 || category !== "all" || status !== "all";

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 shadow-card lg:flex-row lg:items-center">
      <div className="relative flex-1">
        <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          defaultValue={keyword}
          onChange={(event) => onKeywordInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onKeywordSubmit();
            }
          }}
          placeholder="搜索商品名称、产地或标签…（回车立即搜索）"
          className="border-transparent bg-muted/70 pl-8 focus-visible:bg-card"
          aria-label="搜索商品"
        />
      </div>

      <div className="flex items-center gap-2">
        <Select
          value={category}
          onChange={(event) =>
            onCategoryChange(event.target.value as ProductCategory | "all")
          }
          aria-label="按分类筛选"
          className="w-32"
        >
          <option value="all">全部分类</option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>

        <Select
          value={status}
          onChange={(event) =>
            onStatusChange(event.target.value as ProductAnalysisStatus | "all")
          }
          aria-label="按分析状态筛选"
          className="w-36"
        >
          {STATUS_OPTIONS.map((item) => (
            <option key={item} value={item}>
              {item === "all" ? "全部状态" : PRODUCT_ANALYSIS_META[item].label}
            </option>
          ))}
        </Select>

        <span className="hidden shrink-0 items-center gap-1 text-[12px] text-muted-foreground tabular-nums lg:inline-flex">
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <SlidersHorizontal className="size-3.5" />
          )}
          {hasFilter
            ? `${resultCount} / ${totalCount} 个结果`
            : `${totalCount} 个结果`}
        </span>

        <Button variant="ghost" size="sm" onClick={onReset} disabled={!hasFilter}>
          重置
        </Button>
      </div>
    </div>
  );
}
