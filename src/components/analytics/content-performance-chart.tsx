"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatNumber } from "@/lib/utils";
import type { ContentPerformance } from "@/types";

interface ContentPerformanceChartProps {
  data: ContentPerformance[];
  height?: number;
}

const BAR_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-5)",
];

/** 内容表现对比（按浏览量） */
export function ContentPerformanceChart({
  data,
  height = 200,
}: ContentPerformanceChartProps) {
  const chartData = data.map((item) => ({
    name: item.title.length > 12 ? `${item.title.slice(0, 12)}…` : item.title,
    views: item.views,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
        barCategoryGap={12}
      >
        <CartesianGrid
          horizontal={false}
          stroke="var(--border)"
          strokeDasharray="3 3"
        />
        <XAxis
          type="number"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickFormatter={(value: number) => formatNumber(value)}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={112}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
        />
        <Tooltip
          cursor={{ fill: "var(--muted)" }}
          contentStyle={{
            borderRadius: 10,
            border: "1px solid var(--border)",
            boxShadow: "0 12px 32px -14px rgba(15, 23, 42, 0.3)",
            fontSize: 12,
          }}
          formatter={(value) =>
            typeof value === "number" ? formatNumber(value) : `${value}`
          }
        />
        <Bar dataKey="views" name="浏览量" radius={[0, 6, 6, 0]} barSize={14}>
          {chartData.map((item, index) => (
            <Cell
              key={item.name}
              fill={BAR_COLORS[index % BAR_COLORS.length]}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
