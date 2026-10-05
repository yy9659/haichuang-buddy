/**
 * 知识生命周期 Service（S5 · 任务书第五 / 七 / 八 / 十一 / 十三 / 十八 / 二十二节）
 *
 * 这是知识库的**唯一权威写入口**。页面、测试、种子、缺口补知识、
 * 以后的知识库管理界面，全部走这里。
 *
 * 在它出现之前，「正文 → 切片 → 向量 → 落库」这套流程散落在各处的手抄代码里
 * （光测试里就抄了三份），而每一份都可能少一步：忘了校验向量维度、
 * 忘了写 metadata、忘了删旧切片。这类遗漏的后果不是报错，而是
 * 「某份知识看起来在库里，就是检索不到」。
 *
 * ## 两条贯穿全文件的约束
 *
 * **① 模型调用绝不出现在事务里。** 正确顺序是
 * 「读旧状态 → 内存里构建完整新索引（切片 + 向量全部成功）→ 开短事务 → 一次性替换 → 提交」。
 * 反过来（开事务 → 调 embedding → 等几秒 → 写库 → 提交）会让事务在整个
 * 网络等待期间占着连接与行锁，并发索引请求互相排队甚至死锁 ——
 * 而且失败回滚时，那几秒的模型调用费也已经花掉了。
 *
 * **② 事务边界属于仓储。** 本文件从不 import `@/db`，也不持有 Drizzle client；
 * 「文档 + 切片」的原子性由 `createIndexedDocument` / `replaceDocumentIndex`
 * 两个仓储方法保证。Service 只说业务意图（「把索引换成这一套」），
 * 不说怎么保证原子 —— 否则换存储时这一层要重写。
 *
 * ## 刻意不做的事
 *
 * - **不对正文做 Question Normalizer**（任务书第七节）。`normalizeQuestion`
 *   会剥掉客套话、标点与语气词，那对「判断两个提问是不是同一个」是对的，
 *   对知识正文是破坏性的：正文的段落结构、编号、`0-4℃` 里的符号都是语义的一部分。
 *   正文只交给 `chunkDocument()` 处理。
 * - **不自动解决知识缺口**（第二十一节）。普通写入不猜「这份文档大概解决了哪个缺口」，
 *   只有显式走 `createKnowledgeForGap()` 才会动缺口状态。
 *   让程序去猜，早晚会把不相关的缺口标成已解决 —— 而商家会因此以为问题已经处理过了。
 */

import { getAIProvider } from "@/ai/provider";
import type { AIProvider } from "@/ai/provider/types";
import { mapWithConcurrency } from "@/lib/concurrency";
import { EMBEDDING_DIMENSIONS, isEmbeddingVector } from "@/lib/embedding";
import { attempt, fail, ok, toAppError, type Result } from "@/lib/result";
import { chunkDocument } from "@/rag/chunking";
import { getRepositories } from "@/repositories";
import type {
  IndexedKnowledgeChunkInput,
  KnowledgeDocumentFilter,
} from "@/repositories/types";
import {
  KNOWLEDGE_DOCUMENT_TYPES,
  KNOWLEDGE_INDEX_VERSION,
  isKnowledgeDocumentType,
  type KnowledgeDocument,
  type KnowledgeDocumentSource,
  type KnowledgeDocumentType,
  type KnowledgeGapRecord,
} from "@/types";

import { getKnowledgeGap, resolveKnowledgeGap } from "./knowledge-gap.service";

/* ------------------------------------------------------------------ */
/* 索引参数                                                            */
/* ------------------------------------------------------------------ */

export interface KnowledgeIndexConfig {
  /**
   * 单次 `embed` 请求携带的切片数。
   *
   * 取 8 而不是「有多少切片就一次发完」：DashScope 的 embeddings 协议
   * 单次最多 10 条（超限直接 400），而 8 既在硬限制之内、
   * 又比逐条请求少一个数量级的往返。
   */
  embeddingBatchSize: number;
  /**
   * 同时进行的 `embed` 请求数上限。
   *
   * 一份正常文档能切出几十个切片，全量并发会同时触发三件事：
   * 撞限流（429，而且是一次性全中）、把连接池占满拖慢其它请求、
   * 失败重试时又全量重发。3 是在「够快」与「够稳」之间取的保守值。
   */
  embeddingConcurrency: number;
}

