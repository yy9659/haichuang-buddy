import type { AgentAccent, StatusTone } from "@/types";

interface ToneClasses {
  /** 浅色底 + 同色文字，用于徽标、标签 */
  soft: string;
  /** 纯文字色 */
  text: string;
  /** 纯色底（小圆点 / 进度条） */
  solid: string;
  /** 图标容器：浅底 + 文字色 */
  icon: string;
}

/** 语义色调 → Tailwind class（统一所有状态色表达） */
export const TONE_CLASSES: Record<StatusTone, ToneClasses> = {
  neutral: {
    soft: "border-border bg-muted text-muted-foreground",
    text: "text-muted-foreground",
    solid: "bg-muted-foreground/60",
    icon: "bg-muted text-muted-foreground",
  },
  primary: {
    soft: "border-primary/15 bg-primary-soft text-primary",
    text: "text-primary",
    solid: "bg-primary",
    icon: "bg-primary-soft text-primary",
  },
  success: {
    soft: "border-success/20 bg-success/10 text-success",
    text: "text-success",
    solid: "bg-success",
    icon: "bg-success/10 text-success",
  },
  warning: {
    soft: "border-warning/25 bg-warning/12 text-warning",
    text: "text-warning",
    solid: "bg-warning",
    icon: "bg-warning/12 text-warning",
  },
  danger: {
    soft: "border-destructive/20 bg-destructive/10 text-destructive",
    text: "text-destructive",
    solid: "bg-destructive",
    icon: "bg-destructive/10 text-destructive",
  },
  info: {
    soft: "border-info/20 bg-info/10 text-info",
    text: "text-info",
    solid: "bg-info",
    icon: "bg-info/10 text-info",
  },
};

interface AccentClasses {
  /** 渐变头像底 */
  avatar: string;
  /** 图标色 */
  icon: string;
  /** 卡片 hover 边框 */
  hoverBorder: string;
}

/** AI 员工主题色（仅视觉区分，不承载业务语义） */
export const ACCENT_CLASSES: Record<AgentAccent, AccentClasses> = {
  ocean: {
    avatar: "bg-gradient-to-br from-sky-100 to-blue-200 text-blue-700",
    icon: "text-blue-600",
    hoverBorder: "hover:border-blue-300/70",
  },
  teal: {
    avatar: "bg-gradient-to-br from-teal-100 to-cyan-200 text-teal-700",
    icon: "text-teal-600",
    hoverBorder: "hover:border-teal-300/70",
  },
  violet: {
    avatar: "bg-gradient-to-br from-violet-100 to-indigo-200 text-violet-700",
    icon: "text-violet-600",
    hoverBorder: "hover:border-violet-300/70",
  },
  amber: {
    avatar: "bg-gradient-to-br from-amber-100 to-orange-200 text-amber-700",
    icon: "text-amber-600",
    hoverBorder: "hover:border-amber-300/70",
  },
  rose: {
    avatar: "bg-gradient-to-br from-rose-100 to-pink-200 text-rose-700",
    icon: "text-rose-600",
    hoverBorder: "hover:border-rose-300/70",
  },
  emerald: {
    avatar: "bg-gradient-to-br from-emerald-100 to-green-200 text-emerald-700",
    icon: "text-emerald-600",
    hoverBorder: "hover:border-emerald-300/70",
  },
};
