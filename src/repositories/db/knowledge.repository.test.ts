/**
 * 知识库仓储 · 数据库集成测试（S5 · Task 79 第三十二节）
 *
 * 运行条件：`.env.local` 里配了 `DATABASE_URL`，且已执行 `pnpm db:migrate`。
 * 没有数据库时整组自动跳过，因此 `pnpm test` 在纯前端环境下依然全绿 ——
 * CI 不该因为缺少一个本地数据库而整体失败。
 *
 * 这组用例验证的是**只有真实 Postgres + pgvector 才能验证的东西**：
 * `vector(1024)` 列能不能写入、`<=>` 余弦距离算得对不对、
 * `ON DELETE CASCADE` 有没有真的把切片带走、事务回滚后切片数有没有复原。
 * Mock 实现里这些行为都是我们自己写的模拟 —— 它对了不代表数据库对了。
 *
 * ## 数据隔离
 *
 * 「当前商家」在仓储层是「最早创建的那条商家记录」（单商家 Demo 的约定）。
 * 因此只有**库中本来没有任何商家**时，本组才会创建自己的测试商家并执行写操作；
 * 库里已有业务数据时整体跳过，绝不去动别人的文档。
 */

import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import { closeDb, getDb } from "@/db";
import { businesses, knowledgeChunks, knowledgeDocuments, products } from "@/db/schema";
import { EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import { chunkDocument } from "@/rag/chunking";

import type { IndexedKnowledgeChunkInput } from "../types";
import {
  createDbKnowledgeChunkRepository,
  createDbKnowledgeDocumentRepository,
} from "./knowledge.repository";
import { createDbProductRepository } from "./product.repository";
import { describeDbSuite, prepareDbForTests } from "./db-integration";
import { findPrimaryBusinessIdOrNull } from "./shared";

const dbSuite = describeDbSuite;

const documents = createDbKnowledgeDocumentRepository();
const chunks = createDbKnowledgeChunkRepository();
const productRepository = createDbProductRepository();
const provider = createMockAIProvider();

const V1 = `储存说明

温度

鲜活鲍鱼请冷藏保存，最佳温度为 0-4℃，建议在 48 小时内食用。

时限

到货后请尽快冷藏，超过 48 小时不建议生食。`;

const V2 = `储存说明

温度

鲜活鲍鱼请冷藏保存，最佳温度为 2-6℃，建议在 24 小时内食用。

时限

到货后请尽快冷藏，超过 24 小时不建议生食。`;

/**
 * 检索用例专用正文，必须**全文唯一**。
 *
 * Mock Provider 的向量由文本确定性生成，因此「内容相同 ⇒ 向量相同 ⇒ 余弦并列第一」。
 * 早先这个用例复用了 `V1`，而前面已经索引过一份内容为 `V1` 的文档 ——
 * 两份文档的第 0 条切片得分完全一样，`hit[0]` 命中哪一份就没有确定答案。
 * 这不是排序实现的问题（旧版 `ORDER BY embedding <=> …` 同样并列），
 * 而是用例本身缺少可判别性。换一份独有正文即可，断言强度不变。
 */
const RETRIEVAL_DOC = `配送说明

时效

连江城区当日达，福建省内次日达，偏远地区走顺丰冷链 48 小时内送达。

运费

订单满 199 元包邮，未满收取 12 元冷链运费。

售后

签收后 24 小时内如有变质可按订单金额全额退款。`;

/** 切片 + 向量化，返回可直接交给仓储的候选切片 */async function buildChunks(content: string): Promise<IndexedKnowledgeChunkInput[]> {
  const pieces = chunkDocument(content);
  if (pieces.length === 0) {
    throw new Error("测试正文本应能切出至少一个切片");
  }
  const embeddings = await provider.embed({ values: pieces.map((piece) => piece.content) });
  return pieces.map((piece, index) => {
    const embedding = embeddings[index];
    if (!embedding) {
      throw new Error(`第 ${index} 个切片没有拿到向量`);
    }
    return {
      chunkIndex: piece.index,
      content: piece.content,
      section: piece.section,
      start: piece.start,
      end: piece.end,
      embedding,
    };
  });
}

/** 某商家当前的切片总数（直接查表，用于验证事务回滚） */
async function countChunksOfBusiness(businessId: string): Promise<number> {
  const rows = await getDb()
    .select({ total: count() })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.businessId, businessId));
  return Number(rows[0]?.total ?? 0);
}