/** 索引参数集中在这里，改行为只改这一处 */
export const KNOWLEDGE_INDEX_CONFIG: KnowledgeIndexConfig = {
  embeddingBatchSize: 8,
  embeddingConcurrency: 3,
};

/* ------------------------------------------------------------------ */
/* 输入类型                                                            */
/* ------------------------------------------------------------------ */

/**
 * 写入一份知识文档。
 *
 * 字段名用 `name` 而不是任务书里的 `title`：项目里「文档名」一贯叫 `name`
 * （数据库列、仓储接口、界面文案都是），为它另起一个同义词只会让
 * 「到底该传哪个」在每次调用前都要查一遍。
 */
export interface KnowledgeDocumentInput {
  /** 知识归属商家。**必填** —— 跨商家写入不可接受 */
  businessId: string;
  /**
   * 关联商品；全店级知识（物流 / 售后 / 品牌）传 null。
   * 传了具体商品时会校验它确实属于该商家。
   */
  productId?: string | null;
  name: string;
  type: KnowledgeDocumentType;
  content: string;
  summary?: string;
  /** 默认 `manual`；系统同步走 `upsertDocument`，不经过这里 */
  source?: KnowledgeDocumentSource;
}

/** 更新：只传要改的字段，其余沿用当前文档 */
export interface KnowledgeDocumentPatch {
  name?: string;
  type?: KnowledgeDocumentType;
  content?: string;
  summary?: string;
  productId?: string | null;
}

/** 索引所需的注入点（测试用；生产路径全部取默认值） */
export interface KnowledgeServiceOptions {
  provider?: AIProvider;
  signal?: AbortSignal;
  config?: Partial<KnowledgeIndexConfig>;
}

/** 校验后的完整输入：字段都已 trim、类型已收窄 */
interface ValidatedKnowledgeInput {
  businessId: string;
  productId: string | null;
  name: string;
  type: KnowledgeDocumentType;
  content: string;
  summary: string;
  source: KnowledgeDocumentSource;
}

/* ------------------------------------------------------------------ */
/* 索引候选构建（纯内存，不写库）                                      */
/* ------------------------------------------------------------------ */

interface IndexDeps {
  provider: AIProvider;
  signal?: AbortSignal;
  config: KnowledgeIndexConfig;
}

function resolveIndexDeps(options: KnowledgeServiceOptions): IndexDeps {
  return {
    provider: options.provider ?? getAIProvider(),
    ...(options.signal ? { signal: options.signal } : {}),
    config: { ...KNOWLEDGE_INDEX_CONFIG, ...options.config },
  };
}

/** 把切片按批量大小分组（不修改原数组） */
function toBatches<T>(items: readonly T[], size: number): T[][] {
  const batchSize = Math.max(1, Math.trunc(size));
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}

/**
 * 构建「可以落库的完整索引」。
 *
 * 这个阶段**一次数据库都不碰** —— 它只做三件事：切片、向量化、校验。
 * 全部成功之后调用方才拿着结果去开一个只含写操作的事务。
 * 因此「Embedding 跑到一半失败」不会留下任何痕迹：数据库里根本还没开始写。
 *
 * 任何一处失败（切片为空、模型报错、向量数量不符、维度不对、含 NaN）
 * 都会在这一步返回错误，调用方据此放弃整个操作 —— 而不是「能写多少写多少」。
 */
