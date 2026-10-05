/**
 * AI 数字员工类型定义
 * 对应技术文档第 6 章：1 个 Supervisor + 6 个核心 Agent
 *
 * S4-2 起，员工的**静态档案**（名称 / 职责 / 图标 / 能力标签 / 是否已接入）
 * 统一放在 `@/lib/agents`，不再定义在本文件。
 * 原因：`AgentEmployee`（S0 的展示模型）把 `status` / `currentTask` / `lastRunAt`
 * 直接写成了必填字段，于是「演示态」被固化进了常量类型 —— 页面只要忘记用真实
 * 数据覆盖它，就会渲染出一个从未发生过的「已完成」。把静态档案与运行时状态
 * 拆成两个类型（`AgentProfile` vs 驾驶舱的 `DashboardAgentState`），
 * 这个错误在编译期就不可能发生。
 */

export type AgentId =
  | "business_brain"
  | "product_agent"
  | "brand_agent"
  | "content_agent"
  | "live_agent"
  | "customer_service_agent"
  | "analytics_agent";

/**
 * 全部 Agent 标识的运行时清单。
 * 与联合类型用 `satisfies` 绑定：任何一边改了而另一边没跟上都会在编译期报错。
 *
 * 存在的理由：从 jsonb 里读回的记录（如工作流的逐步报告）需要**运行时**校验，
 * 类型系统在那一层帮不上忙；把字面量清单放在类型旁边，比在各处重复写一遍可靠。
 */
export const AGENT_IDS = [
  "business_brain",
  "product_agent",
  "brand_agent",
  "content_agent",
  "live_agent",
  "customer_service_agent",
  "analytics_agent",
] as const satisfies readonly AgentId[];

export function isAgentId(value: unknown): value is AgentId {
  return (
    typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value)
  );
}

/**
 * 运行状态机，见技术文档 9.1
 *
 * `skipped` 是 S4-1 引入的：编排层需要表达「这条任务没有被真正执行」，
 * 且必须能区分两种截然不同的成因（都记在任务 `output` 里，不用两个状态）：
 * - `output.execution = "reused"`          —— 已有有效结果，复用比重算更划算；
 * - `output.skipReason = "dependency_failed"` —— 上游失败，本任务被阻塞。
 *
 * 为什么不新增 `blocked` 状态：`blocked` 描述的是「因为别人失败而没跑」，
 * 而 `reused` 描述的是「因为已经有了而没跑」，两者在状态机上是同一件事
 * ——「本次没有执行」。状态保持精简，成因交给 output 表达。
 */
export type AgentStatus =
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

/** 全部状态的运行时清单（理由同 `AGENT_IDS`） */
export const AGENT_STATUSES = [
  "idle",
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
] as const satisfies readonly AgentStatus[];

export function isAgentStatus(value: unknown): value is AgentStatus {
  return (
    typeof value === "string" &&
    (AGENT_STATUSES as readonly string[]).includes(value)
  );
}


/** 视觉主题色（用于卡片强调色，不作为业务语义） */
export type AgentAccent =
  | "ocean"
  | "teal"
  | "violet"
  | "amber"
  | "rose"
  | "emerald";

export interface AgentStatusMeta {
  label: string;
  tone: "neutral" | "primary" | "success" | "warning" | "danger" | "info";
}

/** 顶部栏 AI 任务通知 */
export interface AgentNotification {
  id: string;
  title: string;
  description: string;
  /** 展示用时间文案，如「3 分钟前」 */
  timeText: string;
  read: boolean;
}
