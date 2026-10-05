/**
 * 数据库行 → 领域类型 的映射
 *
 * 为什么要单独一层：
 * 表结构（snake_case、jsonb、timestamptz、numeric）与领域模型（camelCase、
 * 展示用字符串时间）是两套约定。把转换集中在这里，仓储实现只负责查询，
 * 页面永远拿到与 Mock 数据源完全一致的结构 —— 这是「切数据源不改页面」的前提。
 *
 * 映射过程中对 jsonb 与数值做了防御性归一化，避免脏数据直接把页面打崩。
 */

import { CONTENT_FORMATS, CONTENT_PLATFORMS, CONTENT_STATUSES } from "@/lib/content-options";
import { formatDateTime, formatDuration, formatRelativeTime, formatTime, toDate } from "@/lib/datetime";
import {
  isCustomerIntent,
  isKnowledgeDocumentType,
  isLiveIntent,
  isLivePriority,
  LIVE_INTENTS,
  LIVE_PRIORITIES,
  LIVE_RECOMMENDED_ACTIONS,
  LIVE_RESPONSE_MODES,
  type AnalyticsReport,
  type AnalyticsSnapshot,
  type BrandProfile,
  type BusinessProfile,
  type BusinessReport,
  type ChatMessage,
  type ChunkMetadata,
  type ContentItem,
  type CustomerConversation,
  type KnowledgeChunk,
  type KnowledgeDocument,
  type KnowledgeGapRecord,
  type KnowledgeSource,
  type LiveComment,
  type LiveSession,
  type LiveSuggestion,
  type OwnerTwin,
  type Product,
  type ProductDNA,
} from "@/types";

import type {
  AgentTaskRow,
  AgentWorkflowRow,
  BrandProfileRow,
  BusinessReportRow,
  BusinessRow,
  ContentRow,
  CustomerConversationRow,
  CustomerMessageRow,
  KnowledgeChunkRow,
  KnowledgeDocumentRow,
  KnowledgeGapRow,
  LiveCommentRow,
  LiveSessionRow,
  LiveSuggestionRow,
  OwnerProfileRow,
  ProductDnaRow,
  ProductRow,
  SessionRow,
  UserRow,
} from "@/db/schema";

import type {
  AgentTaskRecord,
  AgentWorkflowRecord,
  SessionRecord,
  UserCredentialRecord,
  UserRecord,
} from "../types";
import { computeBrandCompleteness } from "../brand-profile";

/** 把任意值收敛为 string[]，非数组返回空数组 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * jsonb 列 → 普通对象。
 * 数组与标量一律视为无效输入（这些列约定只存对象），返回 null 而不是硬塞进类型里。
 */
function toJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** 商品经营数据归一化，字段缺失时补 0 */
function toMetrics(value: unknown): Product["metrics"] {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const pick = (key: string): number => {
    const raw = source[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  };
  return { views: pick("views"), inquiries: pick("inquiries"), conversions: pick("conversions") };
}

/** 价格：numeric 以 number 模式读回，仍做一次兜底 */
function toPrice(value: number | string | null): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function mapProductRow(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    subCategory: row.subCategory,
    price: toPrice(row.price),
    unit: row.unit,
    stock: row.stock,
    origin: row.origin,
    specification: row.specification,
    storageMethod: row.storageMethod,
    shelfLife: row.shelfLife,
    imageUrl: row.imageUrl,
    analysisStatus: row.analysisStatus,
    updatedAt: formatDateTime(row.updatedAt),
    metrics: toMetrics(row.metrics),
    tags: toStringArray(row.tags),
  };
}

export function mapProductDnaRow(row: ProductDnaRow): ProductDNA {
  return {
    productId: row.productId,
    category: row.category,
    subCategory: row.subCategory,
    visualFeatures: toStringArray(row.visualFeatures),
    coreFeatures: toStringArray(row.coreFeatures),
    sellingPoints: toStringArray(row.sellingPoints),
    targetUsers: toStringArray(row.targetUsers),
    // 数据库列名 scenarios ↔ 领域字段 consumptionScenarios
    consumptionScenarios: toStringArray(row.scenarios),
    userPainPoints: toStringArray(row.painPoints),
    marketingAngles: toStringArray(row.marketingAngles),
    riskNotes: toStringArray(row.riskNotes),
    aiVersion: row.aiVersion,
    confidence: Number.isFinite(row.confidence) ? row.confidence : 0,
    generatedAt: formatDateTime(row.updatedAt ?? row.createdAt),
    approved: row.approved,
  };
}

