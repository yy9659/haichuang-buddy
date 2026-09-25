"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatNumber } from "@/lib/utils";
import type { TrendPoint } from "@/types";

const SERIES = [
  { key: "views", name: "浏览量", color: "var(--chart-2)" },
  { key: "inquiries", name: "咨询量", color: "var(--chart-5)" },
  { key: "conversions", name: "成交量", color: "var(--chart-1)" },
] as const;

interface TrafficTrendChartProps {
  data: TrendPoint[];
  height?: number;
}

/** 流量与转化趋势图 */
export function TrafficTrendChart({
  data,
  height = 220,
}: TrafficTrendChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          {SERIES.map((series) => (
            <linearGradient
              key={series.key}
              id={`grad-${series.key}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={series.color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={series.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="var(--border)"
        />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          dy={6}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickFormatter={(value: number) => formatNumber(value)}
        />
        <Tooltip
          cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
          contentStyle={{
            borderRadius: 10,
            border: "1px solid var(--border)",
            boxShadow: "0 12px 32px -14px rgba(15, 23, 42, 0.3)",
            fontSize: 12,
            padding: "8px 10px",
          }}
          labelStyle={{ color: "var(--muted-foreground)", fontSize: 11 }}
          formatter={(value) =>
            typeof value === "number" ? formatNumber(value) : `${value}`
          }
        />
        <Legend
          verticalAlign="top"
          align="right"
          height={26}
          iconType="circle"
          iconSize={7}
          wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }}
        />
        {SERIES.map((series) => (
          <Area
            key={series.key}
            type="monotone"
            dataKey={series.key}
            name={series.name}
            stroke={series.color}
            strokeWidth={2}
            fill={`url(#grad-${series.key})`}
            activeDot={{ r: 3.5 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
