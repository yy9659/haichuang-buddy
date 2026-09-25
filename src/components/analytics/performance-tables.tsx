import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { CONTENT_PLATFORM_LABEL } from "@/lib/status-meta";
import { cn, formatCompact, formatCurrency } from "@/lib/utils";
import type { ContentPerformance, ProductPerformance } from "@/types";

function TableShell({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-muted/60 text-muted-foreground">
            {headers.map((header) => (
              <th
                key={header}
                className="px-3 py-2 text-left font-medium whitespace-nowrap"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** 内容表现表格 */
export function ContentPerformanceTable({
  rows,
}: {
  rows: ContentPerformance[];
}) {
  return (
    <TableShell headers={["内容标题", "平台", "播放量", "互动率", "转化"]}>
      {rows.map((row) => (
        <tr key={row.id} className="border-t border-border/70">
          <td className="max-w-64 truncate px-3 py-2 font-medium">{row.title}</td>
          <td className="px-3 py-2">
            <Badge variant="secondary">{CONTENT_PLATFORM_LABEL[row.platform]}</Badge>
          </td>
          <td className="px-3 py-2 tabular-nums">{formatCompact(row.views)}</td>
          <td
            className={cn(
              "px-3 py-2 font-medium tabular-nums",
              row.engagementRate >= 0.09 ? "text-success" : "text-muted-foreground",
            )}
          >
            {(row.engagementRate * 100).toFixed(2)}%
          </td>
          <td className="px-3 py-2 tabular-nums">{row.conversions} 单</td>
        </tr>
      ))}
    </TableShell>
  );
}

/** 商品表现表格 */
export function ProductPerformanceTable({
  rows,
}: {
  rows: ProductPerformance[];
}) {
  return (
    <TableShell headers={["商品", "浏览量", "咨询量", "成交量", "销售额"]}>
      {rows.map((row) => (
        <tr key={row.id} className="border-t border-border/70">
          <td className="max-w-40 truncate px-3 py-2 font-medium">{row.name}</td>
          <td className="px-3 py-2 tabular-nums">{formatCompact(row.views)}</td>
          <td className="px-3 py-2 tabular-nums">{formatCompact(row.inquiries)}</td>
          <td className="px-3 py-2 tabular-nums">{row.conversions}</td>
          <td className="px-3 py-2 font-medium tabular-nums">
            {formatCurrency(row.revenue)}
          </td>
        </tr>
      ))}
    </TableShell>
  );
}
