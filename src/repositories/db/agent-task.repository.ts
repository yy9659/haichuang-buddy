/**
 * Agent 任务仓储 · 数据库实现（Drizzle + Supabase PostgreSQL）
 *
 * 表约束与语义：
 * - `workflow_id` **可空** —— 用户单点触发的商品分析不属于任何经营目标；
 * - `product_id` 可空，商品删除时任务级联清理；
 * - `duration_ms` 记录执行耗时，由服务层在任务结束时写入。
 *
 * 「状态 → completedAt / 进度夹取」的规则复用 `../agent-task` 的共享实现，
 * 与 Mock 仓储完全一致 —— 这正是「切数据源不改上层」能够成立的原因。
 */

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { agentTasks } from "@/db/schema";
import { isUuid } from "@/lib/id";
import { AppError } from "@/lib/result";
import type { AgentId } from "@/types";

import { clampTaskProgress, nextCompletedAt, nextDurationMs } from "../agent-task";
import type {
  AgentTaskRecord,
  AgentTaskRepository,
  NewAgentTaskInput,
} from "../types";
import { mapDatabaseError } from "./errors";
import { mapAgentTaskRow } from "./mappers";

/** 单次查询返回的历史任务上限，防止界面上拉出整张表 */
const MAX_HISTORY_LIMIT = 50;

export function createDbAgentTaskRepository(): AgentTaskRepository {
  return {
    async create(input: NewAgentTaskInput): Promise<AgentTaskRecord> {
      if (input.productId && !isUuid(input.productId)) {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: "Agent 任务创建失败：商品 ID 不合法",
          detail: `productId=${input.productId}`,
          retryable: false,
        });
      }
      /**
       * S4-1 补：`workflowId` 同样要挡。
       * 此前这个字段一直是 null（没有编排层），所以漏了校验；
       * 编排层跑起来后它会真的带上值，非 uuid 会直撞 Postgres 的 22P02，
       * 页面表现成 500 而不是明确的参数错误。
       */
      if (input.workflowId && !isUuid(input.workflowId)) {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: "Agent 任务创建失败：工作流 ID 不合法",
          detail: `workflowId=${input.workflowId}`,
          retryable: false,
        });
      }
      try {
        const rows = await getDb()
          .insert(agentTasks)
          .values({
            agentType: input.agentType,
            title: input.title,
            status: input.status ?? "queued",
            progress: clampTaskProgress(input.progress),
            productId: input.productId ?? null,
            workflowId: input.workflowId ?? null,
            input: input.input ?? null,
          })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "Agent 任务创建失败：数据库未返回记录",
          });
        }
        return mapAgentTaskRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "创建 Agent 任务");
      }
    },

    async update(id, patch): Promise<AgentTaskRecord> {
      if (!isUuid(id)) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "Agent 任务记录不存在",
          detail: `taskId=${id}`,
        });
      }
      try {
        const db = getDb();

        // 先读后写：completedAt 的「首次终态时间优先」规则需要当前值，
        // 在几十条任务的小表上多一次 SELECT 换来的是一致性与可读性。
        const existing = await db
          .select()
          .from(agentTasks)
          .where(eq(agentTasks.id, id))
          .limit(1);

        const currentRow = existing[0];
        if (!currentRow) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "Agent 任务记录不存在",
            detail: `taskId=${id}`,
          });
        }

        const status = patch.status ?? currentRow.status;
        const values: Partial<typeof agentTasks.$inferInsert> = {
          status,
          // 直接写 Date，保留数据库的时间精度（不经过展示字符串往返）
          completedAt: nextCompletedAt({
            status,
            currentCompletedAt: currentRow.completedAt,
            now: new Date(),
          }),
          // 与 Mock 实现共用同一条规则，避免「切数据源就变行为」
          durationMs: nextDurationMs({
            status,
            currentDurationMs: currentRow.durationMs,
            patchDurationMs: patch.durationMs,
          }),
        };
        if (patch.progress !== undefined) {
          values.progress = clampTaskProgress(patch.progress);
        }
        if (patch.output !== undefined) {
          values.output = patch.output;
        }
        if (patch.errorMessage !== undefined) {
          values.errorMessage = patch.errorMessage;
        }

        const rows = await db
          .update(agentTasks)
          .set(values)
          .where(eq(agentTasks.id, id))
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "Agent 任务记录不存在",
            detail: `taskId=${id}`,
          });
        }
        return mapAgentTaskRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新 Agent 任务");
      }
    },

    async findLatestByProduct(productId: string, agentType: AgentId) {
      // URL / 表单传进来的 id 可能不是 uuid，先短路避免 Postgres 抛 22P02
      if (!isUuid(productId)) {
        return null;
      }
      try {
        const rows = await getDb()
          .select()
          .from(agentTasks)
          .where(
            and(
              eq(agentTasks.productId, productId),
              eq(agentTasks.agentType, agentType),
            ),
          )
          .orderBy(desc(agentTasks.createdAt))
          .limit(1);
        const row = rows[0];
        return row ? mapAgentTaskRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载 Agent 任务");
      }
    },

    async listByProduct(productId: string, agentType: AgentId, limit?: number) {
      if (!isUuid(productId)) {
        return [];
      }
      const safeLimit = Math.min(
        MAX_HISTORY_LIMIT,
        Math.max(1, Math.trunc(limit ?? MAX_HISTORY_LIMIT)),
      );
      try {
        const rows = await getDb()
          .select()
          .from(agentTasks)
          .where(
            and(
              eq(agentTasks.productId, productId),
              eq(agentTasks.agentType, agentType),
            ),
          )
          .orderBy(desc(agentTasks.createdAt))
          .limit(safeLimit);
        return rows.map(mapAgentTaskRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载 Agent 任务列表");
      }
    },

    async findLatestByType(agentType: AgentId) {
      try {
        const rows = await getDb()
          .select()
          .from(agentTasks)
          .where(eq(agentTasks.agentType, agentType))
          .orderBy(desc(agentTasks.createdAt))
          .limit(1);
        const row = rows[0];
        return row ? mapAgentTaskRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载 Agent 任务");
      }
    },

    async listByWorkflow(workflowId: string, limit?: number) {
      if (!isUuid(workflowId)) {
        return [];
      }
      const safeLimit = Math.min(
        MAX_HISTORY_LIMIT,
        Math.max(1, Math.trunc(limit ?? MAX_HISTORY_LIMIT)),
      );
      try {
        const rows = await getDb()
          .select()
          .from(agentTasks)
          .where(eq(agentTasks.workflowId, workflowId))
          .orderBy(desc(agentTasks.createdAt))
          .limit(safeLimit);
        return rows.map(mapAgentTaskRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载工作流任务列表");
      }
    },

    async listRecent(limit?: number) {
      /**
       * 上限仍走 `MAX_HISTORY_LIMIT`：经营分析只做聚合统计，
       * 不需要也不应该把整张任务表拉进内存。
       */
      const safeLimit = Math.min(
        MAX_HISTORY_LIMIT,
        Math.max(1, Math.trunc(limit ?? MAX_HISTORY_LIMIT)),
      );
      try {
        const rows = await getDb()
          .select()
          .from(agentTasks)
          .orderBy(desc(agentTasks.createdAt))
          .limit(safeLimit);
        return rows.map(mapAgentTaskRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载最近 Agent 任务");
      }
    },
  };
}
