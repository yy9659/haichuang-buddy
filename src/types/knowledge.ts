/**
 * 企业知识库与 RAG 检索的类型定义（S5）
 *
 * 为什么单独成文件而不是塞进 `conversation.ts`：
 * 知识库不是「客服的一个附属物」—— 它同时被 RAG 检索层、索引服务、知识库管理界面
 * 与客服 Agent 使用。挂在客服类型下面会让「检索层要 import 客服类型」这种
 * 反向依赖迟早发生。
 *
 * 一条贯穿全文件的设计约束：**类型里不出现「向量」**。
 * `embedding` 只在仓储与 Provider 之间流动，领域层与界面永远看不到它 ——
 * 界面需要的是「哪一段知识、来自哪份文档、有多相关」，而不是 1024 个数。
 */

/**
 * 知识文档类型（第一版固定八种，刻意不再扩展）。
 *
 * 取值与数据库 `knowledge_type` 枚举一致。`after_sales` 用下划线而不是连字符，
 * 是因为它同时是枚举值；早期 Mock 里的 `after-sale` 已统一改过来 ——
 * 两套写法并存，早晚会出现「检索按 after_sales 过滤、库里存的是 after-sale」
 * 这种查不到任何结果的静默故障。
 */
export const KNOWLEDGE_DOCUMENT_TYPES = [
  "product",
  "faq",
  "logistics",
  "after_sales",
  "cooking",
  "storage",
  "brand",
  "manual",
] as const;

export type KnowledgeDocumentType = (typeof KNOWLEDGE_DOCUMENT_TYPES)[number];

