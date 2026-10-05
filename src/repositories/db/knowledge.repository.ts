/**
 * 知识库仓储 · 数据库实现（S5）
 *
 * 三条与 Mock 实现必须完全一致、而且这里更容易写歪的语义：
 *
 * 1. **索引替换必须是原子的**，由 `createIndexedDocument` / `replaceDocumentIndex`
 *    在**单个事务**里完成。不要拆成「先 `deleteChunksByDocument` 再 `createChunks`」：
 *    那样一旦中间失败，文档会从「检索得到」变成「检索不到」，
 *    而调用方只看到一句「更新失败」。
 *
 *    同时记住：**向量必须在进事务之前全部算好**。把「等 embedding 返回」包进事务，
 *    几秒的等待会一直占着连接与行锁，并发索引请求互相排队甚至死锁。
 *
 * 2. **检索必须带商家过滤**。`business_id` 条件写在 `searchSimilar` 的 SQL 里，
 *    而不是靠调用方自觉。Demo 只有一个商家，这个条件永远为真，
 *    但它必须在 —— 多商家上线那天，这里就是唯一可能的泄漏点，而且不会报错。
 *
 * 3. **切片的归属字段由文档推导**（见 `toChunkRows`），不由调用方传入。
 *    这几个字段一旦与文档不一致，检索会命中别家或别的商品的知识，且不会报错。
 *
 * ## 向量相似度为什么在应用层算
 *
 * 迁移顶部说明了原因：pgvector 是个需要预编译扩展的依赖，而本项目要走
 * 「本地 PGlite / 部署 Supabase 同一套 schema 与迁移」这条路，PGlite 不带它。
 * 于是 `knowledge_chunks.embedding` 声明为 `real[]`（1024 维普通数组），
 * 相似度在 JS 层用 `cosineSimilarity` 计算 —— 与 Mock 实现**同一个函数**，
 * 两种数据源的排序语义因此天然一致。
 *
 * 代价必须写清楚：没有向量索引，检索是**全表扫描**。单商家 Demo 的知识库
 * 只有千条级切片，可接受；切片数量真正上万后，这里会成为瓶颈，
 * 届时按迁移顶部三步接回 pgvector。`MAX_SIMILARITY_CANDIDATES` 是这道
 * 权衡的显式开关，不是「顺手加的 limit」。
 */

import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";

import { getDb } from "@/db";
import { knowledgeChunks, knowledgeDocuments } from "@/db/schema";
import {
  EMBEDDING_DIMENSIONS,
  cosineSimilarity,
  isEmbeddingVector,
} from "@/lib/embedding";
import { isUuid } from "@/lib/id";
import { AppError } from "@/lib/result";
import {
  KNOWLEDGE_INDEX_VERSION,
  type KnowledgeChunk,
  type KnowledgeDocument,
  type KnowledgeDocumentType,
} from "@/types";

import type {
  IndexedKnowledgeChunkInput,
  KnowledgeChunkRepository,
  KnowledgeChunkSearchHit,
  KnowledgeDocumentFilter,
  KnowledgeDocumentKey,
  KnowledgeDocumentRepository,
  NewIndexedKnowledgeDocumentInput,
  NewKnowledgeChunkInput,
  NewKnowledgeDocumentInput,
  UpdateKnowledgeDocumentInput,
} from "../types";
import { mapDatabaseError } from "./errors";
import {
  mapKnowledgeChunkRow,
  mapKnowledgeDocumentRow,
  toChunkSearchHit,
} from "./mappers";
import { findPrimaryBusinessIdOrNull, resolvePrimaryBusinessId } from "./shared";

/** 单次查询返回的文档上限 */
const MAX_DOCUMENT_LIMIT = 200;

/**
 * 向量检索的候选集上限。
 *
 * 没有向量索引（见文件头说明），检索是全表扫描。这个上限保证一次请求
 * 最多把 2000 条切片读进内存算余弦 —— 比「无上限」安全，也比「提前截断到
 * limit 条」诚实：截断到 limit 会让排名失去意义（先取 20 条再排序，
 * 排在后面的真正最佳匹配根本没进候选）。真要上规模，接回 pgvector。
 */
const MAX_SIMILARITY_CANDIDATES = 2000;

