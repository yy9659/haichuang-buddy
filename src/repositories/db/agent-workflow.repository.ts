/**
 * 工作流仓储 · 数据库实现（Drizzle + Supabase PostgreSQL）
 *
 * 表约束与语义：
 * - `business_id` **必填**（工作流一定属于某个商家），商家删除时级联清理；
 * - `plan` / `summary` 为 jsonb，存计划快照与执行统计；
 * - `completed_at` 由终态驱动，规则复用 `../agent-workflow` 的共享实现，
 *   与 Mock 仓储完全一致 —— 这正是「切数据源不改上层」能够成立的原因。
 *
 * 与 `WorkflowRepository` 无关：那是驾驶舱的只读展示接口，本文件是编排层的持久化。
 */

import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { agentWorkflows } from "@/db/schema";
import { isUuid } from "@/lib/id";
import { AppError } from "@/lib/result";

import {
  applyWorkflowPatch,
  isTerminalWorkflowStatus,
  type WorkflowPatch,
} from "../agent-workflow";
import { resolveCompletedAt } from "../lifecycle";
import type {
  AgentWorkflowRecord,
  AgentWorkflowRepository,
  AgentWorkflowSummary,
  NewAgentWorkflowInput,
} from "../types";
import { mapDatabaseError } from "./errors";
import { mapAgentWorkflowRow } from "./mappers";
import { resolvePrimaryBusinessId } from "./shared";

/** 单次查询返回的历史工作流上限，防止界面上拉出整张表 */
const MAX_RECENT_LIMIT = 20;

export function createDbAgentWorkflowRepository(): AgentWorkflowRepository {
  /** 读取一行，不存在则抛 NOT_FOUND —— 四处状态流转都要用 */
  async function requireWorkflow(id: string): Promise<AgentWorkflowRecord> {
    if (!isUuid(id)) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "工作流记录不存在",
        detail: `workflowId=${id}`,
      });
    }
    const rows = await getDb()
      .select()
      .from(agentWorkflows)
      .where(eq(agentWorkflows.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "工作流记录不存在",
        detail: `workflowId=${id}`,
      });
    }
    return mapAgentWorkflowRow(row);
  }

  /**
   * 状态流转的统一入口：先读当前值（`completedAt` 的「首次终态时间优先」
   * 规则需要它），按共享规则算出新值，再写回。
   *
   * 之所以不像任务仓储那样手工拼 `values`：工作流要落库的派生字段只有
   * `completedAt` 一个，共享规则算完之后整体覆盖三个可变列即可，
   * 反而比逐字段判 `!== undefined` 更不容易漏。
   */
  async function patch(
    id: string,
    next: WorkflowPatch,
  ): Promise<AgentWorkflowRecord> {
    const current = await requireWorkflow(id);
    const updated = applyWorkflowPatch(current, next);

    /**
     * `completedAt` 单独用共享规则重算，**而不是**把 `updated.completedAt`
     * 解析回 Date 再写库。
     *
     * 原因：`applyWorkflowPatch` 返回的是领域记录，它的 `completedAt` 已经过
     * `formatDateTime`，只剩**分钟**精度。拿它写 `timestamptz` 会把宝贵的
     * 毫秒精度削掉，而 `../lifecycle` 明确要求「数据库实现直接拿这个 Date 写库
     * （保留毫秒精度），Mock 实现再用 formatDateTime 转成展示字符串」。
     *
     * 重算走的是同一个纯规则（`resolveCompletedAt` + `isTerminalWorkflowStatus`），
     * 不是抄一份逻辑；对上层可见值毫无影响 —— 读回来仍由 `mapAgentWorkflowRow`
     * 统一格式化，Mock 与数据库的**返回结果**继续完全一致。
     */
    const completedAt = resolveCompletedAt({
      isTerminal: isTerminalWorkflowStatus(updated.status),
      current: current.completedAt,
      now: new Date(),
    });

    const rows = await getDb()
      .update(agentWorkflows)
      .set({
        status: updated.status,
        completedAt,
        summary: updated.summary,
        errorMessage: updated.errorMessage,
      })
      .where(eq(agentWorkflows.id, id))
      .returning();
    const row = rows[0];
    if (!row) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "工作流记录不存在",
        detail: `workflowId=${id}`,
      });
    }
    return mapAgentWorkflowRow(row);
  }

  return {
    async create(input: NewAgentWorkflowInput): Promise<AgentWorkflowRecord> {
      try {
        const businessId = input.businessId || (await resolvePrimaryBusinessId());
        const rows = await getDb()
          .insert(agentWorkflows)
          .values({
            businessId,
            goal: input.goal,
            status: input.status ?? "idle",
            plan: input.plan ?? null,
            summary: input.summary ?? null,
            errorMessage: input.errorMessage ?? null,
          })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "工作流创建失败：数据库未返回记录",
          });
        }
        return mapAgentWorkflowRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "创建工作流");
      }
    },

    async findById(id: string) {
      if (!isUuid(id)) {
        return null;
      }
      try {
        const rows = await getDb()
          .select()
          .from(agentWorkflows)
          .where(eq(agentWorkflows.id, id))
          .limit(1);
        const row = rows[0];
        return row ? mapAgentWorkflowRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载工作流");
      }
    },

    async findLatestRunning() {
      try {
        const rows = await getDb()
          .select()
          .from(agentWorkflows)
          .where(eq(agentWorkflows.status, "running"))
          .orderBy(desc(agentWorkflows.createdAt))
          .limit(1);
        const row = rows[0];
        return row ? mapAgentWorkflowRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载运行中的工作流");
      }
    },

    async markRunning(id: string) {
      try {
        // 新一轮开始：作废上一轮的统计与错误（与 Mock 实现逐字一致）
        return await patch(id, {
          status: "running",
          summary: null,
          errorMessage: null,
        });
      } catch (cause) {
        throw mapDatabaseError(cause, "更新工作流状态");
      }
    },

    async markCompleted(id: string, summary: AgentWorkflowSummary) {
      try {
        return await patch(id, {
          status: "completed",
          summary,
          errorMessage: null,
        });
      } catch (cause) {
        throw mapDatabaseError(cause, "更新工作流状态");
      }
    },

    async markPartiallyCompleted(
      id: string,
      params: { summary: AgentWorkflowSummary; errorMessage?: string | null },
    ) {
      try {
        return await patch(id, {
          status: "partially_completed",
          summary: params.summary,
          errorMessage: params.errorMessage ?? null,
        });
      } catch (cause) {
        throw mapDatabaseError(cause, "更新工作流状态");
      }
    },

    async markFailed(
      id: string,
      params: { errorMessage: string; summary?: AgentWorkflowSummary | null },
    ) {
      try {
        return await patch(id, {
          status: "failed",
          errorMessage: params.errorMessage,
          // 未传 summary 时保持原值（`WorkflowPatch` 的 undefined = 不改）
          ...(params.summary === undefined ? {} : { summary: params.summary }),
        });
      } catch (cause) {
        throw mapDatabaseError(cause, "更新工作流状态");
      }
    },

    async listRecent(limit?: number) {
      const safeLimit = Math.min(
        MAX_RECENT_LIMIT,
        Math.max(1, Math.trunc(limit ?? MAX_RECENT_LIMIT)),
      );
      try {
        const rows = await getDb()
          .select()
          .from(agentWorkflows)
          .orderBy(desc(agentWorkflows.createdAt))
          .limit(safeLimit);
        return rows.map(mapAgentWorkflowRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载工作流列表");
      }
    },
  };
}