async function buildKnowledgeIndexCandidate(
  content: string,
  deps: IndexDeps,
): Promise<Result<{ chunks: IndexedKnowledgeChunkInput[] }>> {
  /** ① 切片。复用既有的中文语义切片器，不另写一套 */
  const pieces = chunkDocument(content);
  if (pieces.length === 0) {
    return fail(
      "VALIDATION_FAILED",
      "索引知识失败：没有可检索的切片",
      "正文过短或不含可分块内容。建立一份「文档存在但没有任何可检索内容」的知识，只会在检索里制造困惑，因此直接拒绝。",
    );
  }

  /** ② 受控并发地向量化。禁止 100 个切片一次性全发 */
  const batches = toBatches(pieces, deps.config.embeddingBatchSize);
  const embedded = await attempt(
    () =>
      mapWithConcurrency(batches, deps.config.embeddingConcurrency, (batch) =>
        deps.provider.embed({
          values: batch.map((piece) => piece.content),
          ...(deps.signal ? { signal: deps.signal } : {}),
        }),
      ),
    /**
     * 这里保住 Provider 自己给出的错误码：模型超时 / 限流 / 不可用
     * 对调用方意味着完全不同的处置（等一会儿重试 / 降速 / 换模型），
     * 一律塌成「向量化失败」会让排查从「看一眼错误码」变成「翻日志」。
     */
    (cause) => toAppError(cause, "MODEL_UNAVAILABLE", "知识向量化失败"),
  );
  if (!embedded.ok) {
    return embedded;
  }

  /**
   * ③ 逐条硬校验。
   *
   * 维度不对、含 NaN / Infinity 一律**拒绝整个索引**，
   * 绝不截断、绝不补零、绝不「过滤掉坏的那条再存剩下的」。
   * 坏向量不会报错，它只会让检索结果悄悄变差 —— 而这种「变差」
   * 没有任何人能定位到根因。宁可这次索引失败得明明白白。
   */
  const chunks: IndexedKnowledgeChunkInput[] = [];
  for (const [batchIndex, batch] of batches.entries()) {
    const vectors = embedded.data[batchIndex] ?? [];
    if (vectors.length !== batch.length) {
      return fail(
        "MODEL_UNAVAILABLE",
        "知识向量化失败：返回的向量数量与请求不一致",
        `第 ${batchIndex + 1} 批请求 ${batch.length} 条，返回 ${vectors.length} 条。`,
      );
    }

    for (const [offset, piece] of batch.entries()) {
      const vector = vectors[offset];
      if (!vector) {
        return fail(
          "MODEL_UNAVAILABLE",
          "知识向量化失败：缺少向量",
          `chunkIndex=${piece.index} 没有拿到向量（第 ${batchIndex + 1} 批第 ${offset + 1} 条）。`,
        );
      }
      // 长度先取出来：isEmbeddingVector 是类型谓词，取反分支会把 vector 收窄成 never
      const vectorLength = vector.length;
      if (!isEmbeddingVector(vector)) {
        return fail(
          "VALIDATION_FAILED",
          "知识向量化失败：向量维度不合法",
          `chunkIndex=${piece.index} 的向量应为 ${EMBEDDING_DIMENSIONS} 维且全为有限数，实际 ${vectorLength} 维（第 ${batchIndex + 1} 批第 ${offset + 1} 条）。禁止截断或补齐。`,
        );
      }
      chunks.push({
        chunkIndex: piece.index,
        content: piece.content,
        section: piece.section,
        start: piece.start,
        end: piece.end,
        embedding: vector,
      });
    }
  }

  return ok({ chunks });
}

/* ------------------------------------------------------------------ */
/* 输入校验                                                            */
/* ------------------------------------------------------------------ */

/**
 * 统一校验。
 *
 * 商品归属这一条单独说明：领域类型 `Product` 不带商家字段，
 * 因此判断只能问仓储（`belongsToBusiness`）。这不是「多查一次」的浪费 ——
 * 挂错商家的知识会被另一个商家的消费者检索到，而且不会报错。
 */
