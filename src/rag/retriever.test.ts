/**
 * Retriever 单测（S5 · 任务书第十六 / 十七节）
 *
 * 这套用例的重点是 **hybrid 检索本身**（余弦 + 词面覆盖度），而不是「能不能跑通」：
 * 真实链路的行为已经在 `customer-service-agent.test.ts` 里端到端验过，
 * 这里验的是每一处机制单独拿出来是否成立 —— 阈值按 Provider 分档、
 * 短查询退回纯向量、优先级加成不得影响依据判定、每份文档限量、去重。
 *
 * 全部用**注入的假 Provider + 假 search**：Retriever 的契约就是「你给我向量与候选，
 * 我给你筛好的片段」，因此这里能精确定点地构造出边界情况，
 * 而不用为了造一个「余弦刚好 0.32」的场景去凑文本。
 */

import { describe, expect, it } from "vitest";

import type { AIProvider, EmbedInput } from "@/ai/provider/types";
import { EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import { RETRIEVAL_PROFILES, retrieveRelevantChunks } from "@/rag/retriever";
import type {
  KnowledgeChunkSearchHit,
  KnowledgeSearchParams,
} from "@/repositories/types";
import type { KnowledgeChunk, KnowledgeDocumentType } from "@/types";

const BUSINESS_ID = "biz_demo_001";

/**
 * 只实现 `embed` 的 Provider 桩：`id` 决定生效的检索档位，
 * 其余能力一律抛错 —— 用错了方法必须立刻暴露，而不是悄悄返回 undefined。
 */
function stubProvider(id: string): AIProvider {
  return {
    id,
    async embed(input: EmbedInput): Promise<number[][]> {
      return input.values.map(() => new Array<number>(EMBEDDING_DIMENSIONS).fill(0));
    },
    async generateText() {
      throw new Error("Retriever 不应调用 generateText");
    },
    async generateObject() {
      throw new Error("Retriever 不应调用 generateObject");
    },
    async streamText() {
      throw new Error("Retriever 不应调用 streamText");
    },
    async analyzeImage() {
      throw new Error("Retriever 不应调用 analyzeImage");
    },
  };
}

interface HitSeed {
  id?: string;
  documentId?: string;
  documentName?: string;
  section?: string;
  content: string;
  similarity: number;
  sourceType?: KnowledgeDocumentType;
}

function buildHit(seed: HitSeed, index: number): KnowledgeChunkSearchHit {
  const documentId = seed.documentId ?? `kdoc_${index}`;
  const documentName = seed.documentName ?? `文档 ${index}`;
  const chunk: KnowledgeChunk = {
    id: seed.id ?? `kchunk_${index}`,
    documentId,
    businessId: BUSINESS_ID,
    productId: null,
    sourceType: seed.sourceType ?? "manual",
    title: documentName,
    chunkIndex: 0,
    content: seed.content,
    metadata: {
      documentName,
      sourceType: seed.sourceType ?? "manual",
      productId: null,
      section: seed.section ?? "",
      chunkIndex: 0,
      start: 0,
      end: seed.content.length,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return { chunk, similarity: seed.similarity };
}

async function retrieve(
  query: string,
  seeds: readonly HitSeed[],
  options: {
    id?: string;
    limit?: number;
    sourceTypes?: readonly KnowledgeDocumentType[];
  } = {},
) {
  const calls: KnowledgeSearchParams[] = [];
  const result = await retrieveRelevantChunks(
    {
      query,
      businessId: BUSINESS_ID,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.sourceTypes === undefined
        ? {}
        : { sourceTypes: options.sourceTypes }),
    },
    {
      provider: stubProvider(options.id ?? "mock"),
      async search(params) {
        calls.push(params);
        return seeds.map((seed, index) => buildHit(seed, index));
      },
    },
  );
  if (!result.ok) {
    throw new Error(`期望检索成功，实际失败：${result.error.code} ${result.error.message}`);
  }
  return { data: result.data, calls };
}

describe("Retriever · 档位分派", () => {
  it("按 Provider 选档位，而不是用一套阈值糊弄两种向量空间", () => {
    expect(RETRIEVAL_PROFILES.mock.groundingThreshold).toBeLessThan(
      RETRIEVAL_PROFILES.real.groundingThreshold,
    );
    expect(RETRIEVAL_PROFILES.mock.coverageWeight).toBeGreaterThan(
      RETRIEVAL_PROFILES.real.coverageWeight,
    );
  });

  it("检索请求必须带商家标识，且不带商品过滤时不写成「只要全店」", async () => {
    const { calls } = await retrieve("鲍鱼怎么保存？", []);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.businessId).toBe(BUSINESS_ID);
    // null / undefined 表示「不按商品过滤」，交给仓储解释
    expect(calls[0]!.productId).toBeUndefined();
    // 一次多取一些候选，给重排留出空间
    expect(calls[0]!.limit).toBeGreaterThan(RETRIEVAL_PROFILES.mock.topK);
  });
});

describe("Retriever · 词面覆盖度参与判定", () => {
  it("余弦相同的一对候选，词面覆盖度高的排在前面", async () => {
    const { data } = await retrieve("鲍鱼怎么保存比较好？", [
      {
        content: "本文档介绍礼盒的规格与包装方式，适合作为节庆赠礼。",
        similarity: 0.18,
        documentName: "礼盒说明",
      },
      {
        content: "最佳保存温度为 0-4℃ 冷藏，建议在 48 小时内食用。",
        similarity: 0.18,
        documentName: "鲜活鲍鱼储存说明",
      },
    ]);

    expect(data.hits[0]!.documentName).toBe("鲜活鲍鱼储存说明");
    expect(data.hits[0]!.coverage).toBeGreaterThan(data.hits[1]!.coverage);
    // 综合相关分 = 相似度 + 权重 × 覆盖度，两个分量都要能读到
    expect(data.hits[0]!.relevance).toBeGreaterThan(data.hits[0]!.similarity);
  });

  it("只看余弦会被碰撞底噪带偏：低余弦 + 高覆盖度 能压过高余弦 + 低覆盖度", async () => {
    /**
     * 这组数来自实测：Mock 向量下「鲍鱼怎么保存」对《鲍鱼处理与烹饪指南》
     * 的余弦（0.2116）**高于**对真正讲储存的《鲜活鲍鱼储存说明》（0.1374），
     * 而后者的问题词覆盖率接近 1（含文档名）。只按余弦排序会把答案排到后面。
     */
    const { data } = await retrieve("鲍鱼怎么保存比较好？", [
      { content: "鲍鱼处理并不复杂，熟练之后不到一分钟就能完成一只。", similarity: 0.2116 },
      {
        content: "最佳保存温度为 0-4℃ 冷藏，建议在 48 小时内食用。",
        similarity: 0.1374,
        documentName: "鲜活鲍鱼储存说明",
      },
    ]);

    expect(data.hits[0]!.documentName).toBe("鲜活鲍鱼储存说明");
    expect(data.sufficient).toBe(true);
  });

  it("覆盖度的比较文本包含文档名与章节 —— 标题本身就是这段材料的语义标签", async () => {
    const seeds: HitSeed[] = [
      {
        content: "收到后请立即处理，不要长时间放在常温环境。",
        section: "冷藏要点",
        similarity: 0.1,
        documentName: "鲜活鲍鱼储存说明",
      },
    ];

    const { data } = await retrieve("鲍鱼储存", seeds);
    // 正文里既没有「鲍鱼」也没有「储存」，但文档名里有
    expect(data.hits[0]!.coverage).toBe(1);
  });

  it("查询内容词元太少时不启用稀疏侧，退回纯向量判定", async () => {
    /**
     * 「多久能到？」剥掉虚词后只剩一个「久」字。
     * 若照常算覆盖率，任何偶然含「久」的切片都会拿到 1.0 —— 那是噪声不是信号。
     */
    const { data } = await retrieve("多久能到？", [
      { content: "本文长期有效，久置不影响。", similarity: 0.06 },
    ]);

    expect(data.hits[0]!.coverage).toBe(0);
    expect(data.sufficient).toBe(false);
  });

  it("全是虚词的输入（「在吗」）没有任何词元，覆盖度与判定都为 0", async () => {
    const { data } = await retrieve("在吗？", [
      { content: "鲍鱼怎么保存都可以。", similarity: 0.06 },
    ]);
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0]!.coverage).toBe(0);
    // 没有词面信号时，综合分就等于余弦本身
    expect(data.hits[0]!.relevance).toBeCloseTo(0.06, 6);
    expect(data.sufficient).toBe(false);
  });
});

