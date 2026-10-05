/**
 * Mock 仓储的可变内存状态
 *
 * 为什么需要它：
 * S1-1 给商品仓储补上了 create / update / delete，Mock 实现也必须满足同一个接口，
 * 否则「切到 mock 就能跑」的约定会被破坏。这里用一个进程内 store 承载写操作。
 *
 * 重要约定：
 * - 读取结果与 Phase 0 的 MOCK_PRODUCTS 完全一致（初始值即全量拷贝），保证视觉零回归。
 * - 写操作只改内存，进程重启即还原。这是刻意的：Mock 不落库，
 *   绝不能让界面产生「已经保存到数据库」的错觉。
 */

import {
  MOCK_BUSINESS,
  MOCK_CONTENTS,
  MOCK_KNOWLEDGE_DOCUMENTS,
  MOCK_LIVE_PRODUCT_ID,
  MOCK_LIVE_PRODUCT_NAME,
  MOCK_LIVE_SESSION,
  MOCK_LIVE_STATS,
  MOCK_PRODUCTS,
  MOCK_PRODUCT_DNA,
  MOCK_SIMULATED_CONSUMERS,
  buildSeedLiveComments,
} from "@/lib/mock";
import type {
  BrandProfile,
  BusinessReport,
  ChatMessage,
  ChunkMetadata,
  ContentItem,
  ContentSlot,
  ConversationChannel,
  ConversationStatus,
  KnowledgeDocumentSource,
  KnowledgeDocumentType,
  KnowledgeGapStatus,
  KnowledgeIndexStatus,
  KnowledgeSource,
  LiveIntent,
  LivePriority,
  LiveRecommendedAction,
  LiveResponseMode,
  LiveSessionStatus,
  Product,
  ProductDNA,
} from "@/types";

import { matchesContentSlot } from "../content-item";
import type { AgentTaskRecord, AgentWorkflowRecord } from "../types";

/** Next 的页面与 Route Handler 可能重复加载模块；检索与写入共享同一份进程内集合。 */
function sharedMockCollection<T>(key: string, initialize: () => T): T {
  const host = globalThis as typeof globalThis & { __haichuangMockCollections?: Map<string, unknown> };
  const collections = host.__haichuangMockCollections ??= new Map();
  if (!collections.has(key)) collections.set(key, initialize());
  return collections.get(key) as T;
}

/** 商品（深拷贝，避免写操作污染 MOCK_PRODUCTS 常量） */
const products = sharedMockCollection<Product[]>("products", () => MOCK_PRODUCTS.map((product) => ({
  ...product,
  metrics: { ...product.metrics },
  tags: [...product.tags],
})));

/** 商品 DNA，key 为商品 id */
const dnaByProductId = sharedMockCollection("productDna", () => new Map<string, ProductDNA>(
  Object.entries(MOCK_PRODUCT_DNA).map(([productId, dna]) => [
    productId,
    {
      ...dna,
      visualFeatures: [...dna.visualFeatures],
      coreFeatures: [...dna.coreFeatures],
      sellingPoints: [...dna.sellingPoints],
      targetUsers: [...dna.targetUsers],
      consumptionScenarios: [...dna.consumptionScenarios],
      userPainPoints: [...dna.userPainPoints],
      marketingAngles: [...dna.marketingAngles],
      riskNotes: [...dna.riskNotes],
    },
  ]),
));

export function listStoredProducts(): Product[] {
  return products;
}

export function listStoredProductIds(): string[] {
  return products.map((product) => product.id);
}

export function findStoredProduct(id: string): Product | undefined {
  return products.find((product) => product.id === id);
}

export function findStoredDna(productId: string): ProductDNA | undefined {
  return dnaByProductId.get(productId);
}

export function putStoredProduct(product: Product): void {
  products.unshift(product);
}

export function putStoredDna(dna: ProductDNA): void {
  dnaByProductId.set(dna.productId, dna);
}

export function removeStoredProduct(id: string): boolean {
  const index = products.findIndex((product) => product.id === id);
  if (index < 0) {
    return false;
  }
  products.splice(index, 1);
  dnaByProductId.delete(id);
  // 与数据库的级联删除（agent_tasks.product_id ON DELETE CASCADE）保持同一语义，
  // 否则切到 mock 时「删了商品、任务记录还在」会让人以为数据没删干净。
  removeStoredAgentTasksByProduct(id);
  // 内容条目同理（contents.product_id ON DELETE CASCADE）
  removeStoredContentsByProduct(id);
  // S5：知识文档 / 切片 / 缺口同理（knowledge_documents.product_id 等均为 CASCADE）。
  // 会话的 product_id 在数据库里是 SET NULL（历史消息不该因为商品下架而消失），
  // 因此那里只解绑、不删除。
  removeStoredKnowledgeByProduct(id);
  detachStoredConversationsByProduct(id);
  return true;
}

