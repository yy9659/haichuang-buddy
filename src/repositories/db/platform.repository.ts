import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { ensureLocalDatabaseReady, getDb } from "@/db";
import { getDataSource } from "@/lib/env";
import { agentTasks, agentWorkflows, businesses, contents, customerMessages, liveComments, products, publicKnowledgeDocuments, users } from "@/db/schema";
import { platformWeekStart, redactTaskError, seafoodCategory } from "@/lib/admin";
import type { PlatformRepository, PlatformTask, PublicKnowledgeDocument } from "@/types/admin";

const taskFields = {
  id: agentTasks.id, agentType: agentTasks.agentType, title: agentTasks.title, status: agentTasks.status,
  createdAt: agentTasks.createdAt, completedAt: agentTasks.completedAt, durationMs: agentTasks.durationMs,
  errorSummary: agentTasks.errorMessage,
  businessName: sql<string>`coalesce(${businesses.name}, '归属未记录')`,
  providerId: sql<string | null>`${agentTasks.output}->>'providerId'`,
};
function taskQuery() {
  return getDb().select(taskFields).from(agentTasks)
    .leftJoin(agentWorkflows, eq(agentTasks.workflowId, agentWorkflows.id))
    .leftJoin(products, eq(agentTasks.productId, products.id))
    .leftJoin(businesses, sql`${businesses.id}::text = coalesce(${agentWorkflows.businessId}::text, ${products.businessId}::text, ${agentTasks.input}->>'businessId')`);
}
function mapTask(row: Omit<PlatformTask, "createdAt" | "completedAt"> & { createdAt: Date; completedAt: Date | null }): PlatformTask {
  return { ...row, createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null, errorSummary: redactTaskError(row.errorSummary) };
}
function mapKnowledge(row: typeof publicKnowledgeDocuments.$inferSelect): PublicKnowledgeDocument {
  return { ...row, category: row.category as PublicKnowledgeDocument["category"], status: row.status as PublicKnowledgeDocument["status"], createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export function createDbPlatformRepository(): PlatformRepository {
  const ready = async () => { if (getDataSource() === "local") await ensureLocalDatabaseReady(); };
  return {
    async snapshot(now) {
      await ready();
      const [summaryRows, categoryRows, channelRows, locationRows, recentRows, trendRows] = await Promise.all([
        getDb().select({
          merchants: sql<string>`(select count(distinct business_id) from ${users})`,
          materials: sql<string>`(select count(*) from ${contents})`,
          interactions: sql<string>`(select count(*) from ${customerMessages} where role = 'customer') + (select count(*) from ${liveComments})`,
          completed: sql<string>`count(*) filter (where ${agentTasks.status} = 'completed')`,
          failed: sql<string>`count(*) filter (where ${agentTasks.status} = 'failed')`,
          running: sql<string>`count(*) filter (where ${agentTasks.status} = 'running')`,
          queued: sql<string>`count(*) filter (where ${agentTasks.status} = 'queued')`,
          skipped: sql<string>`count(*) filter (where ${agentTasks.status} = 'skipped')`,
          averageDurationMs: sql<string | null>`avg(${agentTasks.durationMs}) filter (where ${agentTasks.status} in ('completed', 'failed'))`,
        }).from(agentTasks),
        getDb().select({ name: products.name, value: sql<string>`count(*)` }).from(products).groupBy(products.name),
        getDb().select({ name: contents.platform, value: sql<string>`count(*)` }).from(contents).groupBy(contents.platform),
        getDb().select({ name: businesses.location, value: sql<string>`count(*)` }).from(businesses)
          .where(sql`exists (select 1 from ${users} where ${users.businessId} = ${businesses.id})`).groupBy(businesses.location),
        taskQuery().orderBy(desc(agentTasks.createdAt)).limit(200),
        taskQuery().where(or(gte(agentTasks.createdAt, platformWeekStart(now)), gte(agentTasks.completedAt, platformWeekStart(now)), eq(agentTasks.status, "running")))
          .orderBy(desc(agentTasks.createdAt)).limit(10001),
      ]);
      const row = summaryRows[0];
      const categories = new Map<string, number>();
      for (const item of categoryRows) { const name = seafoodCategory(item.name); categories.set(name, (categories.get(name) ?? 0) + Number(item.value)); }
      return {
        merchants: Number(row.merchants), materials: Number(row.materials), interactions: Number(row.interactions),
        completed: Number(row.completed), failed: Number(row.failed), running: Number(row.running), queued: Number(row.queued), skipped: Number(row.skipped),
        averageDurationMs: row.averageDurationMs === null ? null : Number(row.averageDurationMs),
        categories: [...categories].map(([name, value]) => ({ name, value })),
        channels: channelRows.map(item => ({ name: item.name, value: Number(item.value) })),
        locations: locationRows.map(item => ({ name: item.name || "地区未填写", value: Number(item.value) })),
        recentTasks: recentRows.map(mapTask), trendTasks: trendRows.slice(0, 10000).map(mapTask), trendLimited: trendRows.length > 10000, updatedAt: now.toISOString(),
      };
    },
    async listKnowledge(publishedOnly = false) {
      await ready();
      return (await getDb().select().from(publicKnowledgeDocuments)
        .where(publishedOnly ? and(eq(publicKnowledgeDocuments.status, "published"), eq(publicKnowledgeDocuments.verified, true)) : undefined)
        .orderBy(desc(publicKnowledgeDocuments.updatedAt))).map(mapKnowledge);
    },
    async saveKnowledge(id, input, editorId) {
      await ready();
      const changes = { ...input, updatedBy: editorId, updatedAt: new Date() };
      const rows = id ? await getDb().update(publicKnowledgeDocuments).set(changes).where(eq(publicKnowledgeDocuments.id, id)).returning()
        : await getDb().insert(publicKnowledgeDocuments).values(changes).returning();
      return rows[0] ? mapKnowledge(rows[0]) : null;
    },
    async deleteKnowledge(id) {
      await ready();
      return (await getDb().delete(publicKnowledgeDocuments).where(eq(publicKnowledgeDocuments.id, id)).returning({ id: publicKnowledgeDocuments.id })).length > 0;
    },
  };
}
