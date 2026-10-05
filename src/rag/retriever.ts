/**
 * Retriever —— 混合检索层（S5 · 任务书第十六 / 十七节）
 *
 * 职责边界（任务书第 4.2 节「Retrieval 与 Generation 分离」）：
 *   问题 → Embedding → 向量检索 → 相似度过滤 → 去重 → 轻量重排 → RetrievedChunk[]
 *
 * **向量查询不写进 Prompt，Agent 也不直接操作数据库。** 这一层是唯一碰向量检索的地方，
 * 上游（客服 Agent）只拿到「已经筛好的知识片段」，下游（Provider / 仓储）
 * 只负责各自那一小步。任何一端越界，换模型或换向量库时就得同时改三处。
 *
 * 四条硬约束：
 * 1. **不「只要 TopK 就强行回答」**。Top 命中达不到依据阈值时 `sufficient=false`，
 *    由 Agent 走「依据不足 → 转人工 + 记缺口」这条路（任务书第十五节）。
 * 2. **阈值集中配置**，不散落在 UI 或 Agent 里 —— 界面不该知道「多少分算相关」。
 * 3. **同一份文档最多贡献 `maxPerDocument` 条**。否则一份很长的《商品资料》
 *    会占满全部 TopK，商家看到「依据 6 条」点开却只有一份文档 ——
 *    那等于把「多来源交叉印证」这个信号抹掉了。
 * 4. **只能在本商家的知识里检索**。`businessId` 是必填，没有「不传就查全部」这条后路。
 *
 * ## 为什么是 hybrid（dense + sparse）而不是纯向量
 *
 * 纯余弦在本项目里不够用，原因有两层，第二层才是决定性的：
 *
 * - **真实模型**：短问句与相关段落的余弦通常 0.5~0.8，但专有名词、型号、地名
 *   这类「必须一字不差」的信息恰恰是语义空间最容易抹掉的。
 * - **Mock 向量**：特征是词袋哈希，**零重叠的两段文本也会有 0.05~0.12 的余弦**
 *   （散列碰撞底噪），与真实信号（0.1~0.25）同量级。实测「鲍鱼怎么保存？」
 *   对《鲍鱼处理与烹饪指南》的余弦（0.2116）**高于**对真正讲储存的
 *   《鲜活鲍鱼储存说明》（0.1374）—— 只按余弦排序会把答案排到后面去。
 *
 * 因此综合分是两者相加：`相似度 + 权重 × 词面覆盖度 + 知识优先级加成`。
 * 覆盖度回答的是「问题里的关键概念，这段材料提到了几个」，
 * 它不受文本长度与词频影响，正好补上余弦的短板。
 *
 * ⚠️ 覆盖度的比较文本是**文档名 + 章节 + 正文**，不是只有正文。
 * 原因是标题字段本身就是这段材料的语义标签（BM25F 里叫 field boost）：
 * 《鲜活鲍鱼储存说明》的正文里通篇在讲「冷藏 / 冷冻」，反而很少出现「储存」二字，
 * 只看正文会让整份文档在「怎么储存」这个问题上拿不到词面分。
 * 而文档名与章节名本来就随引用一起展示给商家，纳入计算不存在「用了看不见的信息」。
 */

import type { AIProvider } from "@/ai/provider/types";
import type { KnowledgeChunk } from "@/types";
import { attempt, fail, ok, toAppError, type Result } from "@/lib/result";
import { KNOWLEDGE_SOURCE_PRIORITY } from "@/lib/status-meta";
import { createQueryCoverage } from "@/lib/text-tokens";
import type {
  KnowledgeDocumentType,
  RetrievalOutcome,
  RetrievedChunk,
} from "@/types";
import type {
  KnowledgeChunkSearchHit,
  KnowledgeSearchParams,
} from "@/repositories/types";