describe("Retriever · 阈值与过滤", () => {
  it("余弦低于 minSimilarity 的候选直接丢弃，不占用 TopK", async () => {
    const { data } = await retrieve("鲍鱼怎么保存？", [
      { content: "无关内容一", similarity: 0.01 },
      { content: "无关内容二", similarity: 0.04 },
    ]);
    expect(data.hits).toHaveLength(0);
    expect(data.sufficient).toBe(false);
    expect(data.topScore).toBe(0);
  });

  it("sufficient 用的是综合分，报出的阈值与本次档位一致", async () => {
    const { data } = await retrieve("鲍鱼怎么保存？", [
      {
        content: "最佳保存温度为 0-4℃ 冷藏。",
        similarity: 0.06,
        documentName: "鲜活鲍鱼储存说明",
      },
    ]);

    expect(data.threshold).toBe(RETRIEVAL_PROFILES.mock.groundingThreshold);
    // 余弦只有 0.06，靠覆盖度才过线 —— 这正是 hybrid 存在的理由
    const hit = data.hits[0]!;
    expect(hit.similarity).toBeCloseTo(0.06, 6);
    expect(hit.coverage).toBe(1);
    expect(hit.relevance).toBeCloseTo(0.06 + RETRIEVAL_PROFILES.mock.coverageWeight, 6);
    expect(data.topScore).toBeGreaterThanOrEqual(data.threshold);
    expect(data.sufficient).toBe(true);
  });

  it("知识优先级加成只影响排序，不能把无关文档抬过依据阈值", async () => {
    /**
     * `priorityWeight` 是给排序用的微小加成。若把它也算进判据，
     * 「一份高优先级的无关文档」就能越过阈值 —— 那等于用优先级掩盖没有依据。
     */
    const { data } = await retrieve("鲍鱼怎么保存？", [
      {
        content: "本店所有商品均支持开发票。",
        similarity: 0.06,
        sourceType: "logistics",
      },
    ]);

    expect(data.hits).toHaveLength(1);
    const hit = data.hits[0]!;
    expect(hit.score).toBeGreaterThan(hit.relevance);
    expect(hit.relevance).toBeLessThan(data.threshold);
    expect(data.sufficient).toBe(false);
  });

  it("真实 Provider 档位下，同样的材料不会被误判为有依据", async () => {
    const { data } = await retrieve(
      "鲍鱼怎么保存？",
      [
        {
          content: "最佳保存温度为 0-4℃ 冷藏。",
          similarity: 0.04,
          documentName: "鲜活鲍鱼储存说明",
        },
      ],
      { id: "dashscope" },
    );

    expect(data.threshold).toBe(RETRIEVAL_PROFILES.real.groundingThreshold);
    expect(data.sufficient).toBe(false);
  });

  it("sourceTypes 原样透传给仓储（跨类型过滤不在这一层解释）", async () => {
    const { calls } = await retrieve(
      "鲍鱼怎么保存？",
      [],
      { sourceTypes: ["storage", "cooking"] },
    );
    expect(calls[0]!.sourceTypes).toEqual(["storage", "cooking"]);
  });
});