/**
 * 校验查询向量（维度 + 有限性）。
 *
 * 只做校验，不再拼 pgvector 字面量 —— 向量不进 SQL 了，直接参与 JS 计算。
 * 之所以仍要拦：维度不对的向量算出来的余弦**不会报错**，只会给出一个
 * 看起来正常的分数，把坏数据伪装成一次成功检索。
 */
function assertQueryEmbedding(embedding: readonly number[]): void {
  const embeddingLength = embedding.length;
  if (!isEmbeddingVector(embedding)) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "检索失败：查询向量维度不合法",
      detail: `期望 ${EMBEDDING_DIMENSIONS} 维且全为有限数，实际长度 ${embeddingLength}。禁止截断或补齐。`,
      retryable: false,
    });
  }
}

/** 文档写入列（不含归属商家） */
function toDocumentColumns(input: NewKnowledgeDocumentInput) {
  return {
    name: input.name,
    type: input.type,
    source: input.source,
    summary: input.summary ?? "",
    content: input.content ?? "",
    productId: input.productId ?? null,
  };
}

function invalidId(action: string, value: string): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message: `${action}失败：标识格式不正确`,
    detail: `not a uuid: ${value}`,
    retryable: false,
  });
}

/** 文档身份：切片行的归属字段全部由它推导，不由调用方传入 */
interface ChunkOwner {
  id: string;
  businessId: string;
  type: KnowledgeDocumentType;
  name: string;
  productId: string | null;
}

/**
 * 向量硬校验（维度 + 有限性），**在任何写操作之前**执行。
 *
 * 放在事务外是有意的：维度不对属于「调用方给的数据本身不可用」，
 * 没必要为此开一个事务再回滚 —— 而且事务里出错时日志会混杂
 * 「事务已中止」这类噪声，掩盖真正的原因。
 *
 * 明确禁止截断、补齐、静默转换（任务书第十二节）：三者产出的向量
 * 看起来能用、语义其实已经错位，且不会报任何错。
 */
function assertChunkEmbeddings(
  chunks: readonly IndexedKnowledgeChunkInput[],
): void {
  for (const chunk of chunks) {
    const embeddingLength = chunk.embedding.length;
    if (!isEmbeddingVector(chunk.embedding)) {
      throw new AppError({
        code: "VALIDATION_FAILED",
        message: "索引知识失败：向量维度不合法",
        detail: `chunkIndex=${chunk.chunkIndex} 的向量应为 ${EMBEDDING_DIMENSIONS} 维且全为有限数，实际长度 ${embeddingLength}。禁止截断或补齐。`,
        retryable: false,
      });
    }
  }
}

/** 空切片集合不得落库：那会造出「文档在、但检索不到」的知识 */
function assertNonEmptyChunks(
  chunks: readonly IndexedKnowledgeChunkInput[],
): void {
  if (chunks.length === 0) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "索引知识失败：没有可检索的切片",
      detail:
        "chunks 为空。正文过短或不含可分块内容时不应建立索引 —— 一份「文档存在但没有任何可检索内容」的知识只会在检索里制造困惑。",
      retryable: false,
    });
  }
}

/**
 * 「已校验的候选切片」+ 文档身份 → `knowledge_chunks` 的插入行。
 *
 * 显式展开字段而不是透传对象：插入类型没有索引签名，
 * 靠断言绕过只会在字段改名时静默丢数据。
 */
function toChunkRows(owner: ChunkOwner, chunks: readonly IndexedKnowledgeChunkInput[]) {
  return chunks.map((chunk) => ({
    documentId: owner.id,
    businessId: owner.businessId,
    productId: owner.productId,
    sourceType: owner.type,
    title: owner.name,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    embedding: [...chunk.embedding],
    metadata: {
      documentName: owner.name,
      sourceType: owner.type,
      productId: owner.productId,
      section: chunk.section,
      chunkIndex: chunk.chunkIndex,
      start: chunk.start,
      end: chunk.end,
      indexVersion: KNOWLEDGE_INDEX_VERSION,
    } satisfies Record<string, unknown>,
  }));
}

