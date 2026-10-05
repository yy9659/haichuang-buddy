/**
 * 知识生命周期 Service 单测（S5 · Task 79）
 *
 * 覆盖任务书第三十节的 Case 1–14、第三十一节的真实链路、第三十二节的 DB 集成测试入口。
 *
 * 这组用例的重心不是「能不能建出一份知识」，而是**失败时留下了什么**。
 * 索引是一条会部分完成的流水线（切片 → 向量 → 落库），
 * 任何一处失败都可能留下难以察觉的残骸：文档在而切片不在、
 * 旧切片被删而新切片没写进去、维度不对的向量悄悄进了库。
 * 这些状态都不会报错，只会让「检索明明该命中却没有命中」变成一个无法解释的现象。
 *
 * 因此每条失败用例都断言两件事：**返回了正确的错误码**，
 * 以及**数据库里什么都没变**。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import type { AIProvider } from "@/ai/provider/types";
import { EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import { resetServerEnvCache } from "@/lib/env";
import { MOCK_BUSINESS } from "@/lib/mock";
import { AppError } from "@/lib/result";
import { chunkDocument } from "@/rag/chunking";
import { retrieveRelevantChunks } from "@/rag/retriever";
import { createMockKnowledgeChunkRepository } from "@/repositories/mock/knowledge";
import {
  listStoredKnowledgeChunks,
  listStoredKnowledgeDocuments,
  listStoredKnowledgeGaps,
  resetStoredKnowledge,
} from "@/repositories/mock/store";

import { recordKnowledgeGap } from "./knowledge-gap.service";
import {
  KNOWLEDGE_INDEX_CONFIG,
  createKnowledgeDocument,
  createKnowledgeForGap,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
  updateKnowledgeDocument,
} from "./knowledge.service";

/**
 * 先归一化环境再取仓储：`getRepositories()` 在 DATA_SOURCE=db 且缺少连接串时
 * 会直接抛错，放在模块顶层就会让整个测试文件加载失败。
 */
process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

const BUSINESS_ID = MOCK_BUSINESS.id;

/**
 * 模拟「缺口状态更新失败」。
 *
 * 与 Task 78 的处理方式一致：不做「给服务加一个测试专用开关」——
 * 那个开关只活在测试里，会让被验证的代码路径与生产路径不是同一条。
 * 这里只替换仓储的**一个方法**，服务的降级逻辑照常真实执行。
 */
const gapStatusFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("@/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/repositories")>();
  return {
    ...actual,
    getRepositories: () => {
      const repositories = actual.getRepositories();
      if (!gapStatusFailure.enabled) {
        return repositories;
      }
      return {
        ...repositories,
        knowledgeGaps: {
          ...repositories.knowledgeGaps,
          updateStatus: async () => {
            throw new Error("模拟：缺口状态更新失败");
          },
        },
      };
    },
  };
});

/* ------------------------------------------------------------------ */
/* 测试辅助                                                            */
/* ------------------------------------------------------------------ */

interface FakeProvider {
  provider: AIProvider;
  /** 每次 embed 调用收到的文本（按调用顺序） */
  calls: string[][];
  embedCallCount(): number;
  /** 观测到的最大同时在飞请求数 */
  maxActive(): number;
}

/**
 * 在真实 Mock Provider 外面套一层观测壳。
 *
 * 保留 `id: "mock"`，因此检索档位与真实 Mock 完全一致 ——
 * 换成一个 id 不同的假 Provider，检索阈值会切到 real 档位，
 * 于是这组用例验证的东西就不是生产路径了。
 *
 * 内部刻意让出一轮事件循环：不做这件事，并发的几个调用会在
 * 同一个 tick 里全部 `await` 到「已完成」的 Promise，
 * 观测到的 maxActive 永远是 1 —— 并发上限的断言会毫无意义地恒真。
 */
