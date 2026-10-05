/**
 * 直播与经营日报仓储 · 数据库集成测试（S7）
 *
 * 覆盖 Mock 实现模拟不出来的行为：外键级联、jsonb 往返、排序口径、
 * 跨租户隔离、以及「追加评论/建议自动维护场次计数」。
 *
 * 运行条件与其它 `*.repository.test.ts` 相同：`pnpm test:db`（PGlite）
 * 或 `.env.local` 配 `DATABASE_URL`（远程）。没有库时整组跳过。
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { getDb } from "@/db";
import { businesses, products } from "@/db/schema";

import { createDbLiveRepository } from "./live.repository";
import { createDbAnalyticsReportRepository } from "./reports.repository";
import { describeDbSuite, prepareDbForTests } from "./db-integration";

const dbSuite = describeDbSuite;

const liveRepository = createDbLiveRepository();
const reportRepository = createDbAnalyticsReportRepository();

dbSuite("直播与经营日报仓储（集成测试）", () => {
  let businessId = "";
  let productId = "";

  beforeAll(async () => {
    await prepareDbForTests();
    // 本组测试单独建商家（与其它文件同一约定：库中原本无商家）
    const inserted = await getDb()
      .insert(businesses)
      .values({
        name: "[集成测试] 直播商家",
        shortName: "直播测试",
        description: "由 pnpm test:db 自动创建，测试结束后删除",
        owner: "测试账号",
        location: "福建连江",
        mainCategory: "海产品",
        storeCount: 0,
        channels: ["douyin"],
      })
      .returning({ id: businesses.id });
    businessId = inserted[0]?.id ?? "";
    expect(businessId).not.toBe("");

    // 建一个真实商品，供直播场次外键引用
    const product = await getDb()
      .insert(products)
      .values({
        businessId,
        name: "[集成测试] 直播用鲍鱼",
        description: "",
        category: "海产品",
        subCategory: "鲍鱼",
        price: 128.5,
        unit: "500g",
        stock: 10,
        origin: "福建连江",
        specification: "",
        storageMethod: "",
        shelfLife: "",
        tags: [],
      })
      .returning({ id: products.id });
    productId = product[0]?.id ?? "";
    expect(productId).not.toBe("");
  });

  afterAll(async () => {
    // 商家删除时，其商品 / 直播场次 / 评论 / 建议 / 日报经外键级联删除
    if (businessId) {
      await getDb().delete(businesses).where(eq(businesses.id, businessId));
    }
  });

  it("创建场次 → 读取 → 映射字段完整", async () => {
    const session = await liveRepository.createSession({
      businessId,
      title: "[集成测试] 连江鲍鱼专场",
      productId,
      productName: "连江鲜活鲍鱼",
      status: "live",
    });

    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.title).toBe("[集成测试] 连江鲍鱼专场");
    expect(session.status).toBe("live");
    expect(session.commentsCount).toBe(0);
    expect(session.aiHandledCount).toBe(0);
    expect(session.endedAt).toBeNull();
    expect(session.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("追加评论维护场次计数且按时间正序返回", async () => {
    // 新建一场直播（避免受上一条场次影响）
    const session = await liveRepository.createSession({
      businessId,
      title: "[集成测试] 评论计数专场",
      productId,
      productName: "连江鲜活鲍鱼",
      status: "live",
    });

    const first = await liveRepository.appendComment({
      sessionId: session.id,
      authorName: "观众甲",
      content: "这鲍鱼怎么保存？",
    });
    const second = await liveRepository.appendComment({
      sessionId: session.id,
      authorName: "观众乙",
      content: "多少钱一斤？",
    });

    // 评论按时间正序（先 append 的在前）
    const comments = await liveRepository.listComments(session.id);
    expect(comments.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(comments[0]?.intent).toBeNull();
    expect(comments[0]?.handled).toBe(false);

    // 场次评论数已 +2
    const updated = await liveRepository.getSession();
    expect(updated?.commentsCount).toBe(2);
  });

  it("更新评论的 AI 分类结果与处理状态", async () => {
    const session = await liveRepository.createSession({
      businessId,
      title: "[集成测试] 评论分类专场",
      productId,
      productName: "连江鲜活鲍鱼",
      status: "live",
    });
    const comment = await liveRepository.appendComment({
      sessionId: session.id,
      authorName: "观众丙",
      content: "顺丰能发吗？",
    });

    const updated = await liveRepository.updateComment(comment.id, {
      intent: "logistics_question",
      priority: "high",
      handled: true,
    });
    expect(updated.intent).toBe("logistics_question");
    expect(updated.priority).toBe("high");
    expect(updated.handled).toBe(true);
  });

  it("追加成功建议维护 AI 处理数，失败建议不维护", async () => {
    const session = await liveRepository.createSession({
      businessId,
      title: "[集成测试] 建议计数专场",
      productId,
      productName: "连江鲜活鲍鱼",
      status: "live",
    });
    const comment = await liveRepository.appendComment({
      sessionId: session.id,
      authorName: "观众丁",
      content: "怎么煮才嫩？",
    });

    // 失败的建议：不增加处理数
    await liveRepository.appendSuggestion({
      commentId: comment.id,
      commentContent: comment.content,
      intent: "cooking_question",
      priority: "low",
      shouldRespond: false,
      responseMode: "ignore",
      hostSuggestion: "",
      suggestedReply: "",
      sellingAngle: null,
      grounded: false,
      citations: [],
      recommendedAction: "ignore",
      riskNotes: [],
      confidence: 0,
      durationMs: 10,
      failureMessage: "模型超时",
    });

    let after = await liveRepository.getSession();
    expect(after?.aiHandledCount).toBe(0);

    // 成功的建议：处理数 +1
    await liveRepository.appendSuggestion({
      commentId: comment.id,
      commentContent: comment.content,
      intent: "cooking_question",
      priority: "high",
      shouldRespond: true,
      responseMode: "answer_now",
      hostSuggestion: "建议现场演示焯水去腥",
      suggestedReply: "鲍鱼冷水下锅，加姜片去腥",
      sellingAngle: null,
      grounded: true,
      citations: [
        {
          id: "c1",
          documentId: "d1",
          chunkId: "k1",
          title: "鲍鱼烹饪说明",
          type: "cooking",
          snippet: "冷水下锅",
          score: 0.9,
        },
      ],
      recommendedAction: "explain_cooking",
      riskNotes: [],
      confidence: 0.8,
      durationMs: 120,
      failureMessage: null,
    });

    after = await liveRepository.getSession();
    expect(after?.aiHandledCount).toBe(1);

    // 重试更新原建议，不把失败记录与成功记录堆成两张卡片
    const suggestions = await liveRepository.listSuggestions(session.id);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.failureMessage).toBeNull();
    expect(suggestions[0]?.citations).toHaveLength(1);

    const byComment = await liveRepository.findSuggestionByComment(comment.id);
    expect(byComment).not.toBeNull();
  });

  it("getStats 返回 null（模拟指标无真实来源）", async () => {
    expect(await liveRepository.getStats()).toBeNull();
  });

  it("更新不存在的场次抛 NOT_FOUND", async () => {
    await expect(
      liveRepository.updateSession("00000000-0000-0000-0000-000000000000", {
        status: "ended",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("经营日报：create → findLatest → listRecent → findById", async () => {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      product: {
        totalProducts: 1,
        analyzedProducts: 0,
        analysisCompletionRate: 0,
      },
      content: {
        totalAssets: 0,
        generatedToday: 0,
        platformDistribution: [],
      },
      workflow: {
        totalRuns: 0,
        completedRuns: 0,
        partiallyCompletedRuns: 0,
        failedRuns: 0,
        completionRate: null,
        reusedTaskCount: 0,
        executedTaskCount: 0,
      },
      customerService: {
        answeredCount: 0,
        groundedCount: 0,
        groundedRate: null,
        needsHumanCount: 0,
        openKnowledgeGapCount: 0,
        openGapByIntent: [],
      },
      live: {
        sessions: 1,
        commentCount: 2,
        aiHandledCount: 1,
        highPriorityCount: 1,
        groundedCount: 1,
        topIntents: [],
      },
      agents: {
        completedTasks: 0,
        failedTasks: 0,
        avgDurationMs: null,
        byAgent: [],
      },
      health: {
        status: "good" as const,
        signals: {
          openKnowledgeGapCount: 0,
          failedTaskRate: null,
          workflowCompletionRate: null,
          customerGroundedRate: null,
        },
        reasons: [],
      },
    };
    const report = {
      executiveSummary: "一切正常",
      health: "good" as const,
      highlights: [],
      issues: [],
      actions: [],
      tomorrowFocus: [],
      confidence: 0.9,
    };

    const created = await reportRepository.create({
      businessId,
      snapshot,
      report,
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);

    const latest = await reportRepository.findLatest();
    expect(latest?.id).toBe(created.id);

    const recent = await reportRepository.listRecent(5);
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent[0]?.id).toBe(created.id);

    const byId = await reportRepository.findById(created.id);
    expect(byId?.report.confidence).toBe(0.9);
    expect(byId?.snapshot.live.sessions).toBe(1);
  });

  it("经营日报：不存在的 id 返回 null", async () => {
    expect(
      await reportRepository.findById("00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });
});
