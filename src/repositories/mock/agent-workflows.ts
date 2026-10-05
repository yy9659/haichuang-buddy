/**
 * 工作流仓储 · Mock 实现（S4-1）
 *
 * 与数据库实现保持同一套语义（这是「切数据源不改上层」的前提）：
 * - 工作流按创建时间倒序排列，`findLatestRunning` / `listRecent` 顺序扫描即可；
 * - 状态流转规则复用 `../agent-workflow` 的共享实现（含终态时间口径）；
 * - 删除工作流时连带删除其任务（对应数据库 `agent_tasks.workflow_id ON DELETE CASCADE`）。
 *
 * 数据仅存在于进程内存，重启即清空 —— 与其它 Mock 仓储一致，
 * 绝不能让界面产生「已经落库」的错觉。
 */

import { formatDateTime } from "@/lib/datetime";
import { createLocalId } from "@/lib/id";
import { AppError } from "@/lib/result";

import { applyWorkflowPatch, type WorkflowPatch } from "../agent-workflow";
import type { AgentWorkflowRecord, AgentWorkflowRepository } from "../types";
import {
  findStoredAgentWorkflow,
  listStoredAgentWorkflows,
  putStoredAgentWorkflow,
  replaceStoredAgentWorkflow,
} from "./store";

export function createMockAgentWorkflowRepository(): AgentWorkflowRepository {
  /** 取出工作流，不存在则抛错 —— 四处状态流转都要用，避免各写一遍判空 */
  function requireWorkflow(id: string): AgentWorkflowRecord {
    const current = findStoredAgentWorkflow(id);
    if (!current) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "工作流记录不存在",
        detail: `workflowId=${id}`,
      });
    }
    return current;
  }

  function patch(id: string, next: WorkflowPatch): AgentWorkflowRecord {
    const updated = applyWorkflowPatch(requireWorkflow(id), next);
    replaceStoredAgentWorkflow(updated);
    return updated;
  }

  return {
    async create(input) {
      const record: AgentWorkflowRecord = {
        id: createLocalId("wf"),
        businessId: input.businessId,
        goal: input.goal,
        status: input.status ?? "idle",
        plan: input.plan ?? null,
        summary: input.summary ?? null,
        errorMessage: input.errorMessage ?? null,
        createdAt: formatDateTime(new Date()),
        completedAt: null,
      };
      putStoredAgentWorkflow(record);
      return record;
    },

    async findById(id) {
      return findStoredAgentWorkflow(id) ?? null;
    },

    async findLatestRunning() {
      // 已按创建时间倒序保存，第一个命中项即最近一条
      return (
        listStoredAgentWorkflows().find(
          (workflow) => workflow.status === "running",
        ) ?? null
      );
    },

    async markRunning(id) {
      /**
       * 新一轮开始：把上一轮的统计与错误一并作废。
       * 不清掉的话，重试/重跑期间界面会一边显示「运行中」一边挂着上次的失败原因，
       * 商家会以为重试没生效 —— S3-2 内容工厂踩过同一个坑。
       */
      return patch(id, {
        status: "running",
        summary: null,
        errorMessage: null,
      });
    },

    async markCompleted(id, summary) {
      return patch(id, { status: "completed", summary, errorMessage: null });
    },

    async markPartiallyCompleted(id, params) {
      return patch(id, {
        status: "partially_completed",
        summary: params.summary,
        errorMessage: params.errorMessage ?? null,
      });
    },

    async markFailed(id, params) {
      return patch(id, {
        status: "failed",
        errorMessage: params.errorMessage,
        // 未传 summary 时保持原值（`WorkflowPatch` 的 undefined = 不改）
        ...(params.summary === undefined ? {} : { summary: params.summary }),
      });
    },

    async listRecent(limit) {
      const all = listStoredAgentWorkflows();
      const effective = limit === undefined ? all.length : Math.max(0, limit);
      // slice 而非直接返回内部数组：调用方拿到引用后误改会污染存储
      return all.slice(0, effective);
    },
  };
}
