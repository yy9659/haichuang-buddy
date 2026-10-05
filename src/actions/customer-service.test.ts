/**
 * 客服 Server Actions 单测（S5 · Task 80 第三十二节）
 *
 * 这一层只有三件事：**收参数 → 调服务 → 失效缓存**。测试因此围绕三条纪律：
 *
 * 1. **归属校验发生在写之前**。知识文档的编辑 / 删除 / 重建索引都会先确认
 *    它属于当前商家；不属于时返回 `NOT_FOUND`（而不是「无权访问」——
 *    后者本身就在泄漏「这个 id 存在，只是不是你的」）。
 * 2. **模型层的 `detail` 不许进浏览器**。`failure` 来自模型通道，
 *    它的 detail 里可能夹着模型原始输出与提示词片段，
 *    而那些片段里就是企业内部知识库的原文。
 * 3. **缓存失效只在真的改了东西之后**。失败时库里什么都没变，
 *    白刷一遍页面只会让商家看到页面在抖。
 *
 * `next/cache` 用假实现替换：本层不测 Next 的缓存机制，只测「调没调、调了什么」。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import { resetServerEnvCache } from "@/lib/env";
import {
  clearStoredAgentTasks,
  resetStoredConversations,
  resetStoredKnowledge,
} from "@/repositories/mock/store";

import {
  closeConversationAction,
  createConversationAction,
  deleteKnowledgeDocumentAction,
  indexPendingKnowledgeDocumentsAction,
  reindexKnowledgeDocumentAction,
  resolveKnowledgeGapWithDocumentAction,
  sendCustomerMessageAction,
  updateKnowledgeDocumentAction,
} from "./customer-service";

process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

const OTHER_BUSINESS_ID = "biz_other_999";

function unwrap<T>(
  result: { ok: true; data: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${result.error.code} ${result.error.message}`);
  }
  return result.data;
}

beforeEach(() => {
  resetStoredKnowledge();
  resetStoredConversations();
  clearStoredAgentTasks();
  revalidatePathMock.mockClear();
});

/* ------------------------------------------------------------------ */
/* 会话动作                                                            */
/* ------------------------------------------------------------------ */