/* ------------------------------------------------------------------ */
/* Agent 任务记录                                                      */
/* ------------------------------------------------------------------ */

/**
 * 任务记录按创建时间倒序保存（新的在最前），
 * 这样「取最近一次任务」就是 find 的第一个命中项，不需要额外排序。
 */
const agentTasks = sharedMockCollection<AgentTaskRecord[]>("agentTasks", () => []);

export function listStoredAgentTasks(): AgentTaskRecord[] {
  return agentTasks;
}

export function findStoredAgentTask(id: string): AgentTaskRecord | undefined {
  return agentTasks.find((task) => task.id === id);
}

/** 新建任务：插到最前，维持倒序 */
export function putStoredAgentTask(task: AgentTaskRecord): void {
  agentTasks.unshift(task);
}

/** 就地替换（保持原位置，倒序不受影响） */
export function replaceStoredAgentTask(task: AgentTaskRecord): void {
  const index = agentTasks.findIndex((item) => item.id === task.id);
  if (index >= 0) {
    agentTasks[index] = task;
  }
}

export function removeStoredAgentTasksByProduct(productId: string): void {
  for (let index = agentTasks.length - 1; index >= 0; index -= 1) {
    if (agentTasks[index]?.productId === productId) {
      agentTasks.splice(index, 1);
    }
  }
}

/** 仅测试使用：清空任务记录，避免用例之间互相污染 */
export function clearStoredAgentTasks(): void {
  agentTasks.length = 0;
}

/* ------------------------------------------------------------------ */
/* 工作流记录（S4-1）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 工作流按创建时间倒序保存（新的在最前），与任务同一套约定，
 * 这样 `findLatestRunning` / `listRecent` 都只需顺序扫描。
 *
 * 初始为空数组 —— 工作流必须由 Business Brain 真实规划出来，
 * 不预置演示工作流（驾驶舱那张 Phase 0 的展示卡片走的是 `mock/workflow.ts`，
 * 与本存储无关，两者刻意分开：一个是演示视图，一个是真实状态机）。
 */
const agentWorkflows = sharedMockCollection<AgentWorkflowRecord[]>("agentWorkflows", () => []);

export function listStoredAgentWorkflows(): AgentWorkflowRecord[] {
  return agentWorkflows;
}

export function findStoredAgentWorkflow(
  id: string,
): AgentWorkflowRecord | undefined {
  return agentWorkflows.find((workflow) => workflow.id === id);
}

/** 新建工作流：插到最前，维持倒序 */
export function putStoredAgentWorkflow(workflow: AgentWorkflowRecord): void {
  agentWorkflows.unshift(workflow);
}

/** 就地替换（保持原位置，倒序不受影响） */
export function replaceStoredAgentWorkflow(workflow: AgentWorkflowRecord): void {
  const index = agentWorkflows.findIndex((item) => item.id === workflow.id);
  if (index >= 0) {
    agentWorkflows[index] = workflow;
  }
}

/**
 * 删除某个工作流及其全部任务。
 *
 * 对应数据库的 `agent_tasks.workflow_id ON DELETE CASCADE`。
 * Mock 存储不会自动级联，必须显式做 —— 否则会出现「工作流没了、
 * 任务还挂在一个不存在的 workflowId 下」这种只在 Mock 下存在的脏状态。
 */
export function removeStoredAgentWorkflow(id: string): void {
  const index = agentWorkflows.findIndex((item) => item.id === id);
  if (index < 0) {
    return;
  }
  agentWorkflows.splice(index, 1);
  for (let taskIndex = agentTasks.length - 1; taskIndex >= 0; taskIndex -= 1) {
    if (agentTasks[taskIndex]?.workflowId === id) {
      agentTasks.splice(taskIndex, 1);
    }
  }
}

/** 仅测试使用：清空工作流记录，避免用例之间互相污染 */
export function clearStoredAgentWorkflows(): void {
  agentWorkflows.length = 0;
}

/* ------------------------------------------------------------------ */
/* 品牌档案                                                            */
/* ------------------------------------------------------------------ */

