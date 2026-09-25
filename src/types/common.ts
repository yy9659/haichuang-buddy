import type { ComponentType, SVGProps } from "react";

/** 语义色调，统一驱动 Badge / 图标底色 / 图表配色 */
export type StatusTone =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info";

/** 通用图标组件类型（兼容 lucide-react 图标） */
export type IconComponent = ComponentType<
  SVGProps<SVGSVGElement> & {
    size?: number | string;
    strokeWidth?: number | string;
  }
>;

/** 趋势方向 */
export type TrendDirection = "up" | "down" | "flat";