export function mapBusinessRow(row: BusinessRow): BusinessProfile {
  return {
    id: row.id,
    name: row.name,
    shortName: row.shortName || row.name,
    description: row.description,
    owner: row.owner,
    location: row.location,
    mainCategory: row.mainCategory,
    storeCount: row.storeCount,
    channels: toStringArray(row.channels),
  };
}

export function mapOwnerProfileRow(row: OwnerProfileRow): OwnerTwin {
  return {
    displayName: row.displayName,
    avatarLabel: row.avatarLabel || row.displayName.slice(0, 1),
    businessPhilosophy: toStringArray(row.businessPhilosophy),
    tone: toStringArray(row.tone),
    salesStyle: row.salesStyle,
    targetCustomers: toStringArray(row.targetCustomers),
    forbiddenExpressions: toStringArray(row.forbiddenExpressions),
  };
}

/** 数据库时间 → 展示字符串；供通知等场景复用 */
export function toDisplayTime(value: Date | null): string {
  const date = toDate(value);
  return date ? formatDateTime(date) : "";
}

/** 品牌档案行 → 领域类型。completeness 一律现算，不落库（派生量） */
export function mapBrandProfileRow(row: BrandProfileRow): BrandProfile {
  return {
    positioning: row.positioning,
    brandStory: row.brandStory,
    slogan: row.slogan,
    ipConcept: row.ipConcept,
    brandValues: toStringArray(row.brandValues),
    targetAudience: toStringArray(row.targetAudience),
    // 数据库列 brand_personality ↔ AI 契约 brandKeywords
    brandPersonality: toStringArray(row.brandPersonality),
    // 数据库列 tone_of_voice ↔ AI 契约 tone
    toneOfVoice: toStringArray(row.toneOfVoice),
    // 数据库列 visual_keywords ↔ AI 契约 visualDirection
    visualKeywords: toStringArray(row.visualKeywords),
    riskNotes: toStringArray(row.riskNotes),
    aiVersion: row.aiVersion,
    confidence: Number.isFinite(row.confidence) ? row.confidence : 0,
    approved: row.approved,
    updatedAt: formatDateTime(row.updatedAt ?? row.createdAt),
    completeness: computeBrandCompleteness({
      positioning: row.positioning,
      brandStory: row.brandStory,
      slogan: row.slogan,
      ipConcept: row.ipConcept,
      brandValues: toStringArray(row.brandValues),
      targetAudience: toStringArray(row.targetAudience),
      brandPersonality: toStringArray(row.brandPersonality),
      toneOfVoice: toStringArray(row.toneOfVoice),
      visualKeywords: toStringArray(row.visualKeywords),
    }),
  };
}

export function mapAgentTaskRow(row: AgentTaskRow): AgentTaskRecord {
  return {
    id: row.id,
    agentType: row.agentType,
    title: row.title,
    status: row.status,
    progress: Number.isFinite(row.progress) ? row.progress : 0,
    productId: row.productId,
    workflowId: row.workflowId,
    input: toJsonObject(row.input),
    output: toJsonObject(row.output),
    errorMessage: row.errorMessage,
    durationMs:
      row.durationMs !== null && Number.isFinite(row.durationMs)
        ? row.durationMs
        : null,
    createdAt: formatDateTime(row.createdAt),
    completedAt: row.completedAt ? formatDateTime(row.completedAt) : null,
  };
}

/**
 * 工作流行 → 工作流记录（S4-1）。
 *
 * `status` 直接用：它是 `workflow_status` 枚举列，数据库保证取值合法，
 * 与应用层的 `WorkflowStatus` 是同一套值（这与 `contents.platform` 那类
 * 刻意用 text 的列不同，不需要 `toEnumValue` 回落）。
 */
export function mapAgentWorkflowRow(row: AgentWorkflowRow): AgentWorkflowRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    goal: row.goal,
    status: row.status,
    plan: toJsonObject(row.plan),
    summary: toJsonObject(row.summary),
    errorMessage: row.errorMessage,
    createdAt: formatDateTime(row.createdAt),
    completedAt: row.completedAt ? formatDateTime(row.completedAt) : null,
  };
}

/**
 * 文本枚举列 → 领域联合类型。
 *
 * 这些列刻意用 `text` 而不是 pgEnum（便于渠道演进），代价是数据库里可能存在
 * 应用层已经不再认识的值（旧数据 / 手工改库）。此时**回落到默认值**而不是把
 * 非法字符串硬塞进联合类型 —— 让页面显示得保守一点，好过整个列表崩掉。
 */
function toEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof value !== "string") {
    return fallback;
  }
  return allowed.find((item) => item === value) ?? fallback;
}

/** 内容表现数据归一化，字段缺失时补 0（与商品经营数据同一处理方式） */
function toContentMetrics(value: unknown): ContentItem["metrics"] {
  const source = (
    typeof value === "object" && value !== null ? value : {}
  ) as Record<string, unknown>;
  const pick = (key: string): number => {
    const raw = source[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  };
  return {
    views: pick("views"),
    likes: pick("likes"),
    comments: pick("comments"),
    shares: pick("shares"),
    engagementRate: pick("engagementRate"),
  };
}

/**
 * 内容行 → 领域类型。
 * 槽位三列（product_id / platform / format）与其唯一索引是表级约束，
 * 这里只做「非法枚举值回落」的防御，不重复业务校验。
 */
export function mapContentRow(row: ContentRow): ContentItem {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.productName,
    title: row.title,
    hook: row.hook,
    body: row.body,
    cta: row.cta,
    hashtags: toStringArray(row.hashtags),
    visualSuggestions: toStringArray(row.visualSuggestions),
    // 数据库列 shot_list ↔ AI 契约 scenes
    shotList: toStringArray(row.shotList),
    voiceover: row.voiceover,
    platform: toEnumValue(row.platform, CONTENT_PLATFORMS, "douyin"),
    // 数据库列 format ↔ AI 契约 type
    format: toEnumValue(row.format, CONTENT_FORMATS, "short-video"),
    status: toEnumValue(row.status, CONTENT_STATUSES, "draft"),
    createdAt: formatDateTime(row.createdAt),
    updatedAt: formatDateTime(row.updatedAt ?? row.createdAt),
    aiVersion: row.aiVersion,
    confidence: Number.isFinite(row.confidence) ? row.confidence : 0,
    riskNotes: toStringArray(row.riskNotes),
    metrics: toContentMetrics(row.metrics),
  };
}

/* ------------------------------------------------------------------ */
/* 知识库 / 知识缺口 / 客服会话（S5）                                  */
/* ------------------------------------------------------------------ */

/**
 * jsonb → ChunkMetadata。
 *
 * 元数据里的字段是**展示与过滤**用的（文档名、章节、归属商品），
 * 脏值会让引用面板显示空白。因此逐字段兜底，缺什么补什么，
 * 而不是整体判空返回 null —— 一份可用的元数据比没有强。
 */
function toChunkMetadata(
  value: unknown,
  fallback: { title: string; sourceType: string; productId: string | null; chunkIndex: number },
): ChunkMetadata {
  const source = (typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {}) as Record<string, unknown>;

  const pickString = (key: string, fallbackValue: string): string =>
    typeof source[key] === "string" ? (source[key] as string) : fallbackValue;
  const pickNumber = (key: string, fallbackValue: number): number => {
    const raw = source[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : fallbackValue;
  };
  const rawProductId = source.productId;
  const productId =
    rawProductId === null
      ? null
      : typeof rawProductId === "string"
        ? rawProductId
        : fallback.productId;

  return {
    documentName: pickString("documentName", fallback.title),
    sourceType: pickString("sourceType", fallback.sourceType),
    productId,
    section: pickString("section", ""),
    chunkIndex: pickNumber("chunkIndex", fallback.chunkIndex),
    start: pickNumber("start", 0),
    end: pickNumber("end", 0),
    /**
     * 索引版本**没有兜底值**：读不到就是读不到。
     * 给它补一个「rag-v1」会把「这条向量其实来自更早的流水线」
     * 伪装成「当前版本」—— 而版本存在的唯一意义就是区分这件事。
     */
    ...(typeof source.indexVersion === "string"
      ? { indexVersion: source.indexVersion }
      : {}),
  };
}

/**
 * 知识文档行 → 领域类型。
 *
 * `chunkCount` 是派生量，必须由调用方从切片表分组统计后传入（见
 * `countChunksByDocuments`）—— 放在这里做意味着每映射一行就查一次库。
 */
export function mapKnowledgeDocumentRow(
  row: KnowledgeDocumentRow,
  chunkCount: number,
): KnowledgeDocument {
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    type: row.type,
    source: row.source,
    summary: row.summary,
    content: row.content,
    productId: row.productId,
    indexStatus: row.indexStatus,
    indexError: row.indexError,
    chunkCount: Number.isFinite(chunkCount) ? chunkCount : 0,
    updatedAt: formatDateTime(row.updatedAt ?? row.createdAt),
    createdAt: formatDateTime(row.createdAt),
  };
}