export function createDbKnowledgeDocumentRepository(): KnowledgeDocumentRepository {
  /** 一次分组统计，避免列表页每份文档各查一次 */
  async function countChunksByBusiness(): Promise<Record<string, number>> {
    const businessId = await findPrimaryBusinessIdOrNull();
    if (!businessId) {
      return {};
    }
    const rows = await getDb()
      .select({
        documentId: knowledgeChunks.documentId,
        total: count(),
      })
      .from(knowledgeChunks)
      .innerJoin(
        knowledgeDocuments,
        eq(knowledgeChunks.documentId, knowledgeDocuments.id),
      )
      .where(eq(knowledgeDocuments.businessId, businessId))
      .groupBy(knowledgeChunks.documentId);

    // count() 在 postgres.js 下是 bigint，回来是 string，必须显式转数字
    const result: Record<string, number> = {};
    for (const row of rows) {
      const total = Number(row.total);
      result[row.documentId] = Number.isFinite(total) ? total : 0;
    }
    return result;
  }

  return {
    async findDocuments(filter?: KnowledgeDocumentFilter) {
      try {
        const businessId = await findPrimaryBusinessIdOrNull();
        if (!businessId) {
          return [];
        }

        const conditions = [eq(knowledgeDocuments.businessId, businessId)];
        if (filter?.type) {
          conditions.push(eq(knowledgeDocuments.type, filter.type));
        }
        if (filter?.source) {
          conditions.push(eq(knowledgeDocuments.source, filter.source));
        }
        if (filter?.productId !== undefined && filter.productId !== null) {
          if (!isUuid(filter.productId)) {
            return [];
          }
          conditions.push(eq(knowledgeDocuments.productId, filter.productId));
        }

        const rows = await getDb()
          .select()
          .from(knowledgeDocuments)
          .where(and(...conditions))
          .orderBy(desc(knowledgeDocuments.updatedAt))
          .limit(MAX_DOCUMENT_LIMIT);

        const counts = await countChunksByBusiness();
        const keyword = filter?.keyword?.trim().toLowerCase();

        return rows
          .filter((row) =>
            keyword
              ? row.name.toLowerCase().includes(keyword) ||
                row.content.toLowerCase().includes(keyword)
              : true,
          )
          .map((row) => mapKnowledgeDocumentRow(row, counts[row.id] ?? 0));
      } catch (cause) {
        throw mapDatabaseError(cause, "加载知识文档");
      }
    },

    async getDocumentById(id: string): Promise<KnowledgeDocument | null> {
      if (!isUuid(id)) {
        return null;
      }
      try {
        const businessId = await findPrimaryBusinessIdOrNull();
        if (!businessId) {
          return null;
        }
        const rows = await getDb()
          .select()
          .from(knowledgeDocuments)
          .where(
            and(
              eq(knowledgeDocuments.id, id),
              // 归属条件不只是「多一步校验」：它让「猜 uuid 读别家文档」这条路不存在
              eq(knowledgeDocuments.businessId, businessId),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) {
          return null;
        }
        const counts = await countChunksByBusiness();
        return mapKnowledgeDocumentRow(row, counts[row.id] ?? 0);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载知识文档");
      }
    },

    async findDocumentByKey(key: KnowledgeDocumentKey): Promise<KnowledgeDocument | null> {
      if (!isUuid(key.businessId)) {
        return null;
      }
      try {
        const rows = await getDb()
          .select()
          .from(knowledgeDocuments)
          .where(
            and(
              eq(knowledgeDocuments.businessId, key.businessId),
              eq(knowledgeDocuments.type, key.type),
              eq(knowledgeDocuments.name, key.name),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) {
          return null;
        }
        const counts = await countChunksByBusiness();
        return mapKnowledgeDocumentRow(row, counts[row.id] ?? 0);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载知识文档");
      }
    },

    async createDocument(input: NewKnowledgeDocumentInput): Promise<KnowledgeDocument> {
      try {
        const businessId = input.businessId ?? (await resolvePrimaryBusinessId());
        if (!isUuid(businessId)) {
          throw invalidId("创建知识文档", businessId);
        }
        if (input.productId && !isUuid(input.productId)) {
          throw invalidId("创建知识文档", input.productId);
        }

        // 撞唯一索引时由 mapDatabaseError 归一为 DB_ERROR（23505），与 Mock 同一条出口
        const rows = await getDb()
          .insert(knowledgeDocuments)
          .values({ businessId, ...toDocumentColumns(input) })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "保存知识文档失败：数据库未返回记录",
          });
        }
        // 刚建好的文档必然还没有切片
        return mapKnowledgeDocumentRow(row, 0);
      } catch (cause) {
        throw mapDatabaseError(cause, "保存知识文档");
      }
    },

    /**
     * 原子建立「文档 + 全部切片」。
     *
     * 事务里只做两次 INSERT：向量早在调用之前就全部算好了。
     * 把「等模型返回」包进事务是这类代码最典型的错误 ——
     * 一次 embedding 要几秒，事务会一直占着连接与行锁，
     * 并发的索引请求会互相排队甚至死锁。
     *
     * 文档插入失败（唯一键冲突）时事务回滚，切片自然不会落库；
     * 切片插入失败时文档也会一起回滚。因此不存在「文档在、切片缺失」
     * 或「悬空切片」这两种状态。
     */
    async createIndexedDocument(
      input: NewIndexedKnowledgeDocumentInput,
    ): Promise<KnowledgeDocument> {
      try {
        const businessId = input.businessId ?? (await resolvePrimaryBusinessId());
        if (!isUuid(businessId)) {
          throw invalidId("创建知识文档", businessId);
        }
        if (input.productId && !isUuid(input.productId)) {
          throw invalidId("创建知识文档", input.productId);
        }
        assertNonEmptyChunks(input.chunks);
        assertChunkEmbeddings(input.chunks);

        return await getDb().transaction(async (tx) => {
          const inserted = await tx
            .insert(knowledgeDocuments)
            .values({
              businessId,
              ...toDocumentColumns(input),
              // 切片与文档同事务落盘，因此直接是 indexed，没有待索引的中间态
              indexStatus: "indexed",
              indexError: null,
            })
            .returning();

          const row = inserted[0];
          if (!row) {
            throw new AppError({
              code: "DB_ERROR",
              message: "保存知识文档失败：数据库未返回记录",
            });
          }

          const chunkRows = toChunkRows(
            {
              id: row.id,
              businessId: row.businessId,
              type: row.type,
              name: row.name,
              productId: row.productId,
            },
            input.chunks,
          );
          await tx.insert(knowledgeChunks).values(chunkRows);

          return mapKnowledgeDocumentRow(row, chunkRows.length);
        });
      } catch (cause) {
        throw mapDatabaseError(cause, "保存知识文档");
      }
    },

    /**
     * 原子替换索引：改文档字段 + 删旧切片 + 写新切片。
     *
     * 顺序是「先更新、再删旧、后写新」，全程同一事务 ——
     * 若先删旧切片再写新切片，一旦写入失败，文档会从「检索得到」
     * 变成「检索不到」，而商家只看到一句「更新失败」。
     */
    async replaceDocumentIndex(
      id: string,
      patch: UpdateKnowledgeDocumentInput,
      chunks: readonly IndexedKnowledgeChunkInput[],
    ): Promise<KnowledgeDocument> {
      if (!isUuid(id)) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "知识文档不存在",
          detail: `documentId=${id}`,
        });
      }
      try {
        const businessId = await resolvePrimaryBusinessId();
        assertNonEmptyChunks(chunks);
        assertChunkEmbeddings(chunks);

        return await getDb().transaction(async (tx) => {
          const values: Partial<typeof knowledgeDocuments.$inferInsert> = {
            updatedAt: new Date(),
            // 索引状态由本方法统一决定，调用方不必（也不应）自己翻
            indexStatus: "indexed",
            indexError: null,
          };
          if (patch.name !== undefined) values.name = patch.name;
          if (patch.type !== undefined) values.type = patch.type;
          if (patch.summary !== undefined) values.summary = patch.summary;
          if (patch.content !== undefined) values.content = patch.content;
          if (patch.productId !== undefined) {
            if (patch.productId !== null && !isUuid(patch.productId)) {
              throw invalidId("更新知识文档", patch.productId);
            }
            values.productId = patch.productId;
          }

          const updated = await tx
            .update(knowledgeDocuments)
            .set(values)
            .where(
              and(
                eq(knowledgeDocuments.id, id),
                eq(knowledgeDocuments.businessId, businessId),
              ),
            )
            .returning();

          const row = updated[0];
          if (!row) {
            // 抛错即回滚：旧切片**不会**被删掉
            throw new AppError({
              code: "NOT_FOUND",
              message: "知识文档不存在",
              detail: `documentId=${id}`,
            });
          }

          await tx
            .delete(knowledgeChunks)
            .where(eq(knowledgeChunks.documentId, row.id));

          const chunkRows = toChunkRows(
            {
              id: row.id,
              businessId: row.businessId,
              type: row.type,
              name: row.name,
              productId: row.productId,
            },
            chunks,
          );
          await tx.insert(knowledgeChunks).values(chunkRows);

          return mapKnowledgeDocumentRow(row, chunkRows.length);
        });
      } catch (cause) {
        throw mapDatabaseError(cause, "更新知识文档");
      }
    },

    async updateDocument(
      id: string,
      patch: UpdateKnowledgeDocumentInput,
    ): Promise<KnowledgeDocument> {
      if (!isUuid(id)) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "知识文档不存在",
          detail: `documentId=${id}`,
        });
      }
      try {
        const businessId = await resolvePrimaryBusinessId();

        const values: Partial<typeof knowledgeDocuments.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (patch.name !== undefined) values.name = patch.name;
        if (patch.type !== undefined) values.type = patch.type;
        if (patch.summary !== undefined) values.summary = patch.summary;
        if (patch.content !== undefined) values.content = patch.content;
        if (patch.productId !== undefined) {
          if (patch.productId !== null && !isUuid(patch.productId)) {
            throw invalidId("更新知识文档", patch.productId);
          }
          values.productId = patch.productId;
        }
        if (patch.indexStatus !== undefined) values.indexStatus = patch.indexStatus;
        if (patch.indexError !== undefined) values.indexError = patch.indexError;

        const rows = await getDb()
          .update(knowledgeDocuments)
          .set(values)
          .where(
            and(
              eq(knowledgeDocuments.id, id),
              eq(knowledgeDocuments.businessId, businessId),
            ),
          )
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "知识文档不存在",
            detail: `documentId=${id}`,
          });
        }
        const counts = await countChunksByBusiness();
        return mapKnowledgeDocumentRow(row, counts[row.id] ?? 0);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新知识文档");
      }
    },

    async deleteDocument(id: string): Promise<void> {
      if (!isUuid(id)) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "知识文档不存在",
          detail: `documentId=${id}`,
        });
      }
      try {
        const businessId = await resolvePrimaryBusinessId();
        // 切片由 knowledge_chunks.document_id 的 ON DELETE CASCADE 一并清除，
        // 不在应用层再写一次 —— 两处都写，早晚会有一处漏掉
        const rows = await getDb()
          .delete(knowledgeDocuments)
          .where(
            and(
              eq(knowledgeDocuments.id, id),
              eq(knowledgeDocuments.businessId, businessId),
            ),
          )
          .returning({ id: knowledgeDocuments.id });

        if (rows.length === 0) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "知识文档不存在",
            detail: `documentId=${id}`,
          });
        }
      } catch (cause) {
        throw mapDatabaseError(cause, "删除知识文档");
      }
    },

    async upsertDocument(input: NewKnowledgeDocumentInput): Promise<KnowledgeDocument> {
      try {
        const businessId = input.businessId ?? (await resolvePrimaryBusinessId());
        if (!isUuid(businessId)) {
          throw invalidId("同步知识文档", businessId);
        }
        if (input.productId && !isUuid(input.productId)) {
          throw invalidId("同步知识文档", input.productId);
        }

        const rows = await getDb()
          .insert(knowledgeDocuments)
          .values({ businessId, ...toDocumentColumns(input) })
          .onConflictDoUpdate({
            // 冲突目标必须与唯一索引的列序一致，否则 Postgres 找不到匹配的约束
            target: [
              knowledgeDocuments.businessId,
              knowledgeDocuments.type,
              knowledgeDocuments.name,
            ],
            set: {
              summary: input.summary ?? "",
              content: input.content ?? "",
              productId: input.productId ?? null,
              /**
               * 正文变了，旧向量必然过期，因此状态回到 pending、
               * 清掉上一次的错误。索引服务随后会在同一轮里重新切片。
               * **保留 id**：历史消息的引用快照指向 documentId，
               * 换 id 会让「当时引用的是哪份文档」全部失联。
               */
              indexStatus: "pending",
              indexError: null,
              updatedAt: new Date(),
            },
          })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "同步知识文档失败：数据库未返回记录",
          });
        }

        /**
         * 这里必须重新数一次切片。
         *
         * 走上 `DO UPDATE` 分支时文档 id 没变，旧切片还在库里 ——
         * 若像 create 那样写死 0，界面会显示「0 个分块」，
         * 而实际上检索仍能命中它们。这个不一致会直接误导商家。
         */
        const counts = await countChunksByBusiness();
        return mapKnowledgeDocumentRow(row, counts[row.id] ?? 0);
      } catch (cause) {
        throw mapDatabaseError(cause, "同步知识文档");
      }
    },

    async deleteSystemDocumentsByProduct(productId: string): Promise<number> {
      if (!isUuid(productId)) {
        return 0;
      }
      try {
        const businessId = await resolvePrimaryBusinessId();
        const rows = await getDb()
          .delete(knowledgeDocuments)
          .where(
            and(
              eq(knowledgeDocuments.businessId, businessId),
              eq(knowledgeDocuments.productId, productId),
              eq(knowledgeDocuments.source, "system"),
            ),
          )
          .returning({ id: knowledgeDocuments.id });
        return rows.length;
      } catch (cause) {
        throw mapDatabaseError(cause, "清理商品知识文档");
      }
    },

    async countChunksByDocuments() {
      try {
        return await countChunksByBusiness();
      } catch (cause) {
        throw mapDatabaseError(cause, "统计知识切片");
      }
    },
  };
}