describe("Retriever · 去重与文档限量", () => {
  it("同一段内容出现多份副本时只保留相似度最高的那条", async () => {
    const content = "最佳保存温度为 0-4℃ 冷藏，建议在 48 小时内食用。";
    const { data } = await retrieve("鲍鱼怎么保存？", [
      { content, similarity: 0.12 },
      { content: ` ${content} `, similarity: 0.2 },
    ]);

    expect(data.hits).toHaveLength(1);
    // 保留的是 0.2 那一份（空白差异不影响去重判定）
    expect(data.hits[0]!.similarity).toBeCloseTo(0.2, 6);
  });

  it("同一份文档最多贡献 maxPerDocument 条，避免一份长文档占满结果", async () => {
    const { data } = await retrieve(
      "鲍鱼怎么保存？",
      [0, 1, 2, 3].map((index) => ({
        documentId: "kdoc_same",
        documentName: "鲜活鲍鱼储存说明",
        content: `第 ${index} 段：冷藏 0-4℃ 保存。`,
        similarity: 0.2 - index * 0.01,
      })),
    );

    expect(data.hits).toHaveLength(RETRIEVAL_PROFILES.mock.maxPerDocument);
  });

  it("limit 覆盖档位里的 topK", async () => {
    const { data } = await retrieve(
      "鲍鱼怎么保存？",
      [0, 1, 2, 3].map((index) => ({
        documentId: `kdoc_${index}`,
        content: `第 ${index} 段：冷藏 0-4℃ 保存。`,
        similarity: 0.2 - index * 0.01,
      })),
      { limit: 2 },
    );

    expect(data.hits).toHaveLength(2);
  });
});