/**
 * 品牌档案（S3-1）。
 *
 * 初始值为 **null** —— 这是刻意的：品牌档案必须由 Brand Agent 真实生成，
 * 不预置一份「看起来像 AI 产出」的假档案。界面因此会先进入 empty 态，
 * 用户点「AI 生成品牌」后才看到内容，这与 Product DNA 的处理方式一致。
 */
let brandProfile: BrandProfile | null = null;

export function findStoredBrandProfile(): BrandProfile | null {
  return brandProfile;
}

export function putStoredBrandProfile(profile: BrandProfile): void {
  brandProfile = {
    ...profile,
    brandValues: [...profile.brandValues],
    targetAudience: [...profile.targetAudience],
    brandPersonality: [...profile.brandPersonality],
    toneOfVoice: [...profile.toneOfVoice],
    visualKeywords: [...profile.visualKeywords],
    riskNotes: [...profile.riskNotes],
  };
}

/** 仅测试使用：把品牌档案复位为「尚未生成」 */
export function clearStoredBrandProfile(): void {
  brandProfile = null;
}

/* ------------------------------------------------------------------ */
/* 内容条目                                                            */
/* ------------------------------------------------------------------ */

/**
 * 内容条目（S3-2）。
 *
 * 与品牌档案**刻意不同**：初始值是 Mock 演示内容（与商品的处理一致），不是空数组。
 * 理由：内容条目是一个**集合**（与商品同类），Phase 0 起就靠这批演示数据撑起
 * 内容工厂的主从视图与经营指标；若初始化为空，整个 /content 与驾驶舱的内容指标
 * 会一起变空，属于无必要的视觉回归 —— 而品牌档案是**单例**，且当时没有任何
 * 「看起来像 AI 产出」的演示档案可留，所以那里选择从空开始。
 *
 * 保留演示数据并不违反「不伪造 AI 结果」：这批数据不带 `aiVersion` / `confidence`，
 * 界面据此不显示「AI 生成」标记，一眼能分辨它是演示样例而不是模型产出。
 *
 * 排序：新生成的内容插到最前（最新在前），与数据库的 `ORDER BY created_at DESC` 一致。
 */
function buildDemoContents(): ContentItem[] {
  return MOCK_CONTENTS.map((item) => ({
    ...item,
    hashtags: [...item.hashtags],
    visualSuggestions: [...item.visualSuggestions],
    shotList: [...item.shotList],
    metrics: { ...item.metrics },
  }));
}

const contents = sharedMockCollection<ContentItem[]>("contents", buildDemoContents);

export function listStoredContents(): ContentItem[] {
  return contents;
}

export function findStoredContentBySlot(slot: ContentSlot): ContentItem | undefined {
  return contents.find((item) => matchesContentSlot(item, slot));
}

/** 新生成的内容插到最前，维持「最新在前」 */
export function putStoredContent(content: ContentItem): void {
  contents.unshift(content);
}

/** 就地替换（保持原位置） */
export function replaceStoredContent(content: ContentItem): void {
  const index = contents.findIndex((item) => item.id === content.id);
  if (index >= 0) {
    contents[index] = content;
  }
}

export function removeStoredContentsByProduct(productId: string): void {
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    if (contents[index]?.productId === productId) {
      contents.splice(index, 1);
    }
  }
}

/** 仅测试使用：把内容资产复位为演示基线 */
export function resetStoredContents(): void {
  contents.splice(0, contents.length, ...buildDemoContents());
}

/* ------------------------------------------------------------------ */
/* 知识文档 / 切片 / 缺口（S5）                                        */
/* ------------------------------------------------------------------ */

/**
 * 这里存的形状是**表行**，不是领域类型：
 * 时间留 `Date`（展示字符串在读的时候现算）、`chunkCount` 不存（现算）、
 * 向量留在切片上（领域层看不到它）。
 *
 * 这样做与数据库实现保持同一套「派生字段不落库」的约定 ——
 * 两边都不会出现「列表页显示的切片数是对的、详情页显示的是旧的」这种偏差。
 */
