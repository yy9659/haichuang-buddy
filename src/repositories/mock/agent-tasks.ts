/**
 * Agent 任务仓储 · Mock 实现
 *
 * 与数据库实现保持同一套语义（这是「切数据源不改上层」的前提）：
 * - 任务按创建时间倒序排列，`findLatestByProduct` 取最近一条；
 * - 状态流转规则（终态补 completedAt、进度夹取）复用 `../agent-task` 的共享实现；
 * - 商品删除时任务随之清理（对应数据库的 ON DELETE CASCADE）。
 *
 * 数据仅存在于进程内存，重启即清空 —— 这一点与其它 Mock 仓储一致，
 * 绝不能让界面产生「已经落库」的错觉。
 */

import { formatDateTime } from "@/lib/datetime";
import { createLocalId } from "@/lib/id";
import { AppError } from "@/lib/result";
import type { AgentId } from "@/types";

import { applyAgentTaskPatch, clampTaskProgress } from "../agent-task";
import type { AgentTaskRecord, AgentTaskRepository } from "../types";
import {
  findStoredAgentTask,
  listStoredAgentTasks,
  putStoredAgentTask,
  replaceStoredAgentTask,
} from "./store";

export function createMockAgentTaskRepository(): AgentTaskRepository {
  return {
    async create(input) {
      const record: AgentTaskRecord = {
        id: createLocalId("task"),
        agentType: input.agentType,
        title: input.title,
        status: input.status ?? "queued",
        progress: clampTaskProgress(input.progress),
        productId: input.productId ?? null,
        workflowId: input.workflowId ?? null,
        input: input.input ?? null,
        output: null,
        errorMessage: null,
        durationMs: null,
        createdAt: formatDateTime(new Date()),
        completedAt: null,
      };
      putStoredAgentTask(record);
      return record;
    },

    async update(id: string, patch) {
      const current = findStoredAgentTask(id);
      if (!current) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "Agent 任务记录不存在",
          detail: `taskId=${id}`,
        });
      }
      const next = applyAgentTaskPatch(current, patch);
      replaceStoredAgentTask(next);
      return next;
    },

    async findLatestByProduct(productId: string, agentType: AgentId) {
      return (
        listStoredAgentTasks().find(
          (task) => task.productId === productId && task.agentType === agentType,
        ) ?? null
      );
    },

    async listByProduct(productId: string, agentType: AgentId, limit?: number) {
      const matches = listStoredAgentTasks().filter(
        (task) => task.productId === productId && task.agentType === agentType,
      );
      if (limit === undefined) {
        return matches;
      }
      return matches.slice(0, Math.max(0, limit));
    },

    async findLatestByType(agentType: AgentId) {
      // 任务按创建时间倒序保存，第一个命中项即最近一次
      return listStoredAgentTasks().find((task) => task.agentType === agentType) ?? null;
    },

    async listByWorkflow(workflowId: string, limit?: number) {
      const matches = listStoredAgentTasks().filter(
        (task) => task.workflowId === workflowId,
      );
      if (limit === undefined) {
        return matches;
      }
      return matches.slice(0, Math.max(0, limit));
    },

    async listRecent(limit?: number) {
      // 内存数组本身就是「最近在前」（create 用 unshift 插入）
      const all = listStoredAgentTasks();
      if (limit === undefined) {
        return [...all];
      }
      return all.slice(0, Math.max(0, limit));
    },
  };
}
