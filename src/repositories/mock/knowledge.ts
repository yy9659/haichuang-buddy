/**
 * 知识库仓储 · Mock 实现（S5）
 *
 * 与数据库实现必须**语义一致**，否则「切数据源不改上层」就成了空话。
 * 三处最容易写歪、这里刻意对齐的地方：
 * 1. `(businessId, type, name)` 唯一 —— `createDocument` 撞了抛 DB_ERROR，
 *    系统同步走 `upsertDocument`（存在则改、不存在则建），不靠调用方先查后写。
 * 2. `searchSimilar` **每次都带商家过滤**。即使 Demo 只有一个商家，
 *    这个条件也必须出现在语句里 —— 否则多商家上线那天，
 *    这里就是第一个泄漏点，而且不会有任何报错。
 * 3. 检索排序按余弦降序，`minSimilarity` 在仓储层就把噪声丢掉，
 *    不占用 TopK 名额（与 SQL 里的 `WHERE similarity >= $n ORDER BY ... LIMIT` 同义）。
 *
 * 向量这件事只在本文件与 Provider 之间流动：`StoredKnowledgeChunk.embedding`
 * 读出来算完相似度就丢掉，映射到领域类型时没有它。
 */

import { formatDateTime } from "@/lib/datetime";
import {
  EMBEDDING_DIMENSIONS,
  cosineSimilarity,
  isEmbeddingVector,
} from "@/lib/embedding";
import { createLocalId } from "@/lib/id";
import { MOCK_BUSINESS } from "@/lib/mock";
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
  NewKnowledgeDocumentInput,
  NewKnowledgeChunkInput,
  UpdateKnowledgeDocumentInput,
} from "../types";
import {
  findStoredKnowledgeDocument,
  listStoredKnowledgeChunks,
  listStoredKnowledgeDocuments,
  putStoredKnowledgeChunks,
  putStoredKnowledgeDocument,
  removeStoredChunksByDocument,
  removeStoredKnowledgeDocument,
  replaceStoredChunksForDocument,
  replaceStoredKnowledgeDocument,
  type StoredKnowledgeChunk,
  type StoredKnowledgeDocument,
} from "./store";

/** 单商家 Demo：不传 businessId 时落到内置商家 */
function resolveBusinessId(businessId?: string): string {
  return businessId ?? MOCK_BUSINESS.id;
}

/**
 * 存储行 → 领域类型。
 *
 * `chunkCount` 现算（派生字段不落库），因此需要一份「文档 id → 切片数」的表；
 * 调用方一次算好传进来，避免列表页 N 次全表扫描。
 */
function toDomainDocument(
  document: StoredKnowledgeDocument,
  chunkCounts: Record<string, number>,
): KnowledgeDocument {
  return {
    id: document.id,
    businessId: document.businessId,
    name: document.name,
    type: document.type,
    source: document.source,
    summary: document.summary,
    content: document.content,
    productId: document.productId,
    indexStatus: document.indexStatus,
    indexError: document.indexError,
    chunkCount: chunkCounts[document.id] ?? 0,
    updatedAt: formatDateTime(document.updatedAt),
    createdAt: formatDateTime(document.createdAt),
  };
}

/** 切片行 → 领域类型（**丢掉 embedding**） */
function toDomainChunk(chunk: StoredKnowledgeChunk): KnowledgeChunk {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    businessId: chunk.businessId,
    productId: chunk.productId,
    sourceType: chunk.sourceType,
    title: chunk.title,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    metadata: chunk.metadata,
    createdAt: formatDateTime(chunk.createdAt),
  };
}

/** 按文档分组统计切片数（一次遍历，供列表页共用） */
function countChunks(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const chunk of listStoredKnowledgeChunks()) {
    counts[chunk.documentId] = (counts[chunk.documentId] ?? 0) + 1;
  }
  return counts;
}

function notFound(id: string): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "知识文档不存在",
    detail: `documentId=${id}`,
  });
}

