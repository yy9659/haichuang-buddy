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
    title: "AI经营驾驶舱",
    href: "/dashboard",
    description: "今日经营总览与 AI 员工调度",
    icon: LayoutDashboard,
  },
  {
    title: "商品中心",
    href: "/products",
    description: "商品管理与 Product DNA",
    icon: Package,
  },
  {
    title: "品牌中心",
    href: "/brand",
    description: "品牌定位与老板数字分身",
    icon: Palette,
  },
  {
    title: "内容工厂",
    href: "/content",
    description: "多平台营销内容生产",
    icon: FileText,
  },
  {
    title: "AI直播间",
    href: "/live",
    description: "直播提词与 AI 导演实时建议",
    icon: Video,
  },
  {
    title: "智能客服",
    href: "/customer-service",
    description: "知识库问答与会话处理",
    icon: Headphones,
  },
  {
    title: "经营分析",
    href: "/analytics",
    description: "指标计算与经营日报",
    icon: ChartColumn,
  },
];

export const SITE = {
  name: "海创Buddy",
  tagline: "AI一人公司增长智能体",
  slogan: "一个人，也可以拥有一支 AI 经营团队。",
  heroTitle: "一张产品图，跑通一场生意。",
} as const;
