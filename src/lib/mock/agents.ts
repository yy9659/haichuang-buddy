import {
  Brain,
  ChartLine,
  FileText,
  Headphones,
  Megaphone,
  Package,
  Palette,
} from "lucide-react";
import type { AgentEmployee } from "@/types";

/**
 * AI 数字员工（Mock）
 * 对应技术文档第 6 章：1 个 Supervisor + 6 个核心 Agent
 * 注意：本轮不包含任何 Agent 逻辑，仅提供 UI 展示数据。
 */
export const MOCK_AGENTS: AgentEmployee[] = [
  {
    id: "product_agent",
    name: "商品经理",
    role: "商品理解 · 卖点提炼",
    description: "读取商品图片与资料，输出结构化 Product DNA，供其他 AI 员工共享。",
    status: "completed",
    currentTask: "分析商品图片，生成 Product DNA",
    lastRunAt: "今日 10:24",
    lastRunSummary: "已生成「连江鲜活鲍鱼」Product DNA，识别 4 个核心卖点",
    icon: Package,
    accent: "ocean",
    skills: ["多模态分析", "卖点提炼", "风险提示"],
  },
  {
    id: "brand_agent",
    name: "品牌经理",
    role: "品牌定位 · 故事策划",
    description: "基于 Product DNA 与老板数字分身，制定品牌定位、Slogan 与品牌故事。",
    status: "completed",
    currentTask: "生成品牌定位和故事",
    lastRunAt: "今日 11:03",
    lastRunSummary: "输出品牌定位「连江直发 · 家庭海鲜餐桌」与 3 条品牌价值",
    icon: Palette,
    accent: "violet",
    skills: ["品牌定位", "人群策略", "IP 概念"],
  },
  {
    id: "content_agent",
    name: "内容运营",
    role: "图文视频 · 营销内容",
    description: "按平台调性批量生成短视频脚本、图文笔记与营销文案。",
    status: "running",
    currentTask: "生成 3 条家庭场景营销内容",
    lastRunAt: "今日 11:26",
    lastRunSummary: "已完成 2 / 3 条，剩余 1 条预计 3 分钟内产出",
    icon: FileText,
    accent: "teal",
    skills: ["多平台适配", "脚本撰写", "镜头建议"],
  },
  {
    id: "live_agent",
    name: "AI直播导演",
    role: "直播策略 · 主播话术",
    description: "实时分析直播评论，检测热点问题并给主播生成即时建议与异议话术。",
    status: "queued",
    currentTask: "生成今晚直播策略和主播话术",
    lastRunAt: "今日 12:10",
    lastRunSummary: "已就绪，等待直播开始后进入实时响应",
    icon: Megaphone,
    accent: "rose",
    skills: ["评论分类", "热点检测", "异议处理"],
  },
  {
    id: "customer_service_agent",
    name: "智能客服",
    role: "知识库 · 智能问答",
    description: "基于商品与售后知识库回答客户咨询，无可靠信息时主动建议转人工。",
    status: "completed",
    currentTask: "整理直播前高频问答",
    lastRunAt: "今日 09:48",
    lastRunSummary: "整理 12 条直播前高频问答，覆盖储存与物流问题",
    icon: Headphones,
    accent: "emerald",
    skills: ["问题分类", "知识检索", "转人工判断"],
  },
  {
    id: "analytics_agent",
    name: "经营分析师",
    role: "数据分析 · 经营复盘",
    description: "读取程序计算的经营指标，完成归因解释与明日行动建议。",
    status: "idle",
    currentTask: "等待今日数据汇总后生成经营日报",
    lastRunAt: "今日 08:30",
    lastRunSummary: "昨日经营评分 78，主要问题是客服响应偏慢",
    icon: ChartLine,
    accent: "amber",
    skills: ["指标解释", "问题归因", "行动建议"],
  },
];

/** AI 经营大脑（Supervisor），在驾驶舱 Workflow 区域单独展示 */
export const MOCK_BUSINESS_BRAIN: AgentEmployee = {
  id: "business_brain",
  name: "AI经营大脑",
  role: "任务规划 · 调度执行",
  description: "理解经营目标，拆解任务并决定各 AI 员工的执行顺序与协作方式。",
  status: "running",
  currentTask: "规划今日经营任务链",
  lastRunAt: "今日 12:05",
  lastRunSummary: "已拆解 5 个任务并分配至对应 AI 员工",
  icon: Brain,
  accent: "ocean",
  skills: ["目标理解", "任务拆解", "状态跟踪"],
  supervisor: true,
};

/** 全部 AI 员工（含 Supervisor） */
export const MOCK_AGENT_EMPLOYEES: AgentEmployee[] = [
  MOCK_BUSINESS_BRAIN,
  ...MOCK_AGENTS,
];