/** 唯一键冲突（与数据库的 23505 同一出口，文案也保持一致） */
function duplicateName(input: {
  name: string;
  type: string;
}): AppError {
  return new AppError({
    code: "DB_ERROR",
    message: "保存知识文档失败：数据已存在，请勿重复提交",
    detail: `unique_violation (knowledge_documents_business_name_unique): 同一商家下已存在「${input.type} / ${input.name}」`,
    retryable: false,
  });
}

/**
 * 把「待写入的切片」变成存储行，并**在写之前**完成全部校验。
 *
 * 抽出来给三条路径共用（手动写切片、建文档时连带写、替换索引），
 * 是因为校验规则一旦各写一份，早晚会有一条路径漏掉维度检查 ——
 * 而漏掉的那条会在 Mock 下静默通过、切到数据库时报一个指向迁移的错误。
 *
 * 返回的是**完整的新行**，调用方拿到它之后只做「一次性写回」，
 * 中间不再有任何可能失败的步骤。这正是内存实现模拟事务的方式。
 */
function buildStoredChunkRows(
  inputs: readonly NewKnowledgeChunkInput[],
): StoredKnowledgeChunk[] {
  const now = new Date();
  return inputs.map((input) => {
    /**
     * 向量维度必须在**写之前**校验。
     *
     * 数据库列是定长 `vector(1024)`，维度不对会直接报错；Mock 若默默接受，
     * 就会出现「本地全绿、切到 db 就炸」。允许为 null 是刻意的：
     * 索引失败时先落内容、向量留待重试补 —— 那也是数据库允许的状态。
     */
    const embedding = input.embedding;
    if (embedding !== null) {
      // 长度先取出来：isEmbeddingVector 是类型谓词，取反分支会把 embedding 收窄成 never
      const embeddingLength = embedding.length;
      if (!isEmbeddingVector(embedding)) {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: "写入知识切片失败：向量维度不合法",
          detail: `chunkIndex=${input.chunkIndex} 的向量长度应为 ${EMBEDDING_DIMENSIONS}，实际为 ${embeddingLength}。禁止截断或补齐。`,
          retryable: false,
        });
      }
    }

    return {
      id: createLocalId("kchunk"),
      documentId: input.documentId,
      businessId: input.businessId,
      productId: input.productId,
      sourceType: input.sourceType,
      title: input.title,
      chunkIndex: input.chunkIndex,
      content: input.content,
      embedding: input.embedding ? [...input.embedding] : null,
      metadata: input.metadata ?? {
        documentName: input.title,
        sourceType: input.sourceType,
        productId: input.productId,
        section: "",
        chunkIndex: input.chunkIndex,
        start: 0,
        end: input.content.length,
      },
      createdAt: now,
    };
  });
}

/**
 * 「索引候选切片 + 文档」→ 待写入的切片行。
 *
 * 切片的归属字段（商家 / 商品 / 文档名 / 类型）**全部从文档推导**，
 * 不由调用方传入：这几个字段一旦与文档不一致，检索会命中到别家或别的商品的知识，
 * 而且不会报错。让它们只有一个来源，这类错误就不可能出现。
 */
function toChunkInputs(
  document: {
    id: string;
    businessId: string;
    type: KnowledgeDocumentType;
    name: string;
    productId: string | null;
  },
  chunks: readonly IndexedKnowledgeChunkInput[],
): NewKnowledgeChunkInput[] {
  return chunks.map((chunk) => ({
    documentId: document.id,
    businessId: document.businessId,
    productId: document.productId,
    sourceType: document.type,
    title: document.name,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    embedding: chunk.embedding,
    metadata: {
      documentName: document.name,
      sourceType: document.type,
      productId: document.productId,
      section: chunk.section,
      chunkIndex: chunk.chunkIndex,
      start: chunk.start,
      end: chunk.end,
      indexVersion: KNOWLEDGE_INDEX_VERSION,
    },
  }));
}

