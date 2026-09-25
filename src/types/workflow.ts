import type { AgentId, AgentStatus } from "./agent";

/**
 * Workflow / AgentTask 类型定义
 * 对应技术文档第 15 章
 */

export type WorkflowStatus = "idle" | "running" | "completed" | "failed";

/** Workflow 中的单个执行阶段（用于驾驶舱可视化） */
export interface WorkflowStage {
  id: AgentId;
  agentName: string;
  /** 该阶段在本次经营中承担的任务 */
  title: string;
  status: AgentStatus;
  /** 耗时展示文案，如「12s」 */
  durationText?: string;
  /** 阶段产出摘要 */
  outputSummary?: string;
}

export interface AgentWorkflow {
  id: string;
  goal: string;
  status: WorkflowStatus;
  stages: WorkflowStage[];
  startedAt: string;
  completedAt?: string;
  /** 整体进度 0 ~ 1 */
  progress: number;
  /** 当前执行到的阶段序号 */
  activeStageIndex: number;
}

export interface AgentTask {
  id: string;
  workflowId: string;
  agentType: AgentId;
  agentName: string;
  title: string;
  status: AgentStatus;
  /** 展示用时间文案，如「10:24 完成」 */
  timeText?: string;
  /** 任务被哪个 Agent 触发 */
  triggeredBy?: string;
}