/** 知识切片行 → 领域类型。**向量在映射处被丢掉**（领域层看不到它） */
export function mapKnowledgeChunkRow(row: KnowledgeChunkRow): KnowledgeChunk {
  return {
    id: row.id,
    documentId: row.documentId,
    businessId: row.businessId,
    productId: row.productId,
    sourceType: row.sourceType,
    title: row.title,
    chunkIndex: Number.isFinite(row.chunkIndex) ? row.chunkIndex : 0,
    content: row.content,
    metadata: toChunkMetadata(row.metadata, {
      title: row.title,
      sourceType: row.sourceType,
      productId: row.productId,
      chunkIndex: Number.isFinite(row.chunkIndex) ? row.chunkIndex : 0,
    }),
    createdAt: formatDateTime(row.createdAt),
  };
}

/** 供向量检索使用：把行直接转成「切片 + 相似度」，中间不产生多余对象 */
export function toChunkSearchHit(
  row: KnowledgeChunkRow,
  similarity: number,
): { chunk: KnowledgeChunk; similarity: number } {
  return {
    chunk: mapKnowledgeChunkRow(row),
    similarity: Number.isFinite(similarity) ? similarity : 0,
  };
}

export function mapKnowledgeGapRow(row: KnowledgeGapRow): KnowledgeGapRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    productId: row.productId,
    question: row.question,
    normalizedQuestion: row.normalizedQuestion,
    intent: row.intent,
    reason: row.reason,
    status: row.status,
    occurrenceCount: Number.isFinite(row.occurrenceCount) ? row.occurrenceCount : 1,
    firstSeenAt: formatDateTime(row.firstSeenAt),
    lastSeenAt: formatDateTime(row.lastSeenAt),
    resolvedDocumentId: row.resolvedDocumentId,
  };
}

/**
 * 会话行 → 领域类型。
 *
 * `lastMessage` / `messageCount` / `updatedAtText` 都是派生字段：
 * 前三项由 SQL 侧的一次聚合查询算出（见 `conversation.repository.ts`），
 * 这里只做兜底。
 */
export function mapCustomerConversationRow(
  row: CustomerConversationRow,
  derived: { lastMessage: string; messageCount: number },
): CustomerConversation {
  return {
    id: row.id,
    customerName: row.customerName,
    customerLabel: row.customerLabel,
    channel: row.channel,
    lastMessage: derived.lastMessage,
    updatedAtText: formatRelativeTime(row.updatedAt ?? row.createdAt),
    unreadCount: Number.isFinite(row.unreadCount) ? row.unreadCount : 0,
    status: row.status,
    tags: toStringArray(row.tags),
    productId: row.productId,
    messageCount: Number.isFinite(derived.messageCount) ? derived.messageCount : 0,
  };
}

export function mapCustomerMessageRow(row: CustomerMessageRow): ChatMessage {
  const sources = toKnowledgeSources(row.citations);

  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    createdAtText: formatDateTime(row.createdAt),
    confidence:
      row.confidence !== null && Number.isFinite(row.confidence)
        ? row.confidence
        : undefined,
    grounded: row.grounded ?? undefined,
    intent: isCustomerIntent(row.intent) ? row.intent : undefined,
    knowledgeSources: sources.length > 0 ? sources : undefined,
    needsHuman: row.needsHuman ? true : undefined,
    knowledgeGapId: row.knowledgeGapId ?? undefined,
    retrievedCount:
      Number.isFinite(row.retrievedCount) && row.retrievedCount > 0
        ? row.retrievedCount
        : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* 账号与会话（S7）                                                    */
/* ------------------------------------------------------------------ */

/** `users` 行 → `UserRecord`（**刻意丢掉 `passwordHash`**） */
export function mapUserRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    email: row.email,
    name: row.name,
    createdAt: formatDateTime(row.createdAt),
  };
}

/**
 * `users` 行 → `UserCredentialRecord`（含密码哈希）。
 *
 * 单独一个函数、单独一个类型：只要是有意为之的一处能读到哈希，
 * 而不是「读用户默认就带着哈希」。调用点越少越容易审。
 */
