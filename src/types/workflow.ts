/**
 * Workflow 状态机定义
 * 对应技术文档第 15 章
 *
 * S4-2 起本文件**只剩状态机本身**。原先的 `AgentWorkflow` / `WorkflowStage` /
 * `AgentTask` 三个类型是 Phase 0 驾驶舱的展示模型，它们描述的是
 * 「一条演示用的工作流长什么样」（`progress: 0.37`、`activeStageIndex: 2`），
 * 与 S4-1 编排层真实落库的 `agent_workflows` / `agent_tasks` 是两套东西。
 *
 * 保留两套的代价已经在 S4-2 显现：驾驶舱要显示真实工作流时，必须先决定
 * 「演示态的那份数据算不算数」。所以本轮把它们删掉了 ——
 * 真实工作流的视图由 `services/dashboard.ts` 装配（`BusinessWorkflowState`
 * 与 `DashboardWorkflowListItem`），定义在各自的服务模块里，
 * 不在这里再抽象一层「通用工作流」。
 *
 * 反过来，**逐步结果报告**（`WorkflowStepReport` / `AgentWorkflowSummary`）
 * 本轮从仓储层**搬到了本文件**：它们是编排层真正产出的业务结果，
 * 驾驶舱的展示映射（`@/lib/workflow-display`）要读它们，
 * 而客户端组件不可能 import 数据层（那会把 Drizzle 与连接串打进浏览器包）。
 * 这是一次「按依赖方向归位」，并非又抽象了一层。
 */

import type { AgentId, AgentStatus } from "./agent";

/**
 * Workflow 状态机。
 *
 * `partially_completed` 是 S4-1 编排层真正跑起来之后才需要的：
 * 一輪经营里「两条内容任务，抖音成功、朋友圈失败」是**常态**而非异常，
 * 把它归到 `failed` 会让商家以为整轮白跑了，归到 `completed` 又是撒谎。
 *
 * `cancelled` 预留给人工中止（本轮尚未产生该状态，但状态机先留位，
 * 避免之后加状态又要动 enum 迁移）。
 */
export type WorkflowStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "partially_completed"
  | "cancelled";

/** 终态：走到这里就不会再变了（`running` / `idle` 不是终态） */
export const TERMINAL_WORKFLOW_STATUSES = [
  "completed",
  "failed",
  "partially_completed",
  "cancelled",
] as const satisfies readonly WorkflowStatus[];

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

/* ------------------------------------------------------------------ */
/* 逐步结果报告                                                        */
/* ------------------------------------------------------------------ */

/**
 * 计划里的一个步骤**本轮是怎么落地的**。
 *
 * 与 `AgentStatus` 是**两个维度**，不能合并：
 * `reused` 与 `executed` 在任务状态上都是 `completed`，但对商家的含义相反 ——
 * 前者「没花钱」，后者「真跑了」。合成一个字段，驾驶舱就只能撒谎
 * （要么把复用说成完成、要么把完成说成复用）。
 */
export type WorkflowTaskOutcome = "executed" | "reused" | "skipped" | "failed";

/**
 * 计划里某一步的执行结果报告。
 *
 * 为什么必须落库、而不能只查 `agent_tasks`：
 * **复用与跳过的步骤从未进入任何 Agent 服务**，因此不会有任务记录。
 * 若不在这里留一份，「计划 5 步为什么只跑了 2 步」就永远说不清 ——
 * 而这恰恰是商家最想问的问题。
 *
 * 定义在 `src/types`（而不是仓储层）的原因见文件头的 S4-2 说明：
 * 驾驶舱的展示映射要读它，而客户端组件不能 import 数据层。
 */
export type WorkflowStepReport = {
  /** 计划内部的任务 id（与 `agent_workflows.plan.tasks[].id` 对应） */
  taskId: string;
  agent: AgentId;
  title: string;
  /** 落到 `agent_tasks` 的状态；复用记为 completed（它确实成了，只是没重跑） */
  status: AgentStatus;
  outcome: WorkflowTaskOutcome;
  /** 复用原因 / 失败原因 / 跳过原因，由 `outcome` 决定是哪一种 */
  note: string | null;
  /** 被哪些前置任务挡住（跳过时才有） */
  blockedBy: string[];
  /** 产出对象标识（内容 id / 品牌档案 id / 商品 id） */
  outputRef: string | null;
  durationMs: number;
};

/**
 * 工作流执行摘要。
 *
 * `reused` 与 `skipped` 分开计数，因为它们对商家的含义相反：
 * `reused` 是「省了一笔模型调用」（好事），`skipped` 是「被上游失败拖住了」（坏事）。
 * 合成一个数字会让驾驶舱无法如实表达。
 *
 * 用 `type` 而非 `interface`：它要直接作为 jsonb 列的值落库，
 * 需要能赋给 `Record<string, unknown>`（interface 缺隐式索引签名，会被 TS 拦下）。
 */
export type AgentWorkflowSummary = {
  totalTasks: number;
  /** 真正调用了 Agent 的任务数 */
  executed: number;
  /** 已有有效结果、直接复用的任务数 */
  reused: number;
  /** 未执行且非复用（上游依赖失败被阻塞）的任务数 */
  skipped: number;
  failed: number;
  /**
   * 逐步结果报告。**可选**：`idle` / `running` 阶段没有报告，
   * 手工构造摘要（测试）也可以不带。
   */
  steps?: WorkflowStepReport[];
};