function createFakeProvider(
  override?: (input: { values: string[]; callIndex: number }) => Promise<number[][]>,
): FakeProvider {
  const inner = createMockAIProvider();
  const calls: string[][] = [];
  let active = 0;
  let maxActive = 0;

  const provider: AIProvider = {
    ...inner,
    async embed(input) {
      const callIndex = calls.length;
      calls.push([...input.values]);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (override) {
          return await override({ values: input.values, callIndex });
        }
        return await inner.embed(input);
      } finally {
        active -= 1;
      }
    },
  };

  return {
    provider,
    calls,
    embedCallCount: () => calls.length,
    maxActive: () => maxActive,
  };
}

/** 一份带标题的短知识（切出来 1 个切片，便于断言「旧切片是否残留」） */
function storageDocument(temperature: string): string {
  return `鲍鱼储存说明

储存温度

鲜活鲍鱼请冷藏保存，最佳温度为 ${temperature}，建议在 48 小时内食用。`;
}

const LOGISTICS_CONTENT = `发货与物流说明

发货时间

每日 16:00 前下单，当天安排发出。16:00 之后下单，顺延到第二天发出。

配送时效

福建省内通常次日送达，华东与华南地区次日到隔日送达。偏远地区顺延一到两天。`;

/** 造一份至少能切出 `target` 个切片的正文 */
function documentWithChunks(target: number): string {
  const paragraph = (index: number): string =>
    `第 ${index} 条说明：这一段用于验证索引流程的批量与并发行为，内容长度接近一整个切片窗口，` +
    `包含温度、时间与处理方式的描述。第 ${index} 条说明的补充内容继续延长这段文字，确保它不会被并入上一段。`;

  let count = 1;
  let content = paragraph(1);
  while (chunkDocument(content).length < target) {
    count += 1;
    if (count > 4000) {
      throw new Error("无法生成足够长的测试正文");
    }
    content = Array.from({ length: count }, (_, index) => paragraph(index + 1)).join("\n\n");
  }
  return content;
}

/** 某个文档当前的切片（含向量，便于断言维度） */
function storedChunksOf(documentId: string) {
  return listStoredKnowledgeChunks().filter((chunk) => chunk.documentId === documentId);
}

/** 按名字找文档；不存在返回 undefined */
function documentNamed(name: string) {
  return listStoredKnowledgeDocuments().find((document) => document.name === name);
}

/** 走真实检索层查一遍（证明「建完立即可检索」，不需要重启进程或刷缓存） */
async function retrieve(query: string) {
  return retrieveRelevantChunks(
    { query, businessId: BUSINESS_ID, productId: null },
    {
      provider: createMockAIProvider(),
      search: (params) => createMockKnowledgeChunkRepository().searchSimilar(params),
    },
  );
}

async function createStorage(
  temperature: string,
  name = "鲍鱼储存说明",
): Promise<string> {
  const created = await createKnowledgeDocument({
    businessId: BUSINESS_ID,
    name,
    type: "storage",
    content: storageDocument(temperature),
  });
  if (!created.ok) {
    throw new Error(`建立测试知识失败：${created.error.message}`);
  }
  return created.data.id;
}

beforeEach(() => {
  resetStoredKnowledge();
  gapStatusFailure.enabled = false;
});

/* ------------------------------------------------------------------ */
/* Case 1：创建知识并立即可检索                                          */
/* ------------------------------------------------------------------ */