async function validateKnowledgeInput(
  input: KnowledgeDocumentInput,
): Promise<Result<ValidatedKnowledgeInput>> {
  const businessId = input.businessId?.trim() ?? "";
  if (businessId.length === 0) {
    return fail(
      "VALIDATION_FAILED",
      "保存知识文档失败：缺少商家标识",
      "businessId 为空。知识按商家隔离，无法在没有商家的情况下写入。",
    );
  }

  const name = input.name?.trim() ?? "";
  if (name.length === 0) {
    return fail(
      "VALIDATION_FAILED",
      "保存知识文档失败：文档名不能为空",
      `name=${JSON.stringify(input.name)}`,
    );
  }

  if (!isKnowledgeDocumentType(input.type)) {
    return fail(
      "VALIDATION_FAILED",
      "保存知识文档失败：知识类型不合法",
      `type=${JSON.stringify(input.type)}，可选值：${KNOWLEDGE_DOCUMENT_TYPES.join(" / ")}`,
    );
  }

  /**
   * 正文只有空白 → 拒绝，而且**在调用模型之前**拒绝。
   * 任务书第三十节 Case 14 要求「空正文不调用 Embedding、不写任何数据」：
   * 一次注定失败的模型调用既浪费时间也浪费额度。
   */
  const content = input.content?.trim() ?? "";
  if (content.length === 0) {
    return fail(
      "VALIDATION_FAILED",
      "保存知识文档失败：正文不能为空",
      "正文为空或只有空白字符。知识必须有可检索的内容。",
    );
  }

  const productId = input.productId ?? null;
  if (productId !== null && productId !== "") {
    const owned = await attempt(
      () => getRepositories().products.belongsToBusiness(businessId, productId),
      (cause) => toAppError(cause, "DB_ERROR", "校验商品归属失败"),
    );
    if (!owned.ok) {
      return owned;
    }
    if (!owned.data) {
      return fail(
        "VALIDATION_FAILED",
        "保存知识文档失败：关联商品不属于当前商家",
        `businessId=${businessId} productId=${productId}。禁止跨商家挂载商品。`,
      );
    }
  }

  return ok({
    businessId,
    productId: productId === "" ? null : productId,
    name,
    type: input.type,
    /**
     * 存 trim 后的正文，而不是原始输入。
     *
     * 不只是「好看」：`chunkDocument` 内部会对文本做换行归一与首尾 trim，
     * 切片上的 `start` / `end` 是相对**归一化后**的文本算出来的。
     * 若把原始文本（可能带首尾空行）存进文档，那些偏移量就不再对得上，
     * 「回溯原文」这个能力会静默失效。
     */
    content,
    summary: input.summary?.trim() ?? "",
    source: input.source ?? "manual",
  });
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

/**
 * 按 id 读一份文档。
 *
 * 不存在返回 `NOT_FOUND` 而不是 `ok(null)`：调用方的 id 几乎总来自 URL 或页面参数，
 * 「没有」就是「这个链接坏了」，让它表现成 404 比让它表现成空白页更诚实。
 */
export async function getKnowledgeDocument(
  id: string,
): Promise<Result<KnowledgeDocument>> {
  const documentId = id?.trim() ?? "";
  if (documentId.length === 0) {
    return fail("VALIDATION_FAILED", "加载知识文档失败：缺少文档标识", "documentId 为空");
  }

  const loaded = await attempt(
    () => getRepositories().knowledgeDocuments.getDocumentById(documentId),
    (cause) => toAppError(cause, "DB_ERROR", "加载知识文档失败"),
  );
  if (!loaded.ok) {
    return loaded;
  }
  if (!loaded.data) {
    return fail("NOT_FOUND", "知识文档不存在", `documentId=${documentId}`);
  }
  return ok(loaded.data);
}

export async function listKnowledgeDocuments(
  filter?: KnowledgeDocumentFilter,
): Promise<Result<KnowledgeDocument[]>> {
  return attempt(
    () => getRepositories().knowledgeDocuments.findDocuments(filter),
    (cause) => toAppError(cause, "DB_ERROR", "加载知识文档失败"),
  );
}

/* ------------------------------------------------------------------ */
/* 写入：创建 / 更新 / 重建 / 删除                                      */
/* ------------------------------------------------------------------ */

/**
 * 创建一份知识文档并立即建好索引。
 *
 * 三条顺序上的要求：
 * 1. 校验 → 切片 → 向量化**全部成功**，才有资格碰数据库；
 * 2. 文档与它的切片在**同一个事务**里落盘（仓储的 `createIndexedDocument`）；
 * 3. 成功返回时文档已经是 `indexed`，可以立刻被检索到 ——
 *    不需要重启进程、不需要刷新缓存。
 *
 * 任何一步失败的结果都是「0 文档、0 切片」，不存在半成品。
 */
export async function createKnowledgeDocument(
  input: KnowledgeDocumentInput,
  options: KnowledgeServiceOptions = {},
): Promise<Result<KnowledgeDocument>> {
  const validated = await validateKnowledgeInput(input);
  if (!validated.ok) {
    return validated;
  }
  const value = validated.data;

  const built = await buildKnowledgeIndexCandidate(
    value.content,
    resolveIndexDeps(options),
  );
  if (!built.ok) {
    return built;
  }

  return attempt(
    () =>
      getRepositories().knowledgeDocuments.createIndexedDocument({
        businessId: value.businessId,
        productId: value.productId,
        name: value.name,
        type: value.type,
        source: value.source,
        summary: value.summary,
        content: value.content,
        chunks: built.data.chunks,
      }),
    (cause) => toAppError(cause, "DB_ERROR", "保存知识文档失败"),
  );
}

/**
 * 更新文档并重建索引。
 *
 * 关键顺序：**新的索引构建成功之后，才在事务里替换旧的**。
 * 因此「新正文的向量算不出来」时，老文档与老切片仍然完整可用 ——
 * 检索照旧命中旧内容，而不是变成一份查不到任何东西的知识。
 *
 * 关于「正文没变就不重新 Embedding」这个优化（任务书第二十六节）：
 * 第一版**刻意不做**。要把它做对，得先严格证明「影响索引的字段一个都没变」——
 * 而 `type` / `productId` 都会进切片（`sourceType` / 归属字段就在切片行上），
 * 漏判一个就会出现「文档显示的是新内容、向量还是旧的」，且永远不会自愈。
 * 重新索引一份文档只是几次 embed 调用，这个代价远小于上面那种错误。
 */
export async function updateKnowledgeDocument(
  id: string,
  patch: KnowledgeDocumentPatch,
  options: KnowledgeServiceOptions = {},
): Promise<Result<KnowledgeDocument>> {
  const loaded = await getKnowledgeDocument(id);
  if (!loaded.ok) {
    return loaded;
  }
  const current = loaded.data;

  /** 先合并成一份完整输入再校验：这样「改完之后是否仍然合法」才是被检查的东西 */
  const merged: KnowledgeDocumentInput = {
    businessId: current.businessId,
    productId: patch.productId !== undefined ? patch.productId : current.productId,
    name: patch.name ?? current.name,
    type: patch.type ?? current.type,
    content: patch.content ?? current.content,
    summary: patch.summary ?? current.summary,
    source: current.source,
  };

  const validated = await validateKnowledgeInput(merged);
  if (!validated.ok) {
    return validated;
  }
  const value = validated.data;

  const built = await buildKnowledgeIndexCandidate(
    value.content,
    resolveIndexDeps(options),
  );
  if (!built.ok) {
    return built;
  }

  return attempt(
    () =>
      getRepositories().knowledgeDocuments.replaceDocumentIndex(
        current.id,
        {
          /**
           * 把**合并后的全部字段**交给仓储，而不是只传 patch 里出现过的那些。
           * 原因是切片上的 `sourceType` / 归属字段是从文档行推导的：
           * 文档更新到什么值，切片就跟着变成什么值。
           * 只传一部分会让「用来切片的正文」与「存进文档的正文」
           * 在某一类调用下悄悄分叉。
           */
          name: value.name,
          type: value.type,
          summary: value.summary,
          content: value.content,
          productId: value.productId,
        },
        built.data.chunks,
      ),
    (cause) => toAppError(cause, "DB_ERROR", "更新知识文档失败"),
  );
}

/**
 * 重建索引。
 *
 * 使用场景：换 Embedding 模型、改切片规则、手工重算、修一次失败的索引。
 * **文档 id 不变、不新建文档**：引用快照指向的是 documentId，
 * 重建时换一个 id 会让「当时引用的是哪份文档」全部失联。
 * 切片的替换是原子的，因此重建过程中检索不会看到「半新半旧」的向量。
 */
export async function reindexKnowledgeDocument(
  id: string,
  options: KnowledgeServiceOptions = {},
): Promise<Result<KnowledgeDocument>> {
  const loaded = await getKnowledgeDocument(id);
  if (!loaded.ok) {
    return loaded;
  }
  const document = loaded.data;

  const built = await buildKnowledgeIndexCandidate(
    document.content,
    resolveIndexDeps(options),
  );
  if (!built.ok) {
    return built;
  }

  /** patch 传空对象：重建索引不改任何文档字段，只换切片 */
  return attempt(
    () =>
      getRepositories().knowledgeDocuments.replaceDocumentIndex(
        document.id,
        {},
        built.data.chunks,
      ),
    (cause) => toAppError(cause, "DB_ERROR", "重建知识索引失败"),
  );
}

export interface EnsureKnowledgeIndexedResult {
  document: KnowledgeDocument;
  /** 本次调用是否真的重建了索引；false = 索引已是当前版本，没有重复 Embedding */
  rebuilt: boolean;
}

/**
 * 幂等地保证一份文档「已被当前版本的索引覆盖」。
 *
 * 与 `reindexKnowledgeDocument` 的差别：后者**无条件重建**（适用于商家
 * 手动点「重新索引」），本函数先检查再决定 —— 这是 Demo 种子自动索引
 * （任务书 §19）的关键：第一次调用建索引，之后的每次调用都只是
 * 一次廉价的状态检查，**不做任何 Embedding**。
 *
 * 判定「索引已最新」的条件缺一不可：
 * - 文档状态是 `indexed`（不是 pending / failed）；
 * - 存在切片（`indexed` 但 0 切片是 Task 79 之前的旧数据形态）；
 * - 每条切片的 `metadata.indexVersion` 都是当前版本 —— 切片规则或
 *   Embedding 流水线升级后，旧切片会带着旧版本号留在这里，
 *   这正是「需要重建」的信号。
 *
 * 切片读取失败时按「需要重建」处理：宁可多一次 Embedding，
 * 也不让一份带着过期向量的知识继续冒充最新。
 */
export async function ensureKnowledgeIndexed(
  id: string,
  options: KnowledgeServiceOptions = {},
): Promise<Result<EnsureKnowledgeIndexedResult>> {
  const loaded = await getKnowledgeDocument(id);
  if (!loaded.ok) {
    return loaded;
  }
  const document = loaded.data;

  if (document.indexStatus === "indexed" && document.chunkCount > 0) {
    const chunks = await attempt(
      () => getRepositories().knowledgeChunks.listByDocument(document.id),
      (cause) => toAppError(cause, "DB_ERROR", "读取知识切片失败"),
    );
    if (
      chunks.ok &&
      chunks.data.length > 0 &&
      chunks.data.every(
        (chunk) => chunk.metadata.indexVersion === KNOWLEDGE_INDEX_VERSION,
      )
    ) {
      return ok({ document, rebuilt: false });
    }
  }

  const rebuilt = await reindexKnowledgeDocument(id, options);
  if (!rebuilt.ok) {
    return rebuilt;
  }
  return ok({ document: rebuilt.data, rebuilt: true });
}

/**
 * 删除文档。切片随之清除 —— 由数据库的 `ON DELETE CASCADE` 保证，
 * Mock 实现里由 `removeStoredKnowledgeDocument` 显式做同一件事。
 * 不在应用层再删一次：两处都写，早晚有一处会被改漏。
 */
export async function deleteKnowledgeDocument(
  id: string,
): Promise<Result<void>> {
  const documentId = id?.trim() ?? "";
  if (documentId.length === 0) {
    return fail("VALIDATION_FAILED", "删除知识文档失败：缺少文档标识", "documentId 为空");
  }

  return attempt(
    async () => {
      await getRepositories().knowledgeDocuments.deleteDocument(documentId);
      return undefined;
    },
    (cause) => toAppError(cause, "DB_ERROR", "删除知识文档失败"),
  );
}

/* ------------------------------------------------------------------ */
/* 知识缺口闭环                                                        */
/* ------------------------------------------------------------------ */

export type KnowledgeGapWarningCode = "knowledge_gap_resolve_failed";

export interface CreateKnowledgeForGapInput
  extends Omit<KnowledgeDocumentInput, "productId"> {
  /**
   * 覆盖缺口上的商品归属。
   *
   * 不传时**沿用缺口自己的商品**：一条「鲍鱼怎么保存」的缺口，
   * 补出来的知识理应挂在鲍鱼上，而不是变成全店级知识 ——
   * 后者会让它出现在所有商品的检索结果里，稀释别的问题的依据排序。
   */
  productId?: string | null;
}

export interface CreateKnowledgeForGapResult {
  document: KnowledgeDocument;
  /** 索引成功且缺口状态也标记成功后的缺口；标记失败时为 null（缺口仍是 open） */
  gap: KnowledgeGapRecord | null;
  warningCodes: KnowledgeGapWarningCode[];
  warnings: string[];
}

/**
 * 「补一份知识来解决这条缺口」。
 *
 * 顺序不可颠倒：**索引先成功，才允许标记缺口已解决**。
 * 反过来（先标 resolved 再索引）会出现「缺口显示已解决、但同一个问题
 * 依然答不上来」—— 而商家看到已解决就不会再管它了。
 *
 * ## 为什么缺口标记失败不回滚知识
 *
 * 文档与切片写成功之后，这份知识**已经是有效的企业资产**：
 * 它能被检索到、能被引用、能回答别的问题。为了一个状态标记去把它删掉，
 * 等于用「一个记账动作没完成」毁掉「一次真实的知识沉淀」。
 *
 * 所以这里降级为告警：知识保留，返回成功，`warningCodes` 里留下
 * `knowledge_gap_resolve_failed`，缺口继续 open，商家可以稍后重新标记。
 * 禁止把已经索引成功的知识回滚掉。
 */
export async function createKnowledgeForGap(
  gapId: string,
  input: CreateKnowledgeForGapInput,
  options: KnowledgeServiceOptions = {},
): Promise<Result<CreateKnowledgeForGapResult>> {
  const gap = await getKnowledgeGap(gapId);
  if (!gap.ok) {
    return gap;
  }

  /**
   * 缺口必须属于同一个商家。
   *
   * 这里返回 `NOT_FOUND` 而不是 `VALIDATION_FAILED`：对调用方而言，
   * 「这条缺口不是你的」与「这条缺口不存在」应当无法区分 ——
   * 否则可以靠错误码的差异探测出别的商家的缺口 id 是否存在。
   */
  const businessId = input.businessId?.trim() ?? "";
  if (gap.data.businessId !== businessId) {
    return fail(
      "NOT_FOUND",
      "知识缺口记录不存在",
      `gapId=${gapId} 不属于 businessId=${businessId}`,
    );
  }

  const created = await createKnowledgeDocument(
    {
      ...input,
      businessId,
      productId: input.productId !== undefined ? input.productId : gap.data.productId,
    },
    options,
  );
  if (!created.ok) {
    return created;
  }

  const resolved = await resolveKnowledgeGap(gap.data.id, created.data.id);
  if (!resolved.ok) {
    return ok({
      document: created.data,
      gap: null,
      warningCodes: ["knowledge_gap_resolve_failed"],
      warnings: [
        `知识已建立并索引成功，但缺口状态未能标记为已解决：${resolved.error.message}${
          resolved.error.detail ? `（${resolved.error.detail}）` : ""
        }`,
      ],
    });
  }

  return ok({
    document: created.data,
    gap: resolved.data,
    warningCodes: [],
    warnings: [],
  });
}