export function createDbKnowledgeChunkRepository(): KnowledgeChunkRepository {
  return {
    async createChunks(inputs: readonly NewKnowledgeChunkInput[]) {
      if (inputs.length === 0) {
        return [];
      }

      try {
        const rows = inputs.map((input) => {
          if (!isUuid(input.documentId)) {
            throw invalidId("写入知识切片", input.documentId);
          }
          if (!isUuid(input.businessId)) {
            throw invalidId("写入知识切片", input.businessId);
          }
          if (input.productId && !isUuid(input.productId)) {
            throw invalidId("写入知识切片", input.productId);
          }
          /**
           * 维度校验必须在拼 SQL 之前。允许 `null`（索引失败时先落内容），
           * 但不允许「维度不对的向量」——数据库虽然会拒绝，
           * 它给出的错误信息却指向迁移，而不是指向 Provider。
           */
          const embedding = input.embedding;
          if (embedding !== null) {
            const embeddingLength = embedding.length;
            if (!isEmbeddingVector(embedding)) {
              throw new AppError({
                code: "VALIDATION_FAILED",
                message: "写入知识切片失败：向量维度不合法",
                detail: `chunkIndex=${input.chunkIndex} 的向量应为 ${EMBEDDING_DIMENSIONS} 维，实际长度 ${embeddingLength}`,
                retryable: false,
              });
            }
          }

          // 显式展开字段，而不是 `metadata as Record<string, unknown>`：
          // 接口类型没有索引签名，靠断言绕过只会在字段改名时静默丢数据
          const metadata: Record<string, unknown> | null = input.metadata
            ? {
                documentName: input.metadata.documentName,
                sourceType: input.metadata.sourceType,
                productId: input.metadata.productId,
                section: input.metadata.section,
                chunkIndex: input.metadata.chunkIndex,
                start: input.metadata.start,
                end: input.metadata.end,
              }
            : null;

          return {
            documentId: input.documentId,
            businessId: input.businessId,
            productId: input.productId,
            sourceType: input.sourceType,
            title: input.title,
            chunkIndex: input.chunkIndex,
            content: input.content,
            embedding: input.embedding ? [...input.embedding] : null,
            metadata,
          };
        });

        // 一次多行 INSERT：Postgres 保证它在单条语句内原子完成，
        // 不存在「写了 3 条然后失败」的中间态
        const inserted = await getDb().insert(knowledgeChunks).values(rows).returning();
        return inserted.map(mapKnowledgeChunkRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "写入知识切片");
      }
    },

    async deleteChunksByDocument(documentId: string) {
      if (!isUuid(documentId)) {
        return 0;
      }
      try {
        const rows = await getDb()
          .delete(knowledgeChunks)
          .where(eq(knowledgeChunks.documentId, documentId))
          .returning({ id: knowledgeChunks.id });
        return rows.length;
      } catch (cause) {
        throw mapDatabaseError(cause, "清理知识切片");
      }
    },

    async listByDocument(documentId: string) {
      if (!isUuid(documentId)) {
        return [] as KnowledgeChunk[];
      }
      try {
        const rows = await getDb()
          .select()
          .from(knowledgeChunks)
          .where(eq(knowledgeChunks.documentId, documentId))
          .orderBy(asc(knowledgeChunks.chunkIndex));
        return rows.map(mapKnowledgeChunkRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载知识切片");
      }
    },

    /**
     * 向量检索。
     *
     * 两步：先用 Drizzle 把候选切片取回来（**过滤条件全在 SQL 里**，
     * 尤其是商家过滤），再在 JS 层算余弦、按相似度降序、取前 limit 条。
     *
     * 顺序值得强调：`minSimilarity` 必须在**截断之前**生效，
     * 与旧版 SQL 的 `WHERE similarity >= $n ORDER BY ... LIMIT` 同义 ——
     * 低分切片不该占用 TopK 名额（Mock 实现第 11 行注释同款约定）。
     */
    async searchSimilar(params): Promise<KnowledgeChunkSearchHit[]> {
      const { businessId, queryEmbedding } = params;
      if (!isUuid(businessId)) {
        return [];
      }
      if (params.productId && !isUuid(params.productId)) {
        return [];
      }

      assertQueryEmbedding(queryEmbedding);

      const limit = Math.min(100, Math.max(1, Math.trunc(params.limit ?? 20)));

      try {
        const conditions = [
          // 商家过滤写在 SQL 里，不靠调用方自觉 —— 多商家上线时这里是唯一泄漏点
          eq(knowledgeChunks.businessId, businessId),
          // 没索引成功的切片没有向量，不该以 0 分参与排序（Mock 同款约定）
          isNotNull(knowledgeChunks.embedding),
        ];

        if (params.sourceTypes && params.sourceTypes.length > 0) {
          conditions.push(inArray(knowledgeChunks.sourceType, params.sourceTypes));
        }

        // 商品过滤：该商品的知识 **或** 全店知识（product_id IS NULL）
        if (params.productId) {
          conditions.push(
            or(
              eq(knowledgeChunks.productId, params.productId),
              isNull(knowledgeChunks.productId),
            )!,
          );
        }

        const rows = await getDb()
          .select()
          .from(knowledgeChunks)
          .where(and(...conditions))
          .limit(MAX_SIMILARITY_CANDIDATES);

        const hits: KnowledgeChunkSearchHit[] = [];
        for (const row of rows) {
          const embedding = row.embedding;
          // 列可空（索引失败时先落内容）；`isNotNull` 已挡掉，这里只是类型收窄
          if (!embedding || embedding.length === 0) {
            continue;
          }

          const similarity = cosineSimilarity(queryEmbedding, embedding);
          if (
            params.minSimilarity !== undefined &&
            similarity < params.minSimilarity
          ) {
            continue;
          }

          hits.push(toChunkSearchHit(row, similarity));
        }

        hits.sort((left, right) => right.similarity - left.similarity);
        return hits.slice(0, limit);
      } catch (cause) {
        throw mapDatabaseError(cause, "检索知识库");
      }
    },

    async countByDocument(documentId: string) {
      if (!isUuid(documentId)) {
        return 0;
      }
      try {
        const rows = await getDb()
          .select({ total: count() })
          .from(knowledgeChunks)
          .where(eq(knowledgeChunks.documentId, documentId));
        const total = Number(rows[0]?.total ?? 0);
        return Number.isFinite(total) ? total : 0;
      } catch (cause) {
        throw mapDatabaseError(cause, "统计知识切片");
      }
    },
  };
}