/** 空切片集合不得落库：那会造出「文档在、但检索不到」的知识 */
function requireChunks(chunks: readonly IndexedKnowledgeChunkInput[]): void {
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

export function createMockKnowledgeDocumentRepository(): KnowledgeDocumentRepository {
  /** 抽成局部函数而不是用 `this.createDocument` —— 方法被解构出去后 `this` 会丢 */
  async function createDocument(
    input: NewKnowledgeDocumentInput,
  ): Promise<KnowledgeDocument> {
    const businessId = resolveBusinessId(input.businessId);
    const duplicated = listStoredKnowledgeDocuments().some(
      (item) =>
        item.businessId === businessId &&
        item.type === input.type &&
        item.name === input.name,
    );
    if (duplicated) {
      throw duplicateName({ name: input.name, type: input.type });
    }

    const now = new Date();
    const document: StoredKnowledgeDocument = {
      id: createLocalId("kdoc"),
      businessId,
      name: input.name,
      type: input.type,
      source: input.source,
      summary: input.summary ?? "",
      content: input.content ?? "",
      productId: input.productId ?? null,
      // 新建文档一定是 pending：切片与向量化是独立一步，成功后才标记 indexed
      indexStatus: "pending",
      indexError: null,
      createdAt: now,
      updatedAt: now,
    };
    putStoredKnowledgeDocument(document);
    return toDomainDocument(document, countChunks());
  }

  return {
    async findDocuments(filter?: KnowledgeDocumentFilter) {
      const counts = countChunks();
      const keyword = filter?.keyword?.trim().toLowerCase();

      return listStoredKnowledgeDocuments()
        .filter((document) => {
          if (filter?.type && document.type !== filter.type) {
            return false;
          }
          if (filter?.source && document.source !== filter.source) {
            return false;
          }
          // 注意 productId 的三态：仅当显式给了非 null 值才按商品过滤
          if (
            filter?.productId !== undefined &&
            filter.productId !== null &&
            document.productId !== filter.productId
          ) {
            return false;
          }
          if (
            keyword &&
            !document.name.toLowerCase().includes(keyword) &&
            !document.content.toLowerCase().includes(keyword)
          ) {
            return false;
          }
          return true;
        })
        .map((document) => toDomainDocument(document, counts));
    },

    async getDocumentById(id: string) {
      const document = findStoredKnowledgeDocument(id);
      return document ? toDomainDocument(document, countChunks()) : null;
    },

    async findDocumentByKey(key: KnowledgeDocumentKey) {
      const document = listStoredKnowledgeDocuments().find(
        (item) =>
          item.businessId === key.businessId &&
          item.type === key.type &&
          item.name === key.name,
      );
      return document ? toDomainDocument(document, countChunks()) : null;
    },

    async createDocument(input: NewKnowledgeDocumentInput) {
      return createDocument(input);
    },

    /**
     * 原子建立「文档 + 全部切片」。
     *
     * 顺序是刻意的：**先把切片行全部构造并校验完**，再写内存。
     * 反过来的话（先放文档、再逐条 push 切片），任何一条切片校验失败
     * 都会留下一份「文档在、切片不完整」的知识 —— 而它照样会被列出来、
     * 照样能被检索到一部分，没有任何迹象说明它是不完整的。
     */
    async createIndexedDocument(input: NewIndexedKnowledgeDocumentInput) {
      const businessId = resolveBusinessId(input.businessId);
      const duplicated = listStoredKnowledgeDocuments().some(
        (item) =>
          item.businessId === businessId &&
          item.type === input.type &&
          item.name === input.name,
      );
      if (duplicated) {
        throw duplicateName({ name: input.name, type: input.type });
      }
      requireChunks(input.chunks);

      const now = new Date();
      const document: StoredKnowledgeDocument = {
        id: createLocalId("kdoc"),
        businessId,
        name: input.name,
        type: input.type,
        source: input.source,
        summary: input.summary ?? "",
        content: input.content ?? "",
        productId: input.productId ?? null,
        // 切片与文档同时落盘，因此直接是 indexed —— 没有任何中间态需要表达
        indexStatus: "indexed",
        indexError: null,
        createdAt: now,
        updatedAt: now,
      };

      const rows = buildStoredChunkRows(
        toChunkInputs(
          {
            id: document.id,
            businessId: document.businessId,
            type: document.type,
            name: document.name,
            productId: document.productId,
          },
          input.chunks,
        ),
      );

      putStoredKnowledgeDocument(document);
      putStoredKnowledgeChunks(rows);

      return toDomainDocument(document, { [document.id]: rows.length });
    },

    /**
     * 原子替换索引：改文档 + 换切片。
     *
     * 旧的切片**在新切片全部校验通过之后**才被移除，
     * 因此「新向量算错了」这件事不可能让文档变成检索不到 ——
     * 那正是「先删后写」最典型的破坏方式。
     */
    async replaceDocumentIndex(
      id: string,
      patch: UpdateKnowledgeDocumentInput,
      chunks: readonly IndexedKnowledgeChunkInput[],
    ) {
      const current = findStoredKnowledgeDocument(id);
      if (!current) {
        throw notFound(id);
      }

      if (patch.name !== undefined && patch.name !== current.name) {
        const duplicated = listStoredKnowledgeDocuments().some(
          (item) =>
            item.id !== id &&
            item.businessId === current.businessId &&
            item.type === (patch.type ?? current.type) &&
            item.name === patch.name,
        );
        if (duplicated) {
          throw duplicateName({ name: patch.name, type: patch.type ?? current.type });
        }
      }
      requireChunks(chunks);

      const next: StoredKnowledgeDocument = {
        ...current,
        name: patch.name ?? current.name,
        type: patch.type ?? current.type,
        summary: patch.summary ?? current.summary,
        content: patch.content ?? current.content,
        productId: patch.productId !== undefined ? patch.productId : current.productId,
        // 索引状态由本方法统一决定，调用方不必（也不应）自己翻
        indexStatus: "indexed",
        indexError: null,
        updatedAt: new Date(),
      };

      const rows = buildStoredChunkRows(
        toChunkInputs(
          {
            id: next.id,
            businessId: next.businessId,
            type: next.type,
            name: next.name,
            productId: next.productId,
          },
          chunks,
        ),
      );

      replaceStoredKnowledgeDocument(next);
      replaceStoredChunksForDocument(next.id, rows);

      return toDomainDocument(next, { [next.id]: rows.length });
    },

    async updateDocument(id: string, patch: UpdateKnowledgeDocumentInput) {
      const current = findStoredKnowledgeDocument(id);
      if (!current) {
        throw notFound(id);
      }

      // 改名会撞唯一索引，先挡下来（数据库那边是 23505，这里给同样的出口）
      if (patch.name !== undefined && patch.name !== current.name) {
        const duplicated = listStoredKnowledgeDocuments().some(
          (item) =>
            item.id !== id &&
            item.businessId === current.businessId &&
            item.type === (patch.type ?? current.type) &&
            item.name === patch.name,
        );
        if (duplicated) {
          throw duplicateName({ name: patch.name, type: patch.type ?? current.type });
        }
      }

      const next: StoredKnowledgeDocument = {
        ...current,
        name: patch.name ?? current.name,
        type: patch.type ?? current.type,
        summary: patch.summary ?? current.summary,
        content: patch.content ?? current.content,
        productId: patch.productId !== undefined ? patch.productId : current.productId,
        indexStatus: patch.indexStatus ?? current.indexStatus,
        indexError:
          patch.indexError !== undefined ? patch.indexError : current.indexError,
        updatedAt: new Date(),
      };
      replaceStoredKnowledgeDocument(next);
      return toDomainDocument(next, countChunks());
    },

    async deleteDocument(id: string) {
      if (!removeStoredKnowledgeDocument(id)) {
        throw notFound(id);
      }
    },

    async upsertDocument(input: NewKnowledgeDocumentInput) {
      const businessId = resolveBusinessId(input.businessId);
      const existing = listStoredKnowledgeDocuments().find(
        (item) =>
          item.businessId === businessId &&
          item.type === input.type &&
          item.name === input.name,
      );
      if (!existing) {
        return createDocument(input);
      }

      /**
       * 已存在的系统文档：内容整份替换，但**保留 id**。
       *
       * 保留 id 是有意的 —— 历史消息里的引用快照指向这个 documentId，
       * 每次同步换一个 id 会让「当时引用的是哪份文档」全部失联。
       * 并且同步后索引状态回到 pending：正文变了，旧向量必然过期。
       */
      const next: StoredKnowledgeDocument = {
        ...existing,
        summary: input.summary ?? existing.summary,
        content: input.content ?? existing.content,
        productId: input.productId !== undefined ? input.productId : existing.productId,
        indexStatus: "pending",
        indexError: null,
        updatedAt: new Date(),
      };
      replaceStoredKnowledgeDocument(next);
      return toDomainDocument(next, countChunks());
    },

    async deleteSystemDocumentsByProduct(productId: string) {
      // 快照 id 列表后再删：删除过程中会改动原数组，边遍历边删必错
      const targets = listStoredKnowledgeDocuments()
        .filter(
          (document) =>
            document.source === "system" && document.productId === productId,
        )
        .map((document) => document.id);

      for (const id of targets) {
        removeStoredKnowledgeDocument(id);
      }
      return targets.length;
    },

    async countChunksByDocuments() {
      return countChunks();
    },
  };
}

export function createMockKnowledgeChunkRepository(): KnowledgeChunkRepository {
  return {
    /**
     * 批量写入（供系统同步等「先落内容、向量后补」的路径使用）。
     *
     * 「不留半套向量」这条约束在 Mock 下天然成立（先全部构造，再一次性 push），
     * 但**仍要显式校验**：调用方传进来的向量维度不对时必须在写之前就失败，
     * 否则 Mock 模式会默默接受数据库一定会拒绝的数据，
     * 于是「本地全绿、上线炸」。
     */
    async createChunks(inputs: readonly NewKnowledgeChunkInput[]) {
      if (inputs.length === 0) {
        return [];
      }

      const prepared = buildStoredChunkRows(inputs);
      putStoredKnowledgeChunks(prepared);
      return prepared.map(toDomainChunk);
    },

    async deleteChunksByDocument(documentId: string) {
      return removeStoredChunksByDocument(documentId);
    },

    async listByDocument(documentId: string) {
      return listStoredKnowledgeChunks()
        .filter((chunk) => chunk.documentId === documentId)
        .sort((left, right) => left.chunkIndex - right.chunkIndex)
        .map(toDomainChunk);
    },

    async searchSimilar(params) {
      const { businessId, queryEmbedding } = params;
      const hits: KnowledgeChunkSearchHit[] = [];

      for (const chunk of listStoredKnowledgeChunks()) {
        /**
         * 商家过滤放在最前面，且是**必填条件**（不是可选优化）。
         * Demo 只有一个商家，这个判断永远为真 —— 但它必须在。
         */
        if (chunk.businessId !== businessId) {
          continue;
        }
        if (params.sourceTypes && !params.sourceTypes.includes(chunk.sourceType)) {
          continue;
        }
        if (
          params.productId !== undefined &&
          params.productId !== null &&
          chunk.productId !== null &&
          chunk.productId !== params.productId
        ) {
          continue;
        }
        // 未索引成功的切片没有向量，跳过而不是当作 0 分参与排序
        if (!chunk.embedding) {
          continue;
        }

        const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
        if (params.minSimilarity !== undefined && similarity < params.minSimilarity) {
          continue;
        }
        hits.push({ chunk: toDomainChunk(chunk), similarity });
      }

      hits.sort((left, right) => right.similarity - left.similarity);
      const limit = params.limit ?? hits.length;
      return hits.slice(0, Math.max(0, limit));
    },

    async countByDocument(documentId: string) {
      return listStoredKnowledgeChunks().filter(
        (chunk) => chunk.documentId === documentId,
      ).length;
    },
  };
}
