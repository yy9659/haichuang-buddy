"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

interface ProductPaginationProps {
  page: number;
  totalPages: number;
  /** 筛选后的总条数 */
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  pending: boolean;
}

/** 商品列表分页条（服务端分页，页码写入 URL 查询参数） */
export function ProductPagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  pending,
}: ProductPaginationProps) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2.5 shadow-card sm:flex-row">
      <span className="text-[12px] text-muted-foreground tabular-nums">
        共 {total} 个商品
        {total > 0 ? ` · 当前显示第 ${first}-${last} 个` : ""}
      </span>

      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground tabular-nums">
          第 {page} / {totalPages} 页
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft />
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
