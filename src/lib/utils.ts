import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 Tailwind class，处理条件类名与冲突覆盖 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** 数字千分位格式化：2340 -> 2,340 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

/** 金额格式化：12680 -> ¥12,680 */
export function formatCurrency(value: number, withSymbol = true): string {
  const text = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
  return withSymbol ? `¥${text}` : text;
}

/** 百分比格式化：0.18 -> +18% */
export function formatDelta(value: number, withSign = true): string {
  const sign = withSign && value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(0)}%`;
}

/** 紧凑数字：12000 -> 1.2w */
export function formatCompact(value: number): string {
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)}w`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${value}`;
}

/** 生成稳定 id（仅用于本地 Mock 数据） */
export function createId(prefix: string, seed: number): string {
  return `${prefix}_${seed.toString(36).padStart(4, "0")}`;
}