export interface StoredKnowledgeDocument {
  id: string;
  businessId: string;
  name: string;
  type: KnowledgeDocumentType;
  source: KnowledgeDocumentSource;
  summary: string;
  content: string;
  productId: string | null;
  indexStatus: KnowledgeIndexStatus;
  indexError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredKnowledgeChunk {
  id: string;
  documentId: string;
  businessId: string;
  productId: string | null;
  sourceType: KnowledgeDocumentType;
  title: string;
  chunkIndex: number;
  content: string;
  /** 向量只在本层与 Provider 之间流动，映射到领域类型时**丢掉** */
  embedding: number[] | null;
  metadata: ChunkMetadata;
  createdAt: Date;
}

export interface StoredKnowledgeGap {
  id: string;
  businessId: string;
  productId: string | null;
  question: string;
  normalizedQuestion: string;
  /**
   * 聚合键（商家 + 商品 + 规范化问题 的 sha256）。
   * 内存实现按它去重，与数据库唯一索引 `(business_id, gap_key)` 同一口径 ——
   * 两套数据源若用不同的聚合边界，任务书第十四节要求的「语义一致」就无从谈起。
   */
  gapKey: string;
  intent: string;
  reason: string;
  status: KnowledgeGapStatus;
  occurrenceCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedDocumentId: string | null;
}

/**
 * 种子知识文档（人工录入部分）。
 *
 * 商品资料 / 品牌资料这类**系统同步**文档刻意不在种子里 ——
 * 它们必须由 `knowledge.service.ts` 从真实商品 / DNA / 品牌数据里推导出来。
 * 手抄一份写死在这里，等于把同步逻辑绕过去了，而那段逻辑恰好是最容易写错的。
 */
const knowledgeDocuments: StoredKnowledgeDocument[] = MOCK_KNOWLEDGE_DOCUMENTS.map(
  (seed, index) => {
    const createdAt = new Date();
    return {
      id: `kdoc_${String(index + 1).padStart(3, "0")}`,
      businessId: MOCK_BUSINESS.id,
      name: seed.name,
      type: seed.type,
      source: seed.source,
      summary: seed.summary,
      content: seed.content,
      productId: seed.productId,
      // 种子里只有正文，没有切片 —— 索引必须由服务层真实跑一遍（pending → indexed）
      indexStatus: "pending" as KnowledgeIndexStatus,
      indexError: null,
      createdAt,
      updatedAt: createdAt,
    };
  },
);

/** 切片初始为空：一定要经过 chunkDocument + embed 才会有值 */
const knowledgeChunks: StoredKnowledgeChunk[] = [];

/** 缺口初始为空 —— 真实聚合，不预置演示噪声 */
const knowledgeGaps: StoredKnowledgeGap[] = [];

export function listStoredKnowledgeDocuments(): StoredKnowledgeDocument[] {
  return knowledgeDocuments;
}

export function findStoredKnowledgeDocument(
  id: string,
): StoredKnowledgeDocument | undefined {
  return knowledgeDocuments.find((document) => document.id === id);
}

export function putStoredKnowledgeDocument(document: StoredKnowledgeDocument): void {
  knowledgeDocuments.unshift(document);
}

/** 就地替换（保持原位置）；文档更新很频繁，不能每次都挪到队首 */
export function replaceStoredKnowledgeDocument(
  document: StoredKnowledgeDocument,
): void {
  const index = knowledgeDocuments.findIndex((item) => item.id === document.id);
  if (index >= 0) {
    knowledgeDocuments[index] = document;
  }
}

export function removeStoredKnowledgeDocument(id: string): boolean {
  const index = knowledgeDocuments.findIndex((document) => document.id === id);
  if (index < 0) {
    return false;
  }
  knowledgeDocuments.splice(index, 1);
  // 对应数据库的 knowledge_chunks.document_id ON DELETE CASCADE
  removeStoredChunksByDocument(id);
  return true;
}

export function listStoredKnowledgeChunks(): StoredKnowledgeChunk[] {
  return knowledgeChunks;
}

export function putStoredKnowledgeChunks(chunks: StoredKnowledgeChunk[]): void {
  knowledgeChunks.push(...chunks);
}

export function removeStoredChunksByDocument(documentId: string): number {
  let removed = 0;
  for (let index = knowledgeChunks.length - 1; index >= 0; index -= 1) {
    if (knowledgeChunks[index]?.documentId === documentId) {
      knowledgeChunks.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

/**
 * 用新切片**整体替换**某文档的切片（copy-on-write）。
 *
 * 为什么不能「先 `removeStoredChunksByDocument` 再 `push`」：
 * 那两步之间的失败（或只是未来某次重构引入的异常）会让文档处于
 * 「正文是新的、切片一条都没有」的状态 —— 界面上看不出任何异常，
 * 只是这份知识从此检索不到。数据库那边这一点由事务兜住，
 * 内存实现没有事务，只能靠「先把完整新状态拼好、再一次性生效」模拟出同一语义。
 *
 * 另一个容易写错的点：过滤必须**先于**任何写入完成。
 * 边遍历边 splice 会让索引错位，结果是删掉了一半旧切片、留下一半。
 */
export function replaceStoredChunksForDocument(
  documentId: string,
  chunks: StoredKnowledgeChunk[],
): void {
  const kept = knowledgeChunks.filter((chunk) => chunk.documentId !== documentId);
  // 单线程下这里没有可观测的中间态：拼接完成后才清空并写回
  const next = [...kept, ...chunks];
  knowledgeChunks.length = 0;
  knowledgeChunks.push(...next);
}

/**
 * 商品删除时的知识级联。
 *
 * 与数据库保持一致：`knowledge_documents.product_id` 与
 * `knowledge_gaps.product_id` 都是 CASCADE，`knowledge_chunks` 因 document 被删而连带清除。
 */
export function removeStoredKnowledgeByProduct(productId: string): void {
  for (let index = knowledgeDocuments.length - 1; index >= 0; index -= 1) {
    if (knowledgeDocuments[index]?.productId === productId) {
      removeStoredKnowledgeDocument(knowledgeDocuments[index].id);
    }
  }
  for (let index = knowledgeChunks.length - 1; index >= 0; index -= 1) {
    if (knowledgeChunks[index]?.productId === productId) {
      knowledgeChunks.splice(index, 1);
    }
  }
  for (let index = knowledgeGaps.length - 1; index >= 0; index -= 1) {
    if (knowledgeGaps[index]?.productId === productId) {
      knowledgeGaps.splice(index, 1);
    }
  }
}

export function listStoredKnowledgeGaps(): StoredKnowledgeGap[] {
  return knowledgeGaps;
}

export function findStoredKnowledgeGap(id: string): StoredKnowledgeGap | undefined {
  return knowledgeGaps.find((gap) => gap.id === id);
}

export function putStoredKnowledgeGap(gap: StoredKnowledgeGap): void {
  knowledgeGaps.unshift(gap);
}

export function replaceStoredKnowledgeGap(gap: StoredKnowledgeGap): void {
  const index = knowledgeGaps.findIndex((item) => item.id === gap.id);
  if (index >= 0) {
    knowledgeGaps[index] = gap;
  }
}

/** 仅测试使用：把知识库复位为种子基线（文档齐、切片空、无缺口） */
export function resetStoredKnowledge(): void {
  knowledgeDocuments.splice(
    0,
    knowledgeDocuments.length,
    ...MOCK_KNOWLEDGE_DOCUMENTS.map((seed, index) => {
      const createdAt = new Date();
      return {
        id: `kdoc_${String(index + 1).padStart(3, "0")}`,
        businessId: MOCK_BUSINESS.id,
        name: seed.name,
        type: seed.type,
        source: seed.source,
        summary: seed.summary,
        content: seed.content,
        productId: seed.productId,
        indexStatus: "pending" as KnowledgeIndexStatus,
        indexError: null,
        createdAt,
        updatedAt: createdAt,
      };
    }),
  );
  knowledgeChunks.length = 0;
  knowledgeGaps.length = 0;
}

/* ------------------------------------------------------------------ */
/* 客服会话（S5）                                                      */
/* ------------------------------------------------------------------ */

export interface StoredConversation {
  id: string;
  businessId: string;
  customerName: string;
  customerLabel: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  productId: string | null;
  tags: string[];
  unreadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredCustomerMessage {
  id: string;
  conversationId: string;
  role: ChatMessage["role"];
  content: string;
  grounded: boolean | null;
  intent: string | null;
  confidence: number | null;
  /** 引用快照；领域层读出来时仍是 KnowledgeSource[] */
  citations: unknown[];
  needsHuman: boolean;
  knowledgeGapId: string | null;
  retrievedCount: number;
  createdAt: Date;
}

/**
 * 种子会话：内置模拟消费者（任务书第二十三节）。
 *
 * 刻意**只放消费者那一句提问**，不放 AI 回答 —— 见 `@/lib/mock/knowledge.ts`
 * 文件头的说明。打开页面时左栏是一排「待回复咨询」，
 * 点开任意一条，AI 必须真的去检索知识库才有得答。
 */
function buildSeedConversations(): {
  conversations: StoredConversation[];
  messages: StoredCustomerMessage[];
} {
  const now = Date.now();
  const conversations: StoredConversation[] = [];
  const messages: StoredCustomerMessage[] = [];

  MOCK_SIMULATED_CONSUMERS.forEach((consumer, index) => {
    const id = `conv_${String(index + 1).padStart(3, "0")}`;
    // 每条间隔 7 分钟，保证列表按「最近活跃」排序时有稳定且自然的先后
    const askedAt = new Date(now - (index + 1) * 7 * 60 * 1000);
    conversations.push({
      id,
      businessId: MOCK_BUSINESS.id,
      customerName: consumer.customerName,
      customerLabel: consumer.customerLabel,
      channel: consumer.channel,
      status: "bot",
      productId: consumer.productId,
      tags: [...consumer.tags],
      unreadCount: 1,
      createdAt: askedAt,
      updatedAt: askedAt,
    });
    messages.push({
      id: `msg_${String(index + 1).padStart(3, "0")}_c`,
      conversationId: id,
      role: "customer",
      content: consumer.question,
      grounded: null,
      intent: null,
      confidence: null,
      citations: [],
      needsHuman: false,
      knowledgeGapId: null,
      retrievedCount: 0,
      createdAt: askedAt,
    });
  });

  return { conversations, messages };
}

const seedState = buildSeedConversations();
const conversations: StoredConversation[] = seedState.conversations;
const customerMessages: StoredCustomerMessage[] = seedState.messages;

export function listStoredConversations(): StoredConversation[] {
  // 最近活跃在前 —— 与数据库的 ORDER BY updated_at DESC 同一口径
  return [...conversations].sort(
    (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
  );
}

export function findStoredConversation(id: string): StoredConversation | undefined {
  return conversations.find((conversation) => conversation.id === id);
}

export function putStoredConversation(conversation: StoredConversation): void {
  conversations.unshift(conversation);
}

export function replaceStoredConversation(conversation: StoredConversation): void {
  const index = conversations.findIndex((item) => item.id === conversation.id);
  if (index >= 0) {
    conversations[index] = conversation;
  }
}

export function listStoredCustomerMessages(
  conversationId: string,
): StoredCustomerMessage[] {
  return customerMessages
    .filter((message) => message.conversationId === conversationId)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

export function putStoredCustomerMessage(message: StoredCustomerMessage): void {
  customerMessages.push(message);
}

/** 商品下架时只解绑会话（对应数据库的 ON DELETE SET NULL） */
export function detachStoredConversationsByProduct(productId: string): void {
  for (const conversation of conversations) {
    if (conversation.productId === productId) {
      conversation.productId = null;
    }
  }
}

/** 仅测试使用：把会话复位为内置模拟消费者 */
export function resetStoredConversations(): void {
  const next = buildSeedConversations();
  conversations.splice(0, conversations.length, ...next.conversations);
  customerMessages.splice(0, customerMessages.length, ...next.messages);
}

/* ------------------------------------------------------------------ */
/* AI 直播间（S6）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 直播数据同样存**表行形状**：时间留 `Date`（展示字符串在读时现算），
 * 与其它 Mock 仓储保持同一约定 ——「派生字段不落库」。
 *
 * 初始状态：一场**正在直播**的场次 + 若干**未分析**的历史评论。
 * 评论不带 AI 分类结果（`intent` / `priority` 为 null），
 * 因为那些结论必须由真实链路现场产生（任务书第二十一节）。
 */
export interface StoredLiveSession {
  id: string;
  businessId: string;
  title: string;
  productId: string;
  productName: string;
  status: LiveSessionStatus;
  startedAt: Date;
  endedAt: Date | null;
  commentsCount: number;
  aiHandledCount: number;
  hostTranscript?: string;
  rehearsalReport?: import("@/types").LiveRehearsalReport | null;
}

export interface StoredLiveComment {
  id: string;
  sessionId: string;
  authorName: string;
  content: string;
  intent: LiveIntent | null;
  priority: LivePriority | null;
  handled: boolean;
  createdAt: Date;
}

export interface StoredLiveSuggestion {
  id: string;
  commentId: string;
  commentContent: string;
  intent: LiveIntent;
  priority: LivePriority;
  shouldRespond: boolean;
  responseMode: LiveResponseMode;
  hostSuggestion: string;
  suggestedReply: string;
  sellingAngle: string | null;
  grounded: boolean;
  citations: KnowledgeSource[];
  recommendedAction: LiveRecommendedAction;
  riskNotes: string[];
  confidence: number;
  durationMs: number;
  failureMessage: string | null;
  createdAt: Date;
}

/** 种子场次：开始时间回推 24 分 18 秒，使时长展示贴近演示数据 */
function buildSeedLiveSession(): StoredLiveSession {
  return {
    id: MOCK_LIVE_SESSION.id,
    businessId: MOCK_BUSINESS.id,
    title: MOCK_LIVE_SESSION.title,
    productId: MOCK_LIVE_PRODUCT_ID,
    productName: MOCK_LIVE_PRODUCT_NAME,
    status: "live",
    startedAt: new Date(Date.now() - (24 * 60 + 18) * 1000),
    endedAt: null,
    commentsCount: 0,
    aiHandledCount: 0,
  };
}

function buildSeedLiveState(): {
  sessions: StoredLiveSession[];
  comments: StoredLiveComment[];
} {
  const session = buildSeedLiveSession();
  const now = Date.now();
  const comments: StoredLiveComment[] = buildSeedLiveComments(session.id).map(
    (comment, index) => ({
      id: comment.id,
      sessionId: session.id,
      authorName: comment.authorName,
      content: comment.content,
      intent: null,
      priority: null,
      handled: false,
      // 种子评论按 1 分钟间隔回推，保证正序排列稳定
      createdAt: new Date(now - (MOCK_LIVE_SESSION_STATE_SIZE - index) * 60 * 1000),
    }),
  );
  session.commentsCount = comments.length;
  return { sessions: [session], comments };
}

/** 种子评论条数（回推时间用，避免依赖运行时数组长度） */
const MOCK_LIVE_SESSION_STATE_SIZE = 6;

const seedLive = buildSeedLiveState();
const liveSessions: StoredLiveSession[] = seedLive.sessions;
const liveComments: StoredLiveComment[] = seedLive.comments;
const liveSuggestions: StoredLiveSuggestion[] = [];

/** 最近一场（列表首项即最近创建） */
export function findLatestStoredLiveSession(): StoredLiveSession | undefined {
  return liveSessions[0];
}

export function findStoredLiveSession(id: string): StoredLiveSession | undefined {
  return liveSessions.find((session) => session.id === id);
}

/** 全部场次（最近创建在前 —— 与 DB 的 ORDER BY started_at DESC 同一口径） */
export function listStoredLiveSessions(): StoredLiveSession[] {
  return [...liveSessions];
}

export function putStoredLiveSession(session: StoredLiveSession): void {
  liveSessions.unshift(session);
}

export function replaceStoredLiveSession(session: StoredLiveSession): void {
  const index = liveSessions.findIndex((item) => item.id === session.id);
  if (index >= 0) {
    liveSessions[index] = session;
  }
}

export function listStoredLiveComments(sessionId: string): StoredLiveComment[] {
  return liveComments
    .filter((comment) => comment.sessionId === sessionId)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

export function findStoredLiveComment(id: string): StoredLiveComment | undefined {
  return liveComments.find((comment) => comment.id === id);
}

export function putStoredLiveComment(comment: StoredLiveComment): void {
  liveComments.push(comment);
}

export function replaceStoredLiveComment(comment: StoredLiveComment): void {
  const index = liveComments.findIndex((item) => item.id === comment.id);
  if (index >= 0) {
    liveComments[index] = comment;
  }
}

export function listStoredLiveSuggestions(sessionId: string): StoredLiveSuggestion[] {
  // 最新在前 —— 与数据库 ORDER BY created_at DESC 同一口径
  return liveSuggestions
    .filter((suggestion) =>
      liveComments.some(
        (comment) =>
          comment.id === suggestion.commentId && comment.sessionId === sessionId,
      ),
    )
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

export function findStoredLiveSuggestionByComment(
  commentId: string,
): StoredLiveSuggestion | undefined {
  return liveSuggestions.find((suggestion) => suggestion.commentId === commentId);
}

export function putStoredLiveSuggestion(suggestion: StoredLiveSuggestion): void {
  const index = liveSuggestions.findIndex((item) => item.id === suggestion.id);
  if (index === -1) liveSuggestions.push(suggestion);
  else liveSuggestions[index] = suggestion;
}

/** 模拟指标：没有真实来源，如实作为演示常量返回 */
export function getStoredLiveStats() {
  return MOCK_LIVE_STATS;
}

/** 仅测试使用：把直播间复位为种子基线（一场直播 + 未分析评论 + 无建议） */
export function resetStoredLive(): void {
  const next = buildSeedLiveState();
  liveSessions.splice(0, liveSessions.length, ...next.sessions);
  liveComments.splice(0, liveComments.length, ...next.comments);
  liveSuggestions.length = 0;
}

/* ------------------------------------------------------------------ */
/* 经营日报（S6-B）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 经营日报**刻意没有种子**。
 *
 * 其余 Mock 数据都有种子（商品、知识、直播评论），因为它们是「演示场景的输入」；
 * 日报不一样 —— 它是 AI 的**产出**。预置一份固定日报就等于让页面显示一份
 * 「看起来是 AI 生成的、其实是一个常量」的结论，这正是任务书第十八节明令禁止的。
 * 因此这里从空开始：没有日报时界面显示「尚未生成」，点一次真的调一次模型。
 */
const businessReports: BusinessReport[] = [];

export function listStoredBusinessReports(): BusinessReport[] {
  // 最近创建在前 —— 与 DB 的 ORDER BY created_at DESC 同一口径
  return [...businessReports].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

export function findStoredBusinessReport(id: string): BusinessReport | undefined {
  return businessReports.find((report) => report.id === id);
}

export function putStoredBusinessReport(report: BusinessReport): void {
  businessReports.unshift(report);
}

/** 仅测试使用：清空经营日报 */
export function resetStoredBusinessReports(): void {
  businessReports.length = 0;
}

/* ------------------------------------------------------------------ */
/* 账号与会话（S7）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 账号与会话的 Mock 存储。
 *
 * 与其它 Mock 数据一样是**进程内内存**，进程重启即还原 —— 这正是
 * `DATA_SOURCE=mock` 的语义，页面角标会如实写成「演示数据（Mock）」。
 * 想要「重启后还在」的登录，用 `DATA_SOURCE=local`（本地 PGlite）。
 *
 * 初始**没有任何账号**。绝不预置「默认账号 + 默认密码」：那种东西留在代码里，
 * 迟早会跟着某个部署一起上线，变成一个人人皆知的后门。
 */
export interface StoredMockUser {
  id: string;
  businessId: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
}

export interface StoredMockSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date;
}

const mockUsers = sharedMockCollection<StoredMockUser[]>("users", () => []);
const mockSessions = sharedMockCollection<StoredMockSession[]>("sessions", () => []);

export function listStoredUsers(): StoredMockUser[] {
  return mockUsers;
}

export function findStoredUserByEmail(email: string): StoredMockUser | undefined {
  return mockUsers.find((user) => user.email === email);
}

export function findStoredUserById(id: string): StoredMockUser | undefined {
  return mockUsers.find((user) => user.id === id);
}

export function putStoredUser(user: StoredMockUser): void {
  mockUsers.push(user);
}

export function countStoredUsers(): number {
  return mockUsers.length;
}

/** 仅测试使用 */
export function clearStoredUsers(): void {
  mockUsers.length = 0;
}

export function findStoredSessionByTokenHash(
  tokenHash: string,
): StoredMockSession | undefined {
  return mockSessions.find((session) => session.tokenHash === tokenHash);
}

export function putStoredSession(session: StoredMockSession): void {
  mockSessions.push(session);
}

export function removeStoredSessionByTokenHash(tokenHash: string): void {
  const index = mockSessions.findIndex(
    (session) => session.tokenHash === tokenHash,
  );
  if (index >= 0) {
    mockSessions.splice(index, 1);
  }
}

/** 与数据库的 `sessions.user_id ON DELETE CASCADE` 同义 */
export function removeStoredSessionsByUser(userId: string): number {
  let removed = 0;
  for (let index = mockSessions.length - 1; index >= 0; index -= 1) {
    if (mockSessions[index]?.userId === userId) {
      mockSessions.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

export function removeExpiredStoredSessions(now: Date = new Date()): number {
  let removed = 0;
  for (let index = mockSessions.length - 1; index >= 0; index -= 1) {
    const session = mockSessions[index];
    if (session && session.expiresAt.getTime() <= now.getTime()) {
      mockSessions.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

export function touchStoredSession(id: string, now: Date = new Date()): void {
  const session = mockSessions.find((item) => item.id === id);
  if (session) {
    session.lastUsedAt = now;
  }
}

/** 仅测试使用 */
export function clearStoredSessions(): void {
  mockSessions.length = 0;
}
