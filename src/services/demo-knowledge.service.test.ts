/**
 * Demo Knowledge Bootstrap 测试（Task 81 §17–19、§28）
 *
 * 覆盖三条不变量：
 * 1. 首次：种子文档当前是 pending，bootstrap 后必须 indexed 且有切片
 * 2. 幂等：第二次调用不重新 Embedding（rebuilt=0）
 * 3. DB 模式：不执行任何 bootstrap（real result should be no-op, missing=0, rebuilt=0）

 * 同时验证「DB 模式一票否决」（§23）：mock store 进 datasource=mock，bootstrap
 * 跑完后切到 db，ensureDemoKnowledgeIndexed 必须立刻返回不写数据。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvCache } from "@/lib/env";
import { MOCK_BUSINESS, MOCK_KNOWLEDGE_DOCUMENTS } from "@/lib/mock";
import {
  listStoredKnowledgeChunks,
  resetStoredKnowledge,
} from "@/repositories/mock/store";

import {
  ensureDemoKnowledgeIndexed,
} from "./demo-knowledge.service";

process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!("ok" in result) || !result.ok) {
    throw new Error(`result not ok: ${JSON.stringify(result)}`);
  }
  return result.data;
}

describe("Demo Knowledge Bootstrap（Task 81 §17–19）", () => {
  beforeEach(() => {
    resetStoredKnowledge();
  });

  it("首次调用：对每一份种子文档建立索引（rebuilt > 0，至少 1 条切片）", async () => {
    const summary = unwrap(await ensureDemoKnowledgeIndexed());

    expect(summary.checked).toBe(MOCK_KNOWLEDGE_DOCUMENTS.length);
    expect(summary.missing).toBe(0);
    expect(summary.rebuilt).toBeGreaterThan(0);

    const firstChunkCount = (await listStoredKnowledgeChunks()).length;
    expect(firstChunkCount).toBeGreaterThan(0);
  });

  it("第二次调用：完全幂等，零重新 Embedding", async () => {
    const first = unwrap(await ensureDemoKnowledgeIndexed());
    const firstRebuilt = first.rebuilt;

    const second = unwrap(await ensureDemoKnowledgeIndexed());

    expect(second.checked).toBe(MOCK_KNOWLEDGE_DOCUMENTS.length);
    expect(second.rebuilt).toBe(0);
    /** availableChunks 印证「第二次没新增 / 没改变 */
    expect((await listStoredKnowledgeChunks()).length).toBeGreaterThan(0);
    expect(firstRebuilt).toBeGreaterThan(0);
  });

  it("种子被删除后 missing=N —— 不复活已删除的种子", async () => {
    // 删一份
    const deleted = MOCK_KNOWLEDGE_DOCUMENTS[0];
    const repositories = (
      await import("@/repositories")
    ).getRepositories();
    const document = await repositories.knowledgeDocuments.findDocumentByKey({
      businessId: MOCK_BUSINESS.id,
      type: deleted.type,
      name: deleted.name,
    });
    if (!document) {
      throw new Error("种子文档未找到");
    }
    await repositories.knowledgeDocuments.deleteDocument(document.id);

    const summary = unwrap(await ensureDemoKnowledgeIndexed());

    expect(summary.missing).toBe(1);
    expect(summary.checked).toBe(MOCK_KNOWLEDGE_DOCUMENTS.length - 1);
  });

  it("DB 模式下不执行任何 bootstrap", async () => {
    process.env.DATA_SOURCE = "db";
    resetServerEnvCache();

    try {
      const summary = unwrap(await ensureDemoKnowledgeIndexed());

      expect(summary.checked).toBe(0);
      expect(summary.rebuilt).toBe(0);
      expect(summary.missing).toBe(0);
    } finally {
      // 还原
      process.env.DATA_SOURCE = "mock";
      resetServerEnvCache();
    }
  });
});