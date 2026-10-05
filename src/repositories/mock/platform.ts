import { MOCK_BUSINESS } from "@/lib/mock";
import { PUBLIC_KNOWLEDGE_SEEDS } from "@/lib/public-knowledge-seeds";
import { platformWeekStart, redactTaskError, seafoodCategory } from "@/lib/admin";
import type { PlatformRepository, PlatformTask, PublicKnowledgeDocument } from "@/types/admin";
import { listStoredAgentTasks, listStoredContents, listStoredConversations, listStoredCustomerMessages, listStoredLiveComments, listStoredLiveSessions, listStoredProducts, listStoredUsers } from "./store";

const documents: PublicKnowledgeDocument[] = structuredClone(PUBLIC_KNOWLEDGE_SEEDS);
export function createMockPlatformRepository(): PlatformRepository {
  return {
    async snapshot(now) {
      const tasks: PlatformTask[] = listStoredAgentTasks().map(row => ({ id: row.id, title: row.title, agentType: row.agentType, status: row.status,
        createdAt: new Date(row.createdAt).toISOString(), completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
        durationMs: row.durationMs, errorSummary: redactTaskError(row.errorMessage), businessName: MOCK_BUSINESS.name,
        providerId: typeof row.output?.providerId === "string" ? row.output.providerId : null }));
      const categories = new Map<string, number>(), channels = new Map<string, number>();
      for (const row of listStoredProducts()) { const name = seafoodCategory(row.name); categories.set(name, (categories.get(name) ?? 0) + 1); }
      for (const row of listStoredContents()) channels.set(row.platform, (channels.get(row.platform) ?? 0) + 1);
      const ended = tasks.filter(row => ["completed", "failed"].includes(row.status) && row.durationMs !== null);
      return { merchants: new Set(listStoredUsers().map(user => user.businessId)).size, materials: listStoredContents().length,
        interactions: listStoredConversations().reduce((sum, conversation) => sum + listStoredCustomerMessages(conversation.id).filter(message => message.role === "customer").length, 0)
          + listStoredLiveSessions().reduce((sum, session) => sum + listStoredLiveComments(session.id).length, 0),
        completed: tasks.filter(row => row.status === "completed").length, failed: tasks.filter(row => row.status === "failed").length,
        running: tasks.filter(row => row.status === "running").length, queued: tasks.filter(row => row.status === "queued").length, skipped: tasks.filter(row => row.status === "skipped").length,
        averageDurationMs: ended.length ? ended.reduce((sum, row) => sum + row.durationMs!, 0) / ended.length : null,
        categories: [...categories].map(([name, value]) => ({ name, value })), channels: [...channels].map(([name, value]) => ({ name, value })),
        locations: listStoredUsers().length ? [{ name: MOCK_BUSINESS.location, value: 1 }] : [], recentTasks: tasks.slice(0, 200),
        trendTasks: tasks.filter(row => new Date(row.createdAt) >= platformWeekStart(now) || row.status === "running" || (row.completedAt && new Date(row.completedAt) >= platformWeekStart(now))),
        trendLimited: false, updatedAt: now.toISOString() };
    },
    async listKnowledge(publishedOnly = false) { return structuredClone(documents.filter(row => !publishedOnly || (row.status === "published" && row.verified))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
    async saveKnowledge(id, input, editorId) {
      const index = id ? documents.findIndex(row => row.id === id) : -1;
      if (id && index < 0) return null;
      const row = { ...input, id: id ?? crypto.randomUUID(), createdAt: index >= 0 ? documents[index].createdAt : new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: editorId };
      if (index >= 0) documents[index] = row; else documents.unshift(row);
      return structuredClone(row);
    },
    async deleteKnowledge(id) { const index = documents.findIndex(row => row.id === id); if (index < 0) return false; documents.splice(index, 1); return true; },
  };
}