/** 检索参数档位 */
export interface RetrievalProfile {
  /** 送进提示词的片段数上限 */
  topK: number;
  /** 相似度下限：低于它的命中直接丢弃，不占用 TopK */
  minSimilarity: number;
  /**
   * 依据充分性阈值：Top 命中的**综合分**低于它 → `sufficient=false`。
   *
   * 为什么必须与 `minSimilarity` 分开：两者回答的是不同问题。
   * `minSimilarity` 是「这条还值不值得看一眼」（过滤噪声，只看余弦），
   * `groundingThreshold` 是「这批材料够不够支撑一个事实回答」（决定要不要转人工）。
   * 合成一个数就只能二选一：要么把勉强相关的片段当依据，要么把可信的片段也丢掉。
   *
   * 另外它判的是综合分而不是余弦：既然排序已经用上了词面覆盖度，
   * 阈值也必须用同一把尺子，否则「排序按 A、判定按 B」会让 Top1 明明过了线却被判依据不足。
   */
  groundingThreshold: number;
  /**
   * 词面覆盖度在综合分里的权重。
   *
   * 这个数**必须按 Provider 分档**，而且差异很大（mock 0.4 / real 0.05）：
   * Mock 向量的碰撞底噪与真实信号同量级，靠余弦排序不可靠，必须让词面覆盖度主导；
   * 真实语义空间余弦本身可信，稀疏侧只作为专有名词一类精确匹配的补充，
   * 给太大权重反而会把「换了个说法的同义表达」压下去。
   */
  coverageWeight: number;
  /** 同一文档最多贡献几条 */
  maxPerDocument: number;
  /** 知识优先级的权重（综合分上的小幅加成，只影响排序） */
  priorityWeight: number;
}

/**
 * 两套档位，按 Provider 分开。
 *
 * ⚠️ **这两个数不可互换**，原因是 Mock 向量与真实向量的相似度分布完全不同：
 * 真实模型是语义空间，短问句与相关段落的余弦通常落在 0.5~0.8；
 * 而 Mock 是词袋哈希，长段落的向量被数百个词元摊薄，短问句即使高度相关
 * 余弦也只有 0.1~0.25。拿真实档位跑 Mock，「所有问题都答不上来」；
 * 拿 Mock 档位跑真实模型，「什么无关内容都能当依据」—— 两种都是静默的错。
 *
 * 判定依据是 `provider.id === "mock"`（Provider 自己声明的），不是「猜」。
 *
 * `mock.groundingThreshold = 0.33` 是标定的结果：把 `coverageWeight`
 * 与覆盖度分母上限做了 24 组穷举，选出「8 条关键问题全部落在正确文档上」
 * 且阈值带最宽的一组 —— 可行区间是 `(0.2232, 0.4291]`，0.33 落在正中，
 * 两侧各留约 0.10 的余量。以下是这组数落点的两端：
 * - 下端：「多久能到？我明天要送人。」→ 0.2232（知识库里确实没有物流时效）
 * - 上端：商家补《发货与物流说明》后，「多久发货？」→ 0.4291
 */
export const RETRIEVAL_PROFILES: Readonly<Record<"real" | "mock", RetrievalProfile>> =
  {
    real: {
      topK: 6,
      minSimilarity: 0.3,
      groundingThreshold: 0.45,
      coverageWeight: 0.05,
      maxPerDocument: 2,
      priorityWeight: 0.03,
    },
    mock: {
      topK: 6,
      // 词袋哈希的绝对分偏低，但**相对差异是可用的**（相关 ≈ 0.15~0.30，无关 ≈ 0.03~0.08）
      minSimilarity: 0.05,
      groundingThreshold: 0.33,
      coverageWeight: 0.4,
      maxPerDocument: 2,
      priorityWeight: 0.02,
    },
  };

/** 按 Provider 解析生效档位 */
export function resolveRetrievalProfile(provider: AIProvider): RetrievalProfile {
  return provider.id === "mock" ? RETRIEVAL_PROFILES.mock : RETRIEVAL_PROFILES.real;
}

export interface RetrieveInput {
  /** 消费者原话 */
  query: string;
  /** **必填**：跨商家检索不可接受，见 `KnowledgeSearchParams` */
  businessId: string;
  /**
   * 限定商品。
   *
   * `null` / 不传都表示**不按商品过滤**，即检索该商家的全部知识。
   *
   * 这样定义是为了避免一个很隐蔽的失败：消费者问「鱼丸怎么煮？」但这条会话
   * 没绑定商品（真实场景里绝大多数提问都不带商品），若把「未指定」解释成
   * 「只要全店知识」，商品级文档就会被整体排除，检索结果凭空变少 ——
   * 而界面上完全看不出原因。跨商家泄漏由 `businessId` 单独兜住，不靠这一层。
   */
  productId?: string | null;
  sourceTypes?: readonly KnowledgeDocumentType[];
  /** 覆盖档位里的 topK */
  limit?: number;
  signal?: AbortSignal;
}

