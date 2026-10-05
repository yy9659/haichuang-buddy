import {
  ChartColumn,
  FileText,
  Headphones,
  LayoutDashboard,
  Package,
  Palette,
  Video,
} from "lucide-react";
import type { IconComponent } from "@/types";

export interface NavItem {
  title: string;
  href: string;
  description: string;
  icon: IconComponent;
}

/** 主导航：对应技术文档第 8 章信息架构 */
export const NAV_ITEMS: NavItem[] = [
  {
    title: "工作台",
    href: "/dashboard",
    description: "从商品到推广",
    icon: LayoutDashboard,
  },
  {
    title: "商品中心",
    href: "/products",
    description: "商品管理与商品理解",
    icon: Package,
  },
  {
    title: "品牌中心",
    href: "/brand",
    description: "品牌定位与老板数字分身",
    icon: Palette,
  },
  {
    title: "推广素材",
    href: "/content",
    description: "生成、修改与确认",
    icon: FileText,
  },
  {
    title: "直播彩排",
    href: "/live",
    description: "模拟提问与话术练习",
    icon: Video,
  },
  {
    title: "答疑助手",
    href: "/customer-service",
    description: "核对依据，准备回复",
    icon: Headphones,
  },
  {
    title: "经营复盘",
    href: "/analytics",
    description: "产出、问题与下一步",
    icon: ChartColumn,
  },
];

export const SITE = {
  name: "海创Buddy",
  tagline: "连江海产经营伙伴",
  slogan: "一个人，也能把生意跑起来。",
  heroTitle: "一张产品图，跑通一场生意。",
} as const;
