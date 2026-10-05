/**
 * 编排层共享类型（S4-1）
 *
 * 这里只放「横跨多个模块」的类型：执行器产出它们、状态机（工作流服务）消费它们、
 * 测试断言它们。凡是只在一个模块内部流转的形状，就定义在那个模块里，
 * 不要为了「看着整齐」把类型全堆到一处 —— 那会让每个模块的职责边界变模糊。
 */

import type { PlannerAgentId } from "@/ai/schemas/business-plan";
import type {
  AgentWorkflowSummary,
  WorkflowTaskOutcome,
} from "@/repositories/types";
import type { AgentStatus } from "@/types";

/**
 * 单个任务**本次是怎么完成的**。
 *
 * 与 `AgentStatus` 是两个维度，刻意都保留、不做合并：
 * - `AgentStatus` 回答「任务成功了吗」（completed / failed / skipped）；
 * - `outcome` 回答「它是怎么完成的」。
 *
 * 合并会丢失界面必须表达的信息：`reused` 与 `executed` 的状态都是 `completed`，
 * 但对商家的含义完全不同 —— 前者是「省了一次模型调用」，后者是「真的跑了一遍」。
 * 驾驶舱要能把这两件事分开说，合成一个字段就说不出来了。
 *
 * 类型本体定义在 `@/repositories/types`：它要随工作流摘要一起落库，
 * 仓储层需要搬运这个形状，却不应反向依赖 AI 层。这里只是转出便于编排层使用。
 */
export type { WorkflowTaskOutcome };

/**
 * 任务未执行的原因。
 *
 * 只有两种，且都不该被含糊过去：
 * - `dependency_failed`：上游失败，本任务被阻塞（**坏事**，商家要处理上游）；
 * - `workflow_aborted`：整轮执行被中止（超时 / 取消），与任务本身无关（**中性**）。
 */
export type TaskSkipReason = "dependency_failed" | "workflow_aborted";

/**
 * 单个任务的执行记录，序列化后写进 `agent_tasks.output`。
 *
 * 用 `type` 而非 `interface`：它要作为 `Record<string, unknown>` 落库
 * （interface 缺隐式索引签名，会被 TS 拦下）。
 */
export type WorkflowTaskRecord = {
  taskId: string;
  agent: PlannerAgentId;
  title: string;
  /** 落库时的 `agent_tasks.status`；由本记录推导，不由调用方随意指定 */
  status: AgentStatus;
  outcome: WorkflowTaskOutcome;
  /** 复用时的说明（面向商家，如「该商品已有商品理解结论」） */
  reuseReason?: string;
  /** 未执行的原因 */
  skipReason?: TaskSkipReason;
  /**
   * 被哪些前置任务挡住（存 id）。
   * 只记原因不记来源，界面只能干巴巴地说「被上游拖住了」，
   * 商家没法知道该去修哪一步。
   */
  blockedBy?: string[];
  errorMessage?: string;
  errorCode?: string;
  /** 真实耗时（毫秒）。复用与跳过恒为 0 —— 它确实没跑 */
  durationMs: number;
  /** 产出对象的标识（内容 id / 品牌档案 id / 商品 id），便于界面跳转 */
  outputRef?: string;
};

/** 一轮编排的最终结果 */
export type WorkflowRunResult = {
  /**
   * 收尾状态。**没有 `cancelled`**：本轮只有「跑完」与「被中止」两种收束，
   * 而中止时是否算成功仍取决于已完成的任务数。人工取消（真的中断一轮执行）
   * 属 S4-2 的界面能力，届时由那一层写入 `cancelled`，这里不预先伪造。
   */
  status: "completed" | "failed" | "partially_completed";
  summary: AgentWorkflowSummary;
  /** 按计划顺序（即展示顺序）排列的逐任务记录 */
  tasks: WorkflowTaskRecord[];
  /**
   * 面向商家的一句话结果说明。
   * 仅在**一切顺利**时为 null —— 有任何一个任务没做成，都必须说出来。
   */
  errorMessage: string | null;
};