/** 检索依赖：Provider 与仓储都以参数注入，便于单测替换 */
export interface RetrievalDeps {
  provider: AIProvider;
  search: (params: KnowledgeSearchParams) => Promise<KnowledgeChunkSearchHit[]>;
}

/** 归一化文本用于去重：折叠空白与常见标点差异，避免同一段知识的两份副本同时入选 */
function normalizeForDedup(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，。；：、！？,.;:!?]/g, "");
}

/** 知识优先级 → 加成（优先级数字越小，加成越高） */
function priorityBonus(type: KnowledgeDocumentType, weight: number): number {
  const priority = KNOWLEDGE_SOURCE_PRIORITY[type] ?? 5;
  // 1 → 4w，5 → 0w
  return Math.max(0, 5 - priority) * weight;
}

/**
 * 词面覆盖度的比较文本：文档名 + 章节 + 正文。
 *
 * 理由见文件头 —— 标题字段是这段材料的语义标签，而且它本来就会随引用展示给商家。
 */
function coverageTextOf(chunk: KnowledgeChunk): string {
  return [chunk.metadata.documentName, chunk.metadata.section, chunk.content]
    .filter((part) => part.length > 0)
    .join("\n");
}

export async function retrieveRelevantChunks(
  input: RetrieveInput,
  deps: RetrievalDeps,
): Promise<Result<RetrievalOutcome>> {
  const query = input.query.trim();
  if (query.length === 0) {
    return fail("VALIDATION_FAILED", "问题内容为空，无法检索知识库");
  }

  const profile = resolveRetrievalProfile(deps.provider);

  /**
   * 稀疏侧计算器：一次查询只分词一次，随后用于所有候选切片。
   * 查询词元太少时 `measurable=false`，`coverageOf` 恒返回 0 ——
   * 即自动退回纯向量判定（理由见 `MIN_COVERAGE_QUERY_TOKENS`）。
   */
  const coverage = createQueryCoverage(query);

  /** ① 向量化问题。失败说明模型不可用 —— 这不是「没有知识」，必须区分开 */
  const embedded = await attempt(
    () => deps.provider.embed({ values: [query], signal: input.signal }),
    (cause) => toAppError(cause, "MODEL_UNAVAILABLE", "问题向量化失败"),
  );
  if (!embedded.ok) {
    return { ok: false, error: embedded.error };
  }

  const queryEmbedding = embedded.data[0];
  if (!queryEmbedding) {
    return fail(
      "MODEL_UNAVAILABLE",
      "问题向量化没有返回结果",
      "Provider.embed 返回了空数组",
    );
  }

  /** ② 向量检索。失败是数据库 / 检索层的问题，同样不是「没有知识」 */
  const searched = await attempt(
    () =>
      deps.search({
        businessId: input.businessId,
        queryEmbedding,
        // null → undefined：把「未指定商品」交给仓储解释为「不按商品过滤」，
        // 而不是解释成「只要全店知识」（理由见 RetrieveInput.productId）
        productId: input.productId ?? undefined,
        sourceTypes: input.sourceTypes,
        limit: Math.max(profile.topK * 3, profile.topK),
      }),
    (cause) => toAppError(cause, "DB_ERROR", "检索知识库失败"),
  );
  if (!searched.ok) {
    return { ok: false, error: searched.error };
  }

  /** ③ 余弦过滤。这一步只用余弦，因为阈值管的是「这条还值不值得看一眼」 */
  const minSimilarity = profile.minSimilarity;
  const aboveThreshold = searched.data.filter(
    (hit) => hit.similarity >= minSimilarity,
  );

  /**
   * ④ 去重。
   *
   * 系统同步文档与人工文档可能包含同一段话（商家把商品资料又抄了一遍）。
   * 不去重的话，TopK 会被同一段内容的多个副本占满，商家看到「依据 3 条」，
   * 展开却是三段一模一样的文字 —— 这会直接削弱「多来源印证」的可信度。
   * 保留相似度更高的那一份。
   */
  const deduped = new Map<string, KnowledgeChunkSearchHit>();
  for (const hit of aboveThreshold) {
    const key = normalizeForDedup(hit.chunk.content);
    const existing = deduped.get(key);
    if (!existing || hit.similarity > existing.similarity) {
      deduped.set(key, hit);
    }
  }

  /**
   * ⑤ 轻量重排：余弦 + 词面覆盖度 + 知识优先级加成。第一版不引入 reranker 服务。
   *
   * 两个分刻意分开算：
   * - `relevance` 只含「材料与问题的相关程度」，用于**依据充分性判定**；
   * - `score` 在它之上再加知识优先级加成，用于**排序**。
   * 合起来会让「一份高优先级的无关文档」有机会越过依据阈值 —— 那正是
   * 任务书想禁止的「用优先级掩盖没有依据」。加成最多 0.08，排序上够用，判据上不该有份。
   */
  const ranked = [...deduped.values()]
    .map((hit) => {
      const chunkCoverage = coverage.coverageOf(coverageTextOf(hit.chunk));
      const relevance = hit.similarity + profile.coverageWeight * chunkCoverage;
      return {
        hit,
        coverage: chunkCoverage,
        relevance,
        score: relevance + priorityBonus(hit.chunk.sourceType, profile.priorityWeight),
      };
    })
    .sort((a, b) => b.score - a.score);

  /** ⑥ 每份文档限量，避免一份长文档占满结果 */
  const perDocument = new Map<string, number>();
  const selected: typeof ranked = [];
  const limit = input.limit ?? profile.topK;

  for (const entry of ranked) {
    const used = perDocument.get(entry.hit.chunk.documentId) ?? 0;
    if (used >= profile.maxPerDocument) {
      continue;
    }
    perDocument.set(entry.hit.chunk.documentId, used + 1);
    selected.push(entry);
    if (selected.length >= limit) {
      break;
    }
  }

  const hits: RetrievedChunk[] = selected.map(({ hit, score, relevance, coverage: chunkCoverage }) => ({
    chunkId: hit.chunk.id,
    documentId: hit.chunk.documentId,
    documentName: hit.chunk.metadata.documentName || hit.chunk.title,
    sourceType: hit.chunk.sourceType,
    productId: hit.chunk.productId,
    title: hit.chunk.title,
    section: hit.chunk.metadata.section,
    content: hit.chunk.content,
    similarity: hit.similarity,
    coverage: chunkCoverage,
    score,
    relevance,
  }));

  /**
   * ⑦ 依据充分性。
   *
   * 在**全部候选**里取最高的 `relevance`（而不是 `ranked[0]`）：排序分含优先级加成，
   * 可能把另一条挤到第一，但「有没有能回答问题的材料」不该受此影响。
   * 判定与排序都用**原始余弦尺度**上的分，阈值也一样 —— 全程只用一把尺子。
   *
   * 展示尺度（0~1 的「相关度百分比」）由**展示边界**负责映射，
   * 不在这里做：把余弦先压成 0.59 再和 0.33 的阈值比较，
   * 是这类代码最容易埋下的一类错（两边都「看起来像 0~1」）。
   */
  const topSimilarity = hits.reduce(
    (max, hit) => Math.max(max, hit.similarity),
    0,
  );
  const topScore = ranked.reduce((max, entry) => Math.max(max, entry.relevance), 0);

  return ok({
    hits,
    topSimilarity,
    topScore,
    threshold: profile.groundingThreshold,
    sufficient: hits.length > 0 && topScore >= profile.groundingThreshold,
  });
}

/**
 * 把检索结果渲染成提示词里的知识片段块（**只渲染正文**）。
 *
 * 每条都带上 `chunkId`（模型必须原样引用它）与来源信息（模型据此写出
 * 「依据：物流政策」这类说明）。
 *
 * 不在这里加分隔符：包裹由提示词模块负责（`<<<KNOWLEDGE_CONTEXT>>>`），
 * 因为那个标记同时是 Mock Provider 的分发锚点，必须与提示词定义在一起，
 * 不能让 RAG 层也硬编码一份。
 */
export function renderKnowledgeContext(hits: readonly RetrievedChunk[]): string {
  if (hits.length === 0) {
    return "（本次检索没有找到任何知识片段）";
  }
  return hits
    .map((hit, index) =>
      [
        `[片段 ${index + 1}]`,
        `chunkId: ${hit.chunkId}`,
        `来源文档: ${hit.documentName}`,
        hit.section ? `章节: ${hit.section}` : "",
        "内容:",
        hit.content,
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    )
    .join("\n\n");
}