describe("Case 1：创建知识", () => {
  it("文档与切片同时落盘，向量为 1024 维，且立刻可被检索到", async () => {
    const result = await createKnowledgeDocument({
      businessId: BUSINESS_ID,
      name: "鲍鱼储存说明",
      type: "storage",
      summary: "鲜活鲍鱼的冷藏温度与食用时限",
      content: storageDocument("0-4℃"),
    });

    if (!result.ok) {
      throw new Error(`创建知识失败：${result.error.message}`);
    }

    // ① 文档：1 条，状态直接是 indexed（切片与文档同事务写入，没有中间态）
    expect(result.data.name).toBe("鲍鱼储存说明");
    expect(result.data.indexStatus).toBe("indexed");
    expect(result.data.indexError).toBeNull();
    expect(result.data.chunkCount).toBeGreaterThan(0);
    expect(
      listStoredKnowledgeDocuments().filter((item) => item.name === "鲍鱼储存说明"),
    ).toHaveLength(1);

    // ② 切片：> 0，向量维度正确，元数据带上了索引版本与章节
    const chunks = storedChunksOf(result.data.id);
    expect(chunks.length).toBe(result.data.chunkCount);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(chunk.metadata.documentName).toBe("鲍鱼储存说明");
      expect(chunk.metadata.indexVersion).toBeDefined();
    }

    // ③ 检索：不需要重启、不需要重建索引，立刻命中
    const retrieval = await retrieve("鲍鱼怎么保存比较好？");
    if (!retrieval.ok) {
      throw new Error(`检索失败：${retrieval.error.message}`);
    }
    expect(retrieval.data.hits.length).toBeGreaterThan(0);
    expect(retrieval.data.sufficient).toBe(true);
    expect(retrieval.data.hits[0]?.documentId).toBe(result.data.id);
  });

  it("同一商家下重名文档被拒绝（唯一键冲突走同一条出口）", async () => {
    await createStorage("0-4℃");

    const duplicated = await createKnowledgeDocument({
      businessId: BUSINESS_ID,
      name: "鲍鱼储存说明",
      type: "storage",
      content: storageDocument("2-6℃"),
    });

    expect(duplicated.ok).toBe(false);
    expect(!duplicated.ok && duplicated.error.code).toBe("DB_ERROR");
    // 失败之后切片不能多出来
    expect(
      listStoredKnowledgeDocuments().filter((item) => item.name === "鲍鱼储存说明"),
    ).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Case 2–5：索引失败必须「什么都没留下」                                */
/* ------------------------------------------------------------------ */

describe("Case 2–5：索引失败不落库", () => {
  it("Case 2：模型整体失败 → 0 文档、0 切片", async () => {
    const fake = createFakeProvider(async () => {
      throw new AppError({
        code: "MODEL_UNAVAILABLE",
        message: "模型服务暂时不可用",
        detail: "上游返回 503",
      });
    });

    const result = await createKnowledgeDocument(
      {
        businessId: BUSINESS_ID,
        name: "鲍鱼储存说明",
        type: "storage",
        content: storageDocument("0-4℃"),
      },
      { provider: fake.provider },
    );

    expect(result.ok).toBe(false);
    // Provider 自己的错误码被原样保留 —— 超时 / 限流 / 不可用意味着不同的处置
    expect(!result.ok && result.error.code).toBe("MODEL_UNAVAILABLE");
    expect(documentNamed("鲍鱼储存说明")).toBeUndefined();
    expect(listStoredKnowledgeChunks()).toHaveLength(0);
  });

  it("Case 3：前几个切片成功、中间一个失败 → 仍然 0 文档、0 切片", async () => {
    // 一批一条，让「第 3 条失败」这件事可以被精确定位
    const fake = createFakeProvider(async ({ callIndex }) => {
      if (callIndex === 1) {
        throw new AppError({
          code: "MODEL_TIMEOUT",
          message: "模型响应超时",
          detail: "请求超过 90s 未返回",
        });
      }
      return createMockAIProvider().embed({ values: ["占位"] });
    });

    const content = documentWithChunks(4);
    expect(chunkDocument(content).length).toBeGreaterThanOrEqual(3);

    const result = await createKnowledgeDocument(
      { businessId: BUSINESS_ID, name: "长文档", type: "faq", content },
      { provider: fake.provider, config: { embeddingBatchSize: 1 } },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("MODEL_TIMEOUT");
    // 已经成功算出来的那几批向量，一条都不许留下
    expect(documentNamed("长文档")).toBeUndefined();
    expect(listStoredKnowledgeChunks()).toHaveLength(0);
  });

  it("Case 4：维度不是 1024 → VALIDATION_FAILED，不得落库", async () => {
    const fake = createFakeProvider(async ({ values }) =>
      values.map(() => new Array(768).fill(0.1)),
    );

    const result = await createKnowledgeDocument(
      {
        businessId: BUSINESS_ID,
        name: "鲍鱼储存说明",
        type: "storage",
        content: storageDocument("0-4℃"),
      },
      { provider: fake.provider },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
    expect(!result.ok && result.error.detail).toContain("768");
    // 明确禁止截断 / 补齐：库里必须一条都没有
    expect(listStoredKnowledgeChunks()).toHaveLength(0);
    expect(documentNamed("鲍鱼储存说明")).toBeUndefined();
  });

  it("Case 5：向量含 NaN / Infinity → VALIDATION_FAILED，不得落库", async () => {
    const withNaN = createFakeProvider(async ({ values }) =>
      values.map((_, index) => {
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0.1);
        vector[index] = Number.NaN;
        return vector;
      }),
    );

    const nanResult = await createKnowledgeDocument(
      {
        businessId: BUSINESS_ID,
        name: "含 NaN 的知识",
        type: "faq",
        content: storageDocument("0-4℃"),
      },
      { provider: withNaN.provider },
    );
    expect(nanResult.ok).toBe(false);
    expect(!nanResult.ok && nanResult.error.code).toBe("VALIDATION_FAILED");
    expect(listStoredKnowledgeChunks()).toHaveLength(0);

    const withInfinity = createFakeProvider(async ({ values }) =>
      values.map((_, index) => {
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0.1);
        vector[index] = Number.POSITIVE_INFINITY;
        return vector;
      }),
    );

    const infinityResult = await createKnowledgeDocument(
      {
        businessId: BUSINESS_ID,
        name: "含 Infinity 的知识",
        type: "faq",
        content: storageDocument("0-4℃"),
      },
      { provider: withInfinity.provider },
    );
    expect(infinityResult.ok).toBe(false);
    expect(!infinityResult.ok && infinityResult.error.code).toBe("VALIDATION_FAILED");
    expect(listStoredKnowledgeChunks()).toHaveLength(0);
    expect(listStoredKnowledgeDocuments().filter((item) => item.name.includes("含"))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Case 6–8：更新 / 重建                                                */
/* ------------------------------------------------------------------ */

describe("Case 6–8：更新与重建的原子性", () => {
  it("Case 6：更新正文后，检索只找得到新内容，旧切片不残留", async () => {
    const documentId = await createStorage("0-4℃");

    const before = storedChunksOf(documentId);
    expect(before.some((chunk) => chunk.content.includes("0-4"))).toBe(true);

    const updated = await updateKnowledgeDocument(documentId, {
      content: storageDocument("2-6℃"),
    });
    if (!updated.ok) {
      throw new Error(`更新失败：${updated.error.message}`);
    }

    expect(updated.data.id).toBe(documentId); // 文档 id 不变
    expect(updated.data.content).toContain("2-6℃");
    expect(updated.data.indexStatus).toBe("indexed");

    const after = storedChunksOf(documentId);
    expect(after.length).toBe(updated.data.chunkCount);
    expect(after.some((chunk) => chunk.content.includes("2-6"))).toBe(true);
    // 旧切片必须一条都不剩：留着它，检索会把已经删掉的说明当成依据
    expect(after.some((chunk) => chunk.content.includes("0-4"))).toBe(false);

    const retrieval = await retrieve("鲍鱼怎么保存比较好？");
    if (!retrieval.ok) {
      throw new Error(`检索失败：${retrieval.error.message}`);
    }
    expect(retrieval.data.hits[0]?.content).toContain("2-6");
  });

  it("Case 7：更新时 Embedding 失败 → 旧索引仍然完整可用", async () => {
    const documentId = await createStorage("0-4℃");
    const chunksBefore = storedChunksOf(documentId).length;

    const fake = createFakeProvider(async () => {
      throw new AppError({
        code: "MODEL_UNAVAILABLE",
        message: "模型服务暂时不可用",
      });
    });

    const updated = await updateKnowledgeDocument(
      documentId,
      { content: storageDocument("2-6℃") },
      { provider: fake.provider },
    );

    expect(updated.ok).toBe(false);
    expect(!updated.ok && updated.error.code).toBe("MODEL_UNAVAILABLE");

    // 文档仍是旧内容（新正文一行都没进库）
    const loaded = await getKnowledgeDocument(documentId);
    if (!loaded.ok) {
      throw new Error(`加载失败：${loaded.error.message}`);
    }
    expect(loaded.data.content).toContain("0-4");
    expect(loaded.data.content).not.toContain("2-6");

    // 旧切片一条不少、仍然可检索
    const after = storedChunksOf(documentId);
    expect(after).toHaveLength(chunksBefore);
    expect(after.some((chunk) => chunk.content.includes("0-4"))).toBe(true);

    const retrieval = await retrieve("鲍鱼怎么保存比较好？");
    if (!retrieval.ok) {
      throw new Error(`检索失败：${retrieval.error.message}`);
    }
    expect(retrieval.data.hits.some((hit) => hit.documentId === documentId)).toBe(true);
  });

  it("Case 8：连续重建两次，文档仍只有一条、切片不会累积", async () => {
    const documentId = await createStorage("0-4℃");
    const baseline = storedChunksOf(documentId).length;

    const first = await reindexKnowledgeDocument(documentId);
    const second = await reindexKnowledgeDocument(documentId);
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && first.data.id).toBe(documentId);
    expect(second.ok && second.data.id).toBe(documentId);

    // 不重新创建文档：同名的仍只有一条
    expect(
      listStoredKnowledgeDocuments().filter((item) => item.name === "鲍鱼储存说明"),
    ).toHaveLength(1);
    // 切片被替换而不是追加
    expect(storedChunksOf(documentId)).toHaveLength(baseline);
    expect(second.ok && second.data.chunkCount).toBe(baseline);
  });

  it("重建不存在的文档返回 NOT_FOUND，不会顺手造一条新的", async () => {
    const result = await reindexKnowledgeDocument("kdoc_not_exists");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("NOT_FOUND");
    expect(
      listStoredKnowledgeDocuments().filter((item) => item.id === "kdoc_not_exists"),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Case 9：删除                                                        */
/* ------------------------------------------------------------------ */

describe("Case 9：删除", () => {
  it("删除文档后切片一并清除，检索不再返回它", async () => {
    const documentId = await createStorage("0-4℃");
    expect(storedChunksOf(documentId).length).toBeGreaterThan(0);

    const deleted = await deleteKnowledgeDocument(documentId);
    expect(deleted.ok).toBe(true);

    expect(storedChunksOf(documentId)).toHaveLength(0);
    expect(documentNamed("鲍鱼储存说明")).toBeUndefined();

    const loaded = await getKnowledgeDocument(documentId);
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error.code).toBe("NOT_FOUND");

    const retrieval = await retrieve("鲍鱼怎么保存比较好？");
    if (!retrieval.ok) {
      throw new Error(`检索失败：${retrieval.error.message}`);
    }
    expect(retrieval.data.hits.some((hit) => hit.documentId === documentId)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Case 10：Embedding 并发上限                                          */
/* ------------------------------------------------------------------ */

describe("Case 10：Embedding 并发受控", () => {
  it("同时在飞的 embed 调用数不超过配置上限，且确实发生了并行", async () => {
    const target = KNOWLEDGE_INDEX_CONFIG.embeddingBatchSize * 4;
    const content = documentWithChunks(target);
    const pieces = chunkDocument(content);
    expect(pieces.length).toBeGreaterThanOrEqual(target);

    const fake = createFakeProvider();
    const created = await createKnowledgeDocument(
      { businessId: BUSINESS_ID, name: "长文档", type: "faq", content },
      { provider: fake.provider },
    );

    if (!created.ok) {
      throw new Error(`创建长文档失败：${created.error.message}`);
    }

    const expectedCalls = Math.ceil(
      pieces.length / KNOWLEDGE_INDEX_CONFIG.embeddingBatchSize,
    );
    // ① 调用次数是「批次数」而不是「切片数」——证明批量生效了
    expect(fake.embedCallCount()).toBe(expectedCalls);
    expect(fake.embedCallCount()).toBeLessThan(pieces.length);
    // ② 上限生效
    expect(fake.maxActive()).toBeLessThanOrEqual(KNOWLEDGE_INDEX_CONFIG.embeddingConcurrency);
    // ③ 反证：真的并行过，而不是退化成串行（否则上限断言恒真）
    expect(fake.maxActive()).toBeGreaterThan(1);
    // ④ 切片一个不少
    expect(storedChunksOf(created.data.id)).toHaveLength(pieces.length);
  });

  it("每次请求携带的文本数不超过批量上限", async () => {
    const fake = createFakeProvider();
    const content = documentWithChunks(KNOWLEDGE_INDEX_CONFIG.embeddingBatchSize * 2);
    await createKnowledgeDocument(
      { businessId: BUSINESS_ID, name: "长文档", type: "faq", content },
      { provider: fake.provider },
    );

    expect(fake.calls.length).toBeGreaterThan(1);
    for (const values of fake.calls) {
      expect(values.length).toBeLessThanOrEqual(KNOWLEDGE_INDEX_CONFIG.embeddingBatchSize);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Case 11–12：知识缺口闭环                                            */
/* ------------------------------------------------------------------ */

describe("Case 11–12：补知识解决缺口", () => {
  async function openLogisticsGap(): Promise<string> {
    const recorded = await recordKnowledgeGap({
      businessId: BUSINESS_ID,
      productId: null,
      question: "多久发货？",
      intent: "logistics",
      reason: "知识库中没有发货时效与物流政策说明。",
    });
    if (!recorded.ok || recorded.data === null) {
      throw new Error("准备缺口失败");
    }
    return recorded.data.id;
  }

  it("Case 11：索引成功后缺口被标记为已解决，并记下是哪份文档补齐的", async () => {
    const gapId = await openLogisticsGap();

    const result = await createKnowledgeForGap(gapId, {
      businessId: BUSINESS_ID,
      name: "发货与物流说明",
      type: "logistics",
      content: LOGISTICS_CONTENT,
    });

    if (!result.ok) {
      throw new Error(`补知识失败：${result.error.message}`);
    }

    expect(result.data.warningCodes).toHaveLength(0);
    expect(result.data.gap?.status).toBe("resolved");
    expect(result.data.gap?.resolvedDocumentId).toBe(result.data.document.id);
    expect(result.data.document.indexStatus).toBe("indexed");
    expect(storedChunksOf(result.data.document.id).length).toBeGreaterThan(0);

    const stored = listStoredKnowledgeGaps().find((gap) => gap.id === gapId);
    expect(stored?.status).toBe("resolved");
    expect(stored?.resolvedDocumentId).toBe(result.data.document.id);
  });

  it("缺口上的商品归属会被沿用（商品级缺口补出来的知识不会变成全店知识）", async () => {
    const recorded = await recordKnowledgeGap({
      businessId: BUSINESS_ID,
      productId: "prod_001",
      question: "鲍鱼怎么保存？",
      intent: "storage",
      reason: "缺少该商品的保存说明。",
    });
    if (!recorded.ok || recorded.data === null) {
      throw new Error("准备缺口失败");
    }

    const result = await createKnowledgeForGap(recorded.data.id, {
      businessId: BUSINESS_ID,
      name: "活鲍暂养与保存说明",
      type: "storage",
      content: storageDocument("0-4℃"),
    });

    if (!result.ok) {
      throw new Error(`补知识失败：${result.error.message}`);
    }
    expect(result.data.document.productId).toBe("prod_001");
    for (const chunk of storedChunksOf(result.data.document.id)) {
      expect(chunk.productId).toBe("prod_001");
    }
  });

  it("Case 12：知识建立成功但缺口标记失败 → 知识保留、缺口仍 open、返回告警", async () => {
    const gapId = await openLogisticsGap();
    gapStatusFailure.enabled = true;

    const result = await createKnowledgeForGap(gapId, {
      businessId: BUSINESS_ID,
      name: "发货与物流说明",
      type: "logistics",
      content: LOGISTICS_CONTENT,
    });

    // ① 整体仍然成功：一次成功的知识沉淀不该被一个记账动作毁掉
    if (!result.ok) {
      throw new Error(`期望成功，实际失败：${result.error.code} ${result.error.message}`);
    }

    // ② 知识与切片都在，而且可检索
    expect(result.data.document.indexStatus).toBe("indexed");
    expect(storedChunksOf(result.data.document.id).length).toBeGreaterThan(0);
    const retrieval = await retrieve("下单后多久发货？");
    if (!retrieval.ok) {
      throw new Error(`检索失败：${retrieval.error.message}`);
    }
    expect(retrieval.data.hits.some((hit) => hit.documentId === result.data.document.id)).toBe(
      true,
    );

    // ③ 缺口没被标记成功：仍然是 open，resolvedDocumentId 为空
    expect(result.data.gap).toBeNull();
    expect(result.data.warningCodes).toContain("knowledge_gap_resolve_failed");
    expect(result.data.warnings.join("|")).toContain("缺口状态未能标记");
    const stored = listStoredKnowledgeGaps().find((gap) => gap.id === gapId);
    expect(stored?.status).toBe("open");
    expect(stored?.resolvedDocumentId).toBeNull();
  });

  it("缺口不存在时返回 NOT_FOUND，不会凭空建出知识", async () => {
    const result = await createKnowledgeForGap("gap_not_exists", {
      businessId: BUSINESS_ID,
      name: "发货与物流说明",
      type: "logistics",
      content: LOGISTICS_CONTENT,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("NOT_FOUND");
    expect(documentNamed("发货与物流说明")).toBeUndefined();
    expect(listStoredKnowledgeChunks()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Case 13：跨商家挂商品                                                */
/* ------------------------------------------------------------------ */

describe("Case 13：商品归属校验", () => {
  it("把内置商家的商品挂到别的商家名下 → VALIDATION_FAILED，不写入", async () => {
    const result = await createKnowledgeDocument({
      businessId: "biz_other",
      productId: "prod_001",
      name: "抢来的鲍鱼说明",
      type: "storage",
      content: storageDocument("0-4℃"),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
    expect(!result.ok && result.error.message).toContain("不属于当前商家");
    expect(documentNamed("抢来的鲍鱼说明")).toBeUndefined();
    expect(listStoredKnowledgeChunks()).toHaveLength(0);
  });

  it("商品不存在同样被拒绝", async () => {
    const result = await createKnowledgeDocument({
      businessId: BUSINESS_ID,
      productId: "prod_not_exists",
      name: "幽灵商品说明",
      type: "storage",
      content: storageDocument("0-4℃"),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
  });

  it("归属正确时正常写入，商品归属会落到每一个切片上", async () => {
    const result = await createKnowledgeDocument({
      businessId: BUSINESS_ID,
      productId: "prod_001",
      name: "商品级储存说明",
      type: "storage",
      content: storageDocument("0-4℃"),
    });

    if (!result.ok) {
      throw new Error(`期望成功，实际失败：${result.error.message}`);
    }
    expect(result.data.productId).toBe("prod_001");
    for (const chunk of storedChunksOf(result.data.id)) {
      expect(chunk.productId).toBe("prod_001");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Case 14：空正文与非法类型                                            */
/* ------------------------------------------------------------------ */

describe("Case 14：入参校验必须在调用模型之前", () => {
  it("空正文不调用 Embedding，也不写任何数据", async () => {
    const fake = createFakeProvider();

    const result = await createKnowledgeDocument(
      { businessId: BUSINESS_ID, name: "空文档", type: "faq", content: "" },
      { provider: fake.provider },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
    expect(fake.embedCallCount()).toBe(0);
    expect(documentNamed("空文档")).toBeUndefined();
  });

  it("只有空白字符的正文同样被拒绝", async () => {
    const fake = createFakeProvider();

    const result = await createKnowledgeDocument(
      { businessId: BUSINESS_ID, name: "空白文档", type: "faq", content: "  \n\t  " },
      { provider: fake.provider },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
    expect(fake.embedCallCount()).toBe(0);
  });

  it("非法知识类型被拒绝，且不调用模型", async () => {
    const fake = createFakeProvider();

    const result = await createKnowledgeDocument(
      {
        businessId: BUSINESS_ID,
        name: "类型不对",
        // 故意绕过类型系统：外部输入（表单 / 接口）本来就不受它保护
        type: "not-a-type" as never,
        content: storageDocument("0-4℃"),
      },
      { provider: fake.provider },
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
    expect(fake.embedCallCount()).toBe(0);
  });

  it("文档名为空、缺少商家标识都被拒绝", async () => {
    const emptyName = await createKnowledgeDocument({
      businessId: BUSINESS_ID,
      name: "   ",
      type: "faq",
      content: storageDocument("0-4℃"),
    });
    expect(emptyName.ok).toBe(false);
    expect(!emptyName.ok && emptyName.error.code).toBe("VALIDATION_FAILED");

    const emptyBusiness = await createKnowledgeDocument({
      businessId: "",
      name: "没有商家",
      type: "faq",
      content: storageDocument("0-4℃"),
    });
    expect(emptyBusiness.ok).toBe(false);
    expect(!emptyBusiness.ok && emptyBusiness.error.code).toBe("VALIDATION_FAILED");
    expect(listStoredKnowledgeChunks()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 读取与列表                                                          */
/* ------------------------------------------------------------------ */

describe("读取与列表", () => {
  it("列表返回种子知识（切片为空时 chunkCount 为 0）", async () => {
    const listed = await listKnowledgeDocuments();
    if (!listed.ok) {
      throw new Error(`列表失败：${listed.error.message}`);
    }
    expect(listed.data.length).toBeGreaterThanOrEqual(6);
    expect(listed.data.every((document) => document.indexStatus === "pending")).toBe(true);
    expect(listed.data.every((document) => document.chunkCount === 0)).toBe(true);
  });

  it("按 id 读不存在的文档返回 NOT_FOUND", async () => {
    const loaded = await getKnowledgeDocument("kdoc_missing");
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error.code).toBe("NOT_FOUND");
  });

  it("删除不存在的文档返回 NOT_FOUND", async () => {
    const deleted = await deleteKnowledgeDocument("kdoc_missing");
    expect(deleted.ok).toBe(false);
    expect(!deleted.ok && deleted.error.code).toBe("NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ */
/* 切片元数据                                                          */
/* ------------------------------------------------------------------ */

describe("切片元数据", () => {
  it("落库的切片带上文档名、章节、区间与索引版本", async () => {
    const documentId = await createStorage("0-4℃");
    const chunks = storedChunksOf(documentId);
    const chunk = chunks[0];
    if (!chunk) {
      throw new Error("期望至少有一个切片");
    }

    expect(chunk.metadata.documentName).toBe("鲍鱼储存说明");
    expect(chunk.metadata.sourceType).toBe("storage");
    expect(chunk.metadata.section).toBe("储存温度");
    expect(chunk.metadata.chunkIndex).toBe(0);
    expect(chunk.metadata.end).toBeGreaterThan(chunk.metadata.start);
    expect(chunk.metadata.indexVersion).toBe("rag-v1");
  });
});
