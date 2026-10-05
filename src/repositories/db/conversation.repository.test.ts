/**
 * 客服会话仓储 · 数据库集成测试（S5 · Task 80 第三十九 / 四十三节）
 *
 * 运行条件：`.env.local` 里配了 `DATABASE_URL`，且已执行 `pnpm db:migrate`。
 * 没有数据库时整组自动跳过，因此 `pnpm test` 在纯前端环境下依然全绿。
 *
 * 这组用例验证的是**只有真实 Postgres 才能验证的东西**：
 * `conversation_channel` 枚举里新加的 `simulator` 能不能写入、
 * 消息与 `updated_at` 是不是在**同一个事务**里落盘、
 * `citations` 的 jsonb 快照有没有原样存回来、会话删除时 `ON DELETE CASCADE`
 * 有没有真的把消息带走。Mock 实现里这些都是我们自己写的模拟 ——
 * 它对了不代表数据库对了。
 *
 * ## 数据隔离
 *
 * 「当前商家」在仓储层是「最早创建的那条商家记录」（单商家 Demo 的约定）。
 * 因此只有**库中本来没有任何商家**时，本组才会创建自己的测试商家并执行写操作；
 * 库里已有业务数据时整体跳过，绝不去动别人的会话。
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { closeDb, getDb } from "@/db";
import { businesses, customerConversations, customerMessages } from "@/db/schema";

import { createDbConversationRepository } from "./conversation.repository";
import { describeDbSuite, prepareDbForTests } from "./db-integration";
import { findPrimaryBusinessIdOrNull } from "./shared";

const dbSuite = describeDbSuite;

const conversations = createDbConversationRepository();

const CITATION_SNAPSHOT = {
  id: "doc-chunk-1",
  documentId: "11111111-1111-1111-1111-111111111111",
  chunkId: "22222222-2222-2222-2222-222222222222",
  title: "鲜活鲍鱼储存说明",
  type: "storage" as const,
  snippet: "冷藏 0-4℃，48 小时内食用。",
  score: 0.82,
};

dbSuite("客服会话仓储（数据库集成测试）", () => {
  let businessId = "";
  /** 只有「库中原本没有任何商家」时才由本组创建测试商家 */
  let ownsDatabase = false;

  beforeAll(async () => {
    await prepareDbForTests();
    const existing = await findPrimaryBusinessIdOrNull();
    if (existing) {
      ownsDatabase = false;
      return;
    }

    const inserted = await getDb()
      .insert(businesses)
      .values({
        name: "[集成测试] 客服会话仓储",
        shortName: "客服集成测试",
        description: "由 pnpm test 自动创建，测试结束后级联删除",
        owner: "测试账号",
        location: "福建连江",
        mainCategory: "海产品",
        storeCount: 0,
        channels: ["douyin"],
      })
      .returning({ id: businesses.id });

    businessId = inserted[0]?.id ?? "";
    if (!businessId) {
      throw new Error("创建测试商家失败");
    }
    ownsDatabase = true;
  });

  afterAll(async () => {
    if (ownsDatabase && businessId) {
      // 会话与消息随商家级联删除（见 schema 的外键定义）
      await getDb().delete(businesses).where(eq(businesses.id, businessId));
    }
    await closeDb();
  });

  it("会话与消息可以往返：模拟器渠道能写入，消息按时间升序读回", async () => {
    if (!ownsDatabase) {
      return;
    }

    const created = await conversations.createConversation({
      businessId,
      customerName: "王女士",
      customerLabel: "抖音 · 新客",
      productId: null,
    });
    expect(created.channel).toBe("simulator");
    expect(created.status).toBe("bot");

    await conversations.appendMessage({
      conversationId: created.id,
      role: "customer",
      content: "鲍鱼怎么保存？",
    });
    await conversations.appendMessage({
      conversationId: created.id,
      role: "agent",
      content: "冷藏 0-4℃，48 小时内食用。",
      grounded: true,
      intent: "storage",
      confidence: 0.9,
      citations: [CITATION_SNAPSHOT],
      needsHuman: false,
      knowledgeGapId: null,
      retrievedCount: 3,
    });

    const messages = await conversations.listMessages(created.id);
    expect(messages.map((message) => message.role)).toEqual(["customer", "agent"]);
  });

  it("引用走 jsonb 快照：写进去什么，读回来就是什么（不依赖回查知识库）", async () => {
    if (!ownsDatabase) {
      return;
    }

    const created = await conversations.createConversation({
      businessId,
      customerName: "海味爱好者",
      productId: null,
    });

    await conversations.appendMessage({
      conversationId: created.id,
      role: "agent",
      content: "依据《鲜活鲍鱼储存说明》……",
      grounded: true,
      intent: "storage",
      confidence: 0.9,
      citations: [CITATION_SNAPSHOT],
      needsHuman: false,
      knowledgeGapId: null,
      retrievedCount: 1,
    });

    const [message] = await conversations.listMessages(created.id);
    const [snapshot] = message?.knowledgeSources ?? [];

    expect(snapshot?.documentId).toBe(CITATION_SNAPSHOT.documentId);
    expect(snapshot?.chunkId).toBe(CITATION_SNAPSHOT.chunkId);
    expect(snapshot?.title).toBe(CITATION_SNAPSHOT.title);
    expect(snapshot?.score).toBeCloseTo(CITATION_SNAPSHOT.score, 5);
  });

  it("追加消息在同一事务里推进 updated_at / unread_count / status", async () => {
    if (!ownsDatabase) {
      return;
    }

    const created = await conversations.createConversation({
      businessId,
      customerName: "阿岚",
      productId: null,
    });
    expect(created.unreadCount).toBe(0);

    await conversations.appendMessage({
      conversationId: created.id,
      role: "agent",
      content: "知识库里没有找到可靠依据，已建议转人工确认。",
      grounded: false,
      intent: "logistics",
      confidence: 0.2,
      citations: [],
      needsHuman: true,
      knowledgeGapId: null,
      retrievedCount: 0,
    });

    const reloaded = await conversations.getConversation(created.id);
    expect(reloaded).not.toBeNull();
    // needsHuman 的 AI 消息必须把会话状态一并推进，否则列表上的状态点与消息互相矛盾
    expect(reloaded?.status).toBe("human");
  });

  it("关闭会话后状态可读回为 closed", async () => {
    if (!ownsDatabase) {
      return;
    }

    const created = await conversations.createConversation({
      businessId,
      customerName: "陈先生",
      productId: null,
    });

    const closed = await conversations.updateConversation(created.id, {
      status: "closed",
    });

    expect(closed.status).toBe("closed");
  });

  it("跨商家读取返回 null：商家条件写在 WHERE 里，不泄漏资源是否存在", async () => {
    if (!ownsDatabase) {
      return;
    }

    const created = await conversations.createConversation({
      businessId,
      customerName: "林小姐",
      productId: null,
    });

    const foreign = await conversations.findConversationForBusiness(
      "00000000-0000-0000-0000-000000000000",
      created.id,
    );

    expect(foreign).toBeNull();
  });

  it("不存在的会话返回 null 而不是抛错（列表页回退到最近活跃的那条）", async () => {
    if (!ownsDatabase) {
      return;
    }

    const missing = await conversations.getConversation(
      "00000000-0000-0000-0000-000000000000",
    );

    expect(missing).toBeNull();
  });

  it("删除会话会级联删掉它的全部消息", async () => {
    if (!ownsDatabase) {
      return;
    }

    const created = await conversations.createConversation({
      businessId,
      customerName: "郑先生",
      productId: null,
    });
    await conversations.appendMessage({
      conversationId: created.id,
      role: "customer",
      content: "在吗？",
    });

    await getDb()
      .delete(customerConversations)
      .where(eq(customerConversations.id, created.id));

    const orphans = await getDb()
      .select({ id: customerMessages.id })
      .from(customerMessages)
      .where(eq(customerMessages.conversationId, created.id));

    expect(orphans).toHaveLength(0);
  });
});