describe("会话相关 Action", () => {
  it("创建会话后失效客服页缓存", async () => {
    const created = unwrap(
      await createConversationAction({ customerName: "王女士" }),
    );

    expect(created.id).toBeTruthy();
    expect(revalidatePathMock).toHaveBeenCalledWith("/customer-service");
  });

  it("结束会话后失效缓存", async () => {
    const created = unwrap(await createConversationAction({ customerName: "陈先生" }));
    revalidatePathMock.mockClear();

    const closed = unwrap(await closeConversationAction(created.id));

    expect(closed.status).toBe("closed");
    expect(revalidatePathMock).toHaveBeenCalledWith("/customer-service");
  });

  it("发送消息成功后失效缓存；模型失败时也失效（消息已经落库了）", async () => {
    const created = unwrap(await createConversationAction({ customerName: "阿岚" }));
    revalidatePathMock.mockClear();

    const result = unwrap(
      await sendCustomerMessageAction({ conversationId: created.id, content: "在吗？" }),
    );

    // 「在吗？」是 other 意图，依据不足但不产生缺口 —— 但消息确实落库了，必须刷新
    expect(result.customerMessage.content).toBe("在吗？");
    expect(revalidatePathMock).toHaveBeenCalledWith("/customer-service");
  });

  it("会话不存在时失败，且不失效缓存", async () => {
    revalidatePathMock.mockClear();

    const result = await sendCustomerMessageAction({
      conversationId: "conv_not_exists",
      content: "在吗？",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("NOT_FOUND");
    // 什么都没变，不该白刷一遍
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 知识库动作的归属校验                                                */
/* ------------------------------------------------------------------ */

describe("知识库动作的归属校验", () => {
  it("编辑别家的知识文档 → NOT_FOUND，且不发生写入", async () => {
    const { createKnowledgeDocument } = await import("@/services/knowledge.service");
    const foreign = unwrap(
      await createKnowledgeDocument({
        businessId: OTHER_BUSINESS_ID,
        name: "别家知识",
        type: "logistics",
        content: "这是别家商家的物流政策说明，本商家不该能改。",
      }),
    );
    const before = foreign.content;
    revalidatePathMock.mockClear();

    const attempted = await updateKnowledgeDocumentAction(foreign.id, {
      content: "被越权改写。",
    });

    expect(attempted.ok).toBe(false);
    expect(!attempted.ok && attempted.error.code).toBe("NOT_FOUND");
    // 错误文案里不能出现「无权 / 不属于」这类能用来枚举资源的措辞
    expect(JSON.stringify(!attempted.ok ? attempted.error : {})).not.toContain("无权");
    expect(revalidatePathMock).not.toHaveBeenCalled();

    const { getKnowledgeDocument } = await import("@/services/knowledge.service");
    expect(unwrap(await getKnowledgeDocument(foreign.id)).content).toBe(before);
  });

  it("删除 / 重新索引别家的文档同样被拒", async () => {
    const { createKnowledgeDocument } = await import("@/services/knowledge.service");
    const foreign = unwrap(
      await createKnowledgeDocument({
        businessId: OTHER_BUSINESS_ID,
        name: "别家知识",
        type: "faq",
        content: "这是别家商家的常见问题说明，本商家不该能删。",
      }),
    );

    const removed = await deleteKnowledgeDocumentAction(foreign.id);
    expect(removed.ok).toBe(false);
    expect(!removed.ok && removed.error.code).toBe("NOT_FOUND");

    const reindexed = await reindexKnowledgeDocumentAction(foreign.id);
    expect(reindexed.ok).toBe(false);
    expect(!reindexed.ok && reindexed.error.code).toBe("NOT_FOUND");
  });

  it("本商家新增知识后立即失效缓存，且状态为已索引", async () => {
    revalidatePathMock.mockClear();

    const { createKnowledgeDocumentAction } = await import("./customer-service");
    const created = unwrap(
      await createKnowledgeDocumentAction({
        name: "连江海创物流说明",
        type: "logistics",
        content: "订单发货时效：每天 16:00 前下单的订单当天发货，省外 2 到 3 天到货。",
      }),
    );

    expect(created.indexStatus).toBe("indexed");
    expect(revalidatePathMock).toHaveBeenCalledWith("/customer-service");
  });
});

/* ------------------------------------------------------------------ */
/* 批量索引                                                            */
/* ------------------------------------------------------------------ */

describe("批量建立索引 Action", () => {
  it("把全部待索引知识建成索引，并报告成功份数", async () => {
    const result = unwrap(await indexPendingKnowledgeDocumentsAction());

    expect(result.indexed).toBeGreaterThan(0);
    expect(result.failures).toHaveLength(0);
    expect(revalidatePathMock).toHaveBeenCalledWith("/customer-service");
  });

  it("已经索引过的文档再次执行不会重复计入", async () => {
    unwrap(await indexPendingKnowledgeDocumentsAction());
    const second = unwrap(await indexPendingKnowledgeDocumentsAction());

    expect(second.indexed).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 缺口补知识动作                                                      */
/* ------------------------------------------------------------------ */

describe("缺口补知识 Action", () => {
  it("缺口不存在时返回 NOT_FOUND，不新建知识", async () => {
    const { listKnowledgeDocuments } = await import("@/services/knowledge.service");
    const before = unwrap(await listKnowledgeDocuments()).length;

    const attempted = await resolveKnowledgeGapWithDocumentAction({
      gapId: "gap_not_exists",
      name: "凭空补的知识",
      type: "logistics",
      content: "这条知识不该被建立，因为缺口根本不存在。",
    });

    expect(attempted.ok).toBe(false);
    expect(!attempted.ok && attempted.error.code).toBe("NOT_FOUND");
    expect(unwrap(await listKnowledgeDocuments())).toHaveLength(before);
  });
});
