import type { IconComponent } from "./common";

/**
 * AI 数字员工类型定义
 * 对应技术文档第 6 章：1 个 Supervisor + 6 个核心 Agent
 */

export type AgentId =
  | "business_brain"
  | "product_agent"
  | "brand_agent"
  | "content_agent"
  | "live_agent"
  | "customer_service_agent"
  | "analytics_agent";

/** 运行状态机，见技术文档 9.1 */
export type AgentStatus = "idle" | "queued" | "running" | "completed" | "failed";

/** 视觉主题色（用于卡片强调色，不作为业务语义） */
export type AgentAccent =
  | "ocean"
  | "teal"
  | "violet"
  | "amber"
  | "rose"
  | "emerald";

/** AI 员工卡片数据 */
export interface AgentEmployee {
  id: AgentId;
  /** 员工名称，如「商品经理」 */
  name: string;
  /** 一句话职责 */
  role: string;
  /** 更详细的能力说明 */
  description: string;
  status: AgentStatus;
  /** 当前任务标题 */
  currentTask: string;
  /** 最近一次执行时间（Mock ISO 字符串） */
  lastRunAt: string;
  /** 最近一次执行结果摘要 */
  lastRunSummary: string;
  icon: IconComponent;
  accent: AgentAccent;
  /** 能力标签 */
  skills: string[];
  /** 是否为核心 Supervisor（视觉上单独表达） */
  supervisor?: boolean;
}

export interface AgentStatusMeta {
  label: string;
  tone: "neutral" | "primary" | "success" | "warning" | "danger" | "info";
}
