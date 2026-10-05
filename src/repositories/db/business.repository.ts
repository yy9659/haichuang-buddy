/**
 * 商家 / 老板数字分身 / 任务通知 仓储 · 数据库实现
 *
 * 关于通知：S1-1 没有单独的通知表，顶部栏的 AI 任务通知由
 * `agent_tasks`（Agent 执行记录）派生 —— 这与产品语义一致：
 * 用户看到的每条「AI 任务通知」本质上就是某个 Agent 的一次执行结果。
 * 后续阶段若需要「已读/未读」状态，再补一张 notifications 表。
 */

import { asc, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { agentTasks, agentWorkflows, businesses, ownerProfiles } from "@/db/schema";
import { formatRelativeTime } from "@/lib/datetime";
import { AGENT_NAME_LABEL, AGENT_STATUS_META } from "@/lib/status-meta";
import { AppError } from "@/lib/result";
import type { AgentNotification, BusinessProfile, OwnerTwin } from "@/types";

import type {
  BusinessRepository,
  NewBusinessInput,
  UpdateBusinessInput,
  UpdateOwnerTwinInput,
} from "../types";
import { mapDatabaseError } from "./errors";
import { mapBusinessRow, mapOwnerProfileRow } from "./mappers";
import { findPrimaryBusiness, resolvePrimaryBusinessId } from "./shared";

/** 顶部栏最多展示的 AI 任务通知条数 */
const NOTIFICATION_LIMIT = 6;

export function createDbBusinessRepository(): BusinessRepository {
  return {
    async getProfile(): Promise<BusinessProfile | null> {
      try {
        const { business } = await findPrimaryBusiness();
        return business;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载商家资料");
      }
    },

    /**
     * 全库最早的商家（**不经过会话上下文**）。
     *
     * 与 `getProfile()` 的唯一差别就是「不解析当前商家」——
     * 因此它能在注册流程（会话尚未建立）里回答「有没有可认领的演示商家」。
     * 见接口注释：调用方只有注册服务一处。
     */
    async findEarliestProfile(): Promise<BusinessProfile | null> {
      try {
        const rows = await getDb()
          .select()
          .from(businesses)
          .orderBy(asc(businesses.createdAt))
          .limit(1);
        const row = rows[0];
        return row ? mapBusinessRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载商家资料");
      }
    },

    async create(input: NewBusinessInput): Promise<BusinessProfile> {
      try {
        const rows = await getDb()
          .insert(businesses)
          .values({
            name: input.name,
            shortName: input.shortName,
            description: input.description ?? "",
            owner: input.owner ?? "",
            location: input.location ?? "",
            mainCategory: input.mainCategory ?? "",
            storeCount: input.storeCount ?? 0,
            channels: input.channels ?? [],
          })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "创建商家档案失败：数据库未返回记录",
          });
        }
        return mapBusinessRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "创建商家档案");
      }
    },

    async updateProfile(patch: UpdateBusinessInput): Promise<BusinessProfile> {
      try {
        const businessId = await resolvePrimaryBusinessId();

        const values: Partial<typeof businesses.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (patch.name !== undefined) values.name = patch.name;
        if (patch.shortName !== undefined) values.shortName = patch.shortName;
        if (patch.description !== undefined) values.description = patch.description;
        if (patch.logoUrl !== undefined) values.logoUrl = patch.logoUrl;
        if (patch.owner !== undefined) values.owner = patch.owner;
        if (patch.location !== undefined) values.location = patch.location;
        if (patch.mainCategory !== undefined) values.mainCategory = patch.mainCategory;
        if (patch.storeCount !== undefined) values.storeCount = patch.storeCount;
        if (patch.channels !== undefined) values.channels = patch.channels;

        const rows = await getDb()
          .update(businesses)
          .set(values)
          .where(eq(businesses.id, businessId))
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "商家档案不存在",
            detail: `businessId=${businessId}`,
          });
        }
        return mapBusinessRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新商家资料");
      }
    },

    async getOwnerTwin(): Promise<OwnerTwin | null> {
      try {
        const { ownerTwin } = await findPrimaryBusiness();
        return ownerTwin;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载老板数字分身");
      }
    },

    async updateOwnerTwin(
      patch: UpdateOwnerTwinInput,
      options?: { businessId?: string },
    ): Promise<OwnerTwin> {
      try {
        // 注册流程必须显式传 businessId：那时会话尚未建立，
        // 「当前商家」解析不到刚创建出来的那一个。
        const businessId = options?.businessId ?? (await resolvePrimaryBusinessId());
        const db = getDb();

        const values: Partial<typeof ownerProfiles.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (patch.displayName !== undefined) values.displayName = patch.displayName;
        if (patch.avatarLabel !== undefined) values.avatarLabel = patch.avatarLabel;
        if (patch.businessPhilosophy !== undefined) {
          values.businessPhilosophy = patch.businessPhilosophy;
        }
        if (patch.tone !== undefined) values.tone = patch.tone;
        if (patch.salesStyle !== undefined) values.salesStyle = patch.salesStyle;
        if (patch.targetCustomers !== undefined) {
          values.targetCustomers = patch.targetCustomers;
        }
        if (patch.forbiddenExpressions !== undefined) {
          values.forbiddenExpressions = patch.forbiddenExpressions;
        }

        const updated = await db
          .update(ownerProfiles)
          .set(values)
          .where(eq(ownerProfiles.businessId, businessId))
          .returning();

        const updatedRow = updated[0];
        if (updatedRow) {
          return mapOwnerProfileRow(updatedRow);
        }

        // 尚未建档则直接创建，避免「第一次编辑必然失败」
        const inserted = await db
          .insert(ownerProfiles)
          .values({
            businessId,
            displayName: patch.displayName ?? "",
            avatarLabel: patch.avatarLabel ?? "",
            businessPhilosophy: patch.businessPhilosophy ?? [],
            tone: patch.tone ?? [],
            salesStyle: patch.salesStyle ?? "",
            targetCustomers: patch.targetCustomers ?? [],
            forbiddenExpressions: patch.forbiddenExpressions ?? [],
          })
          .returning();

        const insertedRow = inserted[0];
        if (!insertedRow) {
          throw new AppError({
            code: "DB_ERROR",
            message: "保存老板数字分身失败：数据库未返回记录",
          });
        }
        return mapOwnerProfileRow(insertedRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新老板数字分身");
      }
    },

    async listNotifications(): Promise<AgentNotification[]> {
      try {
        const rows = await getDb()
          .select({
            id: agentTasks.id,
            title: agentTasks.title,
            agentType: agentTasks.agentType,
            status: agentTasks.status,
            createdAt: agentTasks.createdAt,
            completedAt: agentTasks.completedAt,
          })
          .from(agentTasks)
          .innerJoin(agentWorkflows, eq(agentTasks.workflowId, agentWorkflows.id))
          .orderBy(desc(agentTasks.createdAt))
          .limit(NOTIFICATION_LIMIT);

        return rows.map((row) => ({
          id: row.id,
          title: row.title,
          description: `${AGENT_NAME_LABEL[row.agentType]} · ${
            AGENT_STATUS_META[row.status].label
          }`,
          timeText: formatRelativeTime(row.completedAt ?? row.createdAt),
          read: row.status === "completed",
        }));
      } catch (cause) {
        throw mapDatabaseError(cause, "加载 AI 任务通知");
      }
    },
  };
}