dbSuite("知识库仓储（数据库集成测试）", () => {
  let businessId = "";
  let productId = "";
  /**
   * 只有「库中原本没有任何商家」时才由本组创建测试商家。
   * 为 true 时所有写操作都发生在自己的数据上；为 false 时用例整体跳过。
   */
  let ownsDatabase = false;

  beforeAll(async () => {
    await prepareDbForTests();
    const existing = await findPrimaryBusinessIdOrNull();
    if (existing) {
      ownsDatabase = false;
      return;
    }

    const insertedBusiness = await getDb()
      .insert(businesses)
      .values({
        name: "[集成测试] 知识库仓储",
        shortName: "知识集成测试",
        description: "由 pnpm test 自动创建，测试结束后级联删除",
        owner: "测试账号",
        location: "福建连江",
        mainCategory: "海产品",
        storeCount: 0,
        channels: ["douyin"],
      })
      .returning({ id: businesses.id });

    businessId = insertedBusiness[0]?.id ?? "";
    if (!businessId) {
      throw new Error("创建测试商家失败");
    }

    const insertedProduct = await getDb()
      .insert(products)
      .values({
        businessId,
        name: "[集成测试] 鲜活鲍鱼",
        category: "海产品",
        subCategory: "鲍鱼",
        price: 199,
        unit: "500g",
        stock: 10,
      })
      .returning({ id: products.id });

    productId = insertedProduct[0]?.id ?? "";
    ownsDatabase = Boolean(productId);
  });

  afterAll(async () => {
    if (ownsDatabase && businessId) {
      // 商品 / 知识文档 / 切片全部通过外键级联删除
      await getDb().delete(businesses).where(eq(businesses.id, businessId));
    }
    await closeDb();
  });

  it("建文档 + 全部切片：一次事务落盘，状态直接是 indexed", async (ctx) => {
    if (!ownsDatabase) {
      ctx.skip();
    }

    const candidate = await buildChunks(V1);
    const created = await documents.createIndexedDocument({
      businessId,
      name: "鲜活鲍鱼储存说明",
      type: "storage",
      source: "manual",
      summary: "冷藏温度与食用时限",
      content: V1,
      productId,
      chunks: candidate,
    });

    expect(created.indexStatus).toBe("indexed");
    expect(created.chunkCount).toBe(candidate.length);

    const stored = await chunks.listByDocument(created.id);
    expect(stored).toHaveLength(candidate.length);
    expect(stored.map((chunk) => chunk.chunkIndex)).toEqual(
      candidate.map((chunk) => chunk.chunkIndex),
    );
    // 元数据（含索引版本）真的进了 jsonb，而不是被丢掉
    expect(stored[0]?.metadata.documentName).toBe("鲜活鲍鱼储存说明");
    expect(stored[0]?.metadata.indexVersion).toBe("rag-v1");
    expect(stored[0]?.productId).toBe(productId);
  });

  it("向量检索命中刚写入的切片，且不跨商家泄漏", async (ctx) => {
    if (!ownsDatabase) {
      ctx.skip();
    }

    const candidate = await buildChunks(RETRIEVAL_DOC);
    const created = await documents.createIndexedDocument({
      businessId,
      name: "检索验证文档",
      type: "faq",
      source: "manual",
      content: RETRIEVAL_DOC,
      chunks: candidate,
    });

    // 用第 0 条切片自己的向量去查：余弦应为 1，且因为正文唯一，必然排第一
    const hit = await chunks.searchSimilar({
      businessId,
      queryEmbedding: candidate[0]!.embedding,
      limit: 5,
    });
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]?.similarity).toBeCloseTo(1, 5);
    expect(hit[0]?.chunk.documentId).toBe(created.id);

    // 换一个不存在的商家：一条都不该返回
    const foreign = await chunks.searchSimilar({
      businessId: crypto.randomUUID(),
      queryEmbedding: candidate[0]!.embedding,
      limit: 5,
    });
    expect(foreign).toHaveLength(0);
  });

  it("替换索引：旧切片消失，新切片就位，文档 id 不变", async (ctx) => {
    if (!ownsDatabase) {
      ctx.skip();
    }

    const v1 = await buildChunks(V1);
    const created = await documents.createIndexedDocument({
      businessId,
      name: "更新验证文档",
      type: "storage",
      source: "manual",
      content: V1,
      chunks: v1,
    });

    const v2 = await buildChunks(V2);
    const replaced = await documents.replaceDocumentIndex(
      created.id,
      { content: V2, summary: "已更新" },
      v2,
    );

    expect(replaced.id).toBe(created.id);
    expect(replaced.indexStatus).toBe("indexed");
    expect(replaced.content).toContain("2-6");
    expect(replaced.chunkCount).toBe(v2.length);

    const stored = await chunks.listByDocument(created.id);
    expect(stored).toHaveLength(v2.length);
    expect(stored.some((chunk) => chunk.content.includes("0-4"))).toBe(false);
    expect(stored.some((chunk) => chunk.content.includes("2-6"))).toBe(true);
  });

  it("重建索引不产生第二份文档，切片也不会累积", async (ctx) => {
    if (!ownsDatabase) {
      ctx.skip();
    }

    const candidate = await buildChunks(V1);
    const created = await documents.createIndexedDocument({
      businessId,
      name: "重建验证文档",
      type: "storage",
      source: "manual",
      content: V1,
      chunks: candidate,
    });

    await documents.replaceDocumentIndex(created.id, {}, await buildChunks(V1));
    const second = await documents.replaceDocumentIndex(created.id, {}, await buildChunks(V1));

    expect(second.id).toBe(created.id);
    expect(second.chunkCount).toBe(candidate.length);

    const all = await documents.findDocuments();
    expect(all.filter((document) => document.name === "重建验证文档")).toHaveLength(1);
    expect(await chunks.countByDocument(created.id)).toBe(candidate.length);
  });

  it("删除文档时切片被级联清除", async (ctx) => {
    if (!ownsDatabase) {
      ctx.skip();
    }

    const candidate = await buildChunks(V1);
    const created = await documents.createIndexedDocument({
      businessId,
      name: "删除验证文档",
      type: "storage",
      source: "manual",
      content: V1,
      chunks: candidate,
    });

    await documents.deleteDocument(created.id);

    expect(await documents.getDocumentById(created.id)).toBeNull();
    expect(await chunks.countByDocument(created.id)).toBe(0);
    expect(await chunks.listByDocument(created.id)).toHaveLength(0);
  });

  it("唯一键冲突时整笔事务回滚：不会留下悬空切片", async (ctx) => {
    if (!ownsDatabase) {
      ctx.skip();
    }

    const candidate = await buildChunks(V1);
    await documents.createIndexedDocument({
      businessId,
      name: "唯一键验证文档",
      type: "faq",
      source: "manual",
      content: V1,
      chunks: candidate,
    });

    const before = await countChunksOfBusiness(businessId);

    // 同名再建一次：文档插入就会撞唯一索引，切片必须一起回滚
    await expect(
      documents.createIndexedDocument({
        businessId,
        name: "唯一键验证文档",
        type: "faq",
        source: "manual",
        content: V2,
        chunks: await buildChunks(V2),
      }),
    ).rejects.toMatchObject({ code: "DB_ERROR" });

    expect(await countChunksOfBusiness(businessId)).toBe(before);
    const stored = await getDb()
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.name, "唯一键验证文档"));
    expect(stored).toHaveLength(1);
  });

  it("空切片与维度不合法的向量在写库之前就被拒绝", async (ctx) => {
    if (!ownsDatabase) {
      ctx.skip();
    }

    const before = await countChunksOfBusiness(businessId);

    await expect(
      documents.createIndexedDocument({
        businessId,
        name: "空切片文档",
        type: "faq",
        source: "manual",
        content: V1,
        chunks: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await expect(
      documents.createIndexedDocument({
        businessId,
        name: "维度错误文档",
        type: "faq",
        source: "manual",
        content: V1,
        chunks: [
          {
            chunkIndex: 0,
            content: "这一段内容的向量维度是错的。",
            section: "",
            start: 0,
            end: 14,
            embedding: new Array(768).fill(0.1),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(await countChunksOfBusiness(businessId)).toBe(before);
    expect(
      await getDb()
        .select({ id: knowledgeDocuments.id })
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.businessId, businessId)),
    ).not.toHaveLength(0);
  });

  it("商品归属判断按 business_id 过滤", async (ctx) => {
    if (!ownsDatabase) {
      ctx.skip();
    }

    expect(await productRepository.belongsToBusiness(businessId, productId)).toBe(true);
    expect(await productRepository.belongsToBusiness(businessId, crypto.randomUUID())).toBe(false);
    expect(await productRepository.belongsToBusiness(crypto.randomUUID(), productId)).toBe(false);
    // 非 uuid 的入参不能表现成数据库故障
    expect(await productRepository.belongsToBusiness("not-a-uuid", productId)).toBe(false);
  });

  it("写入的向量长度为 1024（与列定义一致）", async (ctx) => {
    if (!ownsDatabase) {
      ctx.skip();
    }

    const candidate = await buildChunks(V1);
    const created = await documents.createIndexedDocument({
      businessId,
      name: "维度验证文档",
      type: "faq",
      source: "manual",
      content: V1,
      chunks: candidate,
    });

    const rows = await getDb()
      .select({ embedding: knowledgeChunks.embedding })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, created.id));
    // 数据库读回来的是 pgvector 的字面量字符串；只断言维度，不依赖具体格式
    for (const row of rows) {
      expect(String(row.embedding).split(",").length).toBe(EMBEDDING_DIMENSIONS);
    }
  });
});