/** 运行期类型守卫（Zod 之外的轻量版本，供 Mock 解析等场景使用） */
export function isKnowledgeDocumentType(
  value: unknown,
): value is KnowledgeDocumentType {
  return (
    typeof value === "string" &&
    (KNOWLEDGE_DOCUMENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * 文档来源。
 *
 * - `system`：由已有真实数据（商品资料 / Product DNA / 品牌档案）**自动同步**生成。
 *   商家从不需要手工重录一遍商品信息。
 * - `manual`：商家人工录入（物流规则、售后政策、FAQ…）。
 *
 * 为什么要区分：人工政策的知识优先级高于 AI 生成的资料（见 `KNOWLEDGE_SOURCE_PRIORITY`），
 * 且系统文档在重新同步时应被整份替换，而人工文档必须保留商家写的每一个字。
 */
export type KnowledgeDocumentSource = "system" | "manual";

/** 索引状态：文档写库与「切片 + 向量」是两步，中间态必须能被看见 */
export type KnowledgeIndexStatus = "pending" | "indexed" | "failed";

/**
 * 知识文档（领域类型）。
 *
 * `chunkCount` 是**派生量**（由 chunk 表分组统计），不落库 —— 落库就要在
 * 每一次切片重写后手动维护它，而漏更新一次就会让界面显示一个错误的切片数。
 */
export interface KnowledgeDocument {
  id: string;
  businessId: string;
  name: string;
  type: KnowledgeDocumentType;
  source: KnowledgeDocumentSource;
  /** 列表摘要 */
  summary: string;
  /** 正文（人工文档由此切片；系统文档存的是拼装出来的可读文本） */
  content: string;
  /** 关联商品；全店级文档（物流 / 售后 / 品牌）为 null */
  productId: string | null;
  indexStatus: KnowledgeIndexStatus;
  /** 最近一次切片失败的说明；成功时为 null */
  indexError: string | null;
  /** 派生：当前分块数量 */
  chunkCount: number;
  updatedAt: string;
  createdAt: string;
}

/**
 * 索引流水线版本。
 *
 * 切片元数据里带上它，是为了回答一个以后一定会被问到的问题：
 * 「这条向量是哪一版流水线产出的？」。
 *
 * 向量的可比性依赖三件事同时不变 —— 向量维度、Embedding 模型、切片规则。
 * 任何一件变了，旧向量与新向量就不在同一个语义空间里，混着检索的结果
 * 会悄悄变差（不报错、只是越来越不准）。把版本写在每一条切片上，
 * 「哪些切片需要重建」就变成一次可查询的筛选，而不是一次考古。
 *
 * 为什么不加数据库列：`knowledge_chunks.metadata` 已经是 jsonb，
 * 为它加一列既没有查询优势（不需要索引），又要走一次迁移。
 */
export const KNOWLEDGE_INDEX_VERSION = "rag-v1";

/** 切片元数据（落进 `knowledge_chunks.metadata` 的 jsonb） */
export interface ChunkMetadata {
  documentName: string;
  sourceType: string;
  productId: string | null;
  /** 章节标题（切片时识别到的最近一个标题）；没有标题时为空串 */
  section: string;
  chunkIndex: number;
  /** 该切片在文档中的字符区间，便于回溯与调试 */
  start: number;
  end: number;
  /**
   * 产出这条向量的流水线版本，见 `KNOWLEDGE_INDEX_VERSION`。
   *
   * 可选：早期切片（以及任何非本服务写入的切片）没有这个字段，
   * 读取路径必须容忍它缺席 —— 把它们当成「版本未知」，而不是映射失败。
   */
  indexVersion?: string;
}

/**
 * 知识切片（领域类型）。
 *
 * `businessId` / `sourceType` / `title` 冗余在切片上（数据库这三列也一样冗余），
 * 是为了让**向量检索一次查询就能过滤商家并返回可展示的来源**。
 * 若只存 documentId，每次检索都要 join 文档表才能知道「这条能不能给这个商家看」——
 * 而跨商家泄漏在这个项目里是不可接受的错误。
 */
export interface KnowledgeChunk {
  id: string;
  documentId: string;
  businessId: string;
  productId: string | null;
  sourceType: KnowledgeDocumentType;
  /** 冗余的文档名，用于引用展示（避免检索后再回查文档表） */
  title: string;
  chunkIndex: number;
  content: string;
  metadata: ChunkMetadata;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* 检索结果                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一条检索命中。
 *
 * ⚠️ **本类型的数字全部在「原始余弦」尺度上**，可以直接互相比较、
 * 也可以直接和 `RetrievalOutcome.threshold` 比较。
 * 界面要的 0~1「相关度百分比」由展示边界（客服 Agent 构造 `KnowledgeSource` 时）
 * 映射一次，不在这里做 —— 混两种尺度是这类代码最容易埋下的错。
 *
 * 四个数字各司其职：
 * - `similarity`：原始余弦。回答「文本整体像不像」。
 * - `coverage`：词面覆盖度 0~1。回答「问题里的关键概念，这段材料提到了几个」（含文档名与章节）。
 * - `relevance`：`相似度 + 权重 × 覆盖度`，**依据充分性判定用的就是它**。
 * - `score`：`relevance + 知识优先级加成`，只用于排序，不对商家展示
 *   （展示一个「0.83 分」而没有分母，只会让人困惑）。
 *
 * 为什么 `relevance` 与 `score` 要分开：优先级加成最多 0.08，
 * 若混进判据，一份高优先级的**无关**文档就有机会越过依据阈值 ——
 * 那等于用优先级掩盖「其实没有依据」。
 */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentName: string;
  sourceType: KnowledgeDocumentType;
  productId: string | null;
  title: string;
  section: string;
  content: string;
  /** 原始余弦相似度（可能为负，本项目内文本相关时多为 0~1） */
  similarity: number;
  /** 词面覆盖度（0~1）。查询内容词元太少时不启用稀疏侧，此处为 0 */
  coverage: number;
  /** 相似度 + 权重 × 覆盖度（依据判定尺度） */
  relevance: number;
  /** relevance + 知识优先级加成（排序尺度） */
  score: number;
}

/** 检索结果 + 依据充分性判定（`sufficient=false` 时不得进入事实回答） */
export interface RetrievalOutcome {
  hits: RetrievedChunk[];
  /** Top 命中的最高相似度（原始余弦）；无命中为 0 */
  topSimilarity: number;
  /** Top 命中的最高综合相关分（与 `threshold` 同尺度）；无命中为 0 */
  topScore: number;
  /** 本次生效的依据充分性阈值，来自 Provider 档位。带上它是为了错误信息能说清「差多少」 */
  threshold: number;
  /** 是否达到「可以据此回答事实问题」的阈值 */
  sufficient: boolean;
}

/* ------------------------------------------------------------------ */
/* 知识缺口                                                            */
/* ------------------------------------------------------------------ */

export type KnowledgeGapStatus = "open" | "resolved" | "ignored";

/**
 * 知识缺口记录（RAG 答不上来的问题被聚合在这里，而不是每问一次建一行）。
 *
 * 「最新一次」而非「首次」的字段有三个：`question` / `intent` / `reason`。
 * 它们描述的是**最近一次被问到时的情况**，因为它们要回答的问题是
 * 「商家现在该补什么」——用第一次的问法配最后一次的缺什么，读起来是矛盾的。
 * 「首次」的锚点是 `firstSeenAt`，与它成对的是聚合键本身（不会变）。
 *
 * 聚合身份（商家 + 商品 + 规范化问题）由 `gapKey` 承载，**不暴露在这个类型里**：
 * 它是存储层的唯一索引目标，不是界面要理解的概念。界面要的是
 * 「这条缺口属于哪个商品」——那是 `productId`。
 */
export interface KnowledgeGapRecord {
  id: string;
  businessId: string;
  productId: string | null;
  /** 最近一次提问时的原话（面板展示用） */
  question: string;
  /** 规范化后的问题，用于去重比对 */
  normalizedQuestion: string;
  /** 归一化后的意图 */
  intent: string;
  /** 为什么答不上来（面向商家的说明） */
  reason: string;
  status: KnowledgeGapStatus;
  /** 被问了多少次（去重后累加） */
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 被哪份文档补齐（`resolveKnowledgeGap` 时写入；缺口重新打开时清空） */
  resolvedDocumentId: string | null;
}