export function mapUserCredentialRow(row: UserRow): UserCredentialRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    email: row.email,
    name: row.name,
    passwordHash: row.passwordHash,
  };
}

/** `sessions` 行 → `SessionRecord`（不含 token，明文与哈希都不带出来） */
export function mapSessionRow(
  row: SessionRow,
  businessId: string,
): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    businessId,
    createdAt: formatDateTime(row.createdAt),
    expiresAt: formatDateTime(row.expiresAt),
    lastUsedAt: formatDateTime(row.lastUsedAt),
  };
}

/* ------------------------------------------------------------------ */
/* AI 直播间 / 经营日报（S7 补齐）                                     */
/* ------------------------------------------------------------------ */

/** 场次时长：直播中算到「现在」，已结束算到结束时间 */
function liveDurationText(
  startedAt: Date,
  endedAt: Date | null,
  status: string,
  now = Date.now(),
): string {
  const end =
    endedAt ?? (status === "live" ? new Date(now) : startedAt);
  return formatDuration((end.getTime() - startedAt.getTime()) / 1000);
}

export function mapLiveSessionRow(row: LiveSessionRow): LiveSession {
  return {
    id: row.id,
    title: row.title,
    productId: row.productId,
    productName: row.productName,
    status: toEnumValue(row.status, ["idle", "live", "ended"], "idle"),
    startedAt: formatDateTime(row.startedAt),
    endedAt: row.endedAt ? formatDateTime(row.endedAt) : null,
    durationText: liveDurationText(row.startedAt, row.endedAt, row.status),
    commentsCount: Number.isFinite(row.commentsCount) ? row.commentsCount : 0,
    aiHandledCount: Number.isFinite(row.aiHandledCount) ? row.aiHandledCount : 0,
    hostTranscript: row.hostTranscript,
    rehearsalReport: row.rehearsalReport,
  };
}

export function mapLiveCommentRow(row: LiveCommentRow): LiveComment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    authorName: row.authorName,
    content: row.content,
    intent: isLiveIntent(row.intent) ? row.intent : null,
    priority: isLivePriority(row.priority) ? row.priority : null,
    handled: row.handled,
    createdAtText: formatTime(row.createdAt),
  };
}

/** jsonb 数组 → KnowledgeSource[]（直播建议引用与客服消息引用共用同一解析） */
function toKnowledgeSources(value: unknown): KnowledgeSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const sources: KnowledgeSource[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const { id, documentId, chunkId, title, type } = record;
    if (
      typeof id !== "string" ||
      typeof documentId !== "string" ||
      typeof chunkId !== "string" ||
      typeof title !== "string" ||
      !isKnowledgeDocumentType(type)
    ) {
      continue;
    }
    const score = record.score;
    sources.push({
      id,
      documentId,
      chunkId,
      title,
      type,
      snippet: typeof record.snippet === "string" ? record.snippet : "",
      score: typeof score === "number" && Number.isFinite(score) ? score : 0,
    });
  }
  return sources;
}

export function mapLiveSuggestionRow(row: LiveSuggestionRow): LiveSuggestion {
  return {
    id: row.id,
    commentId: row.commentId,
    commentContent: row.commentContent,
    intent: toEnumValue(row.intent, LIVE_INTENTS, "other"),
    priority: toEnumValue(row.priority, LIVE_PRIORITIES, "low"),
    shouldRespond: row.shouldRespond,
    responseMode: toEnumValue(row.responseMode, LIVE_RESPONSE_MODES, "ignore"),
    hostSuggestion: row.hostSuggestion,
    suggestedReply: row.suggestedReply,
    sellingAngle: row.sellingAngle,
    grounded: row.grounded,
    citations: toKnowledgeSources(row.citations),
    recommendedAction: toEnumValue(
      row.recommendedAction,
      LIVE_RECOMMENDED_ACTIONS,
      "ignore",
    ),
    riskNotes: toStringArray(row.riskNotes),
    confidence: Number.isFinite(row.confidence) ? row.confidence : 0,
    durationMs: Number.isFinite(row.durationMs) ? row.durationMs : 0,
    createdAtText: formatTime(row.createdAt),
    failureMessage: row.failureMessage,
  };
}

export function mapBusinessReportRow(row: BusinessReportRow): BusinessReport {
  return {
    id: row.id,
    businessId: row.businessId,
    snapshot: row.snapshot as AnalyticsSnapshot,
    report: row.report as AnalyticsReport,
    createdAt: formatDateTime(row.createdAt),
  };
}
