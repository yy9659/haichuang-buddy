/**
 * 仓储层接口定义
 *
 * 目的：让页面与数据来源解耦。S0 阶段背后是 Mock 实现，S1 起替换为
 * Drizzle + Supabase 实现，页面代码不需要改动。
 *
 * 约束：
 * - 接口只暴露业务语义（listProducts / getById），不泄露 SQL 与表结构
 * - 一律返回 Promise，读取失败时由实现层抛出 AppError（服务层收敛为 Result）
 * - 返回领域类型（src/types），不返回数据库行类型
 */

import type {
  AgentId,
  AgentNotification,
  AgentStatus,
  AgentWorkflowSummary,
  AnalyticsOverview,
  AnalyticsReport,
  AnalyticsSnapshot,
  BrandProfile,
  BusinessGoal,
  BusinessProfile,
  BusinessReport,
  ChatMessage,
  ChatRole,
  ChunkMetadata,
  ContentFormat,
  ContentItem,
  ContentPlanItem,
  ContentPlatform,
  ContentSlot,
  ContentStatus,
  ConversationChannel,
  ConversationStatus,
  CustomerConversation,
  CustomerIntent,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentSource,
  KnowledgeDocumentType,
  KnowledgeGapRecord,
  KnowledgeGapStatus,
  KnowledgeSource,
  LiveComment,
  LivePriority,
  LiveRecommendedAction,
  LiveRehearsalReport,
  LiveResponseMode,
  LiveSession,
  LiveSessionStatus,
  LiveStats,
  LiveSuggestion,
  LiveIntent,
  OverviewMetric,
  OwnerTwin,
  Product,
  ProductAnalysisStatus,
  ProductCategory,
  ProductDNA,
  NewSaleRecord,
  SaleRecord,
  WorkflowStatus,
} from "@/types";

/**
 * 逐步报告与摘要原本定义在本文件，S4-2 起归位到 `@/types/workflow`
 * （理由见那里的文件头：驾驶舱的展示映射要读它们，而客户端不能 import 数据层）。
 * 这里转出，是为了让 `@/repositories` 的既有调用方（编排层、服务层、测试）
 * 继续按原路径取用，不必一次性改一堆 import。
 */
export type {
  AgentWorkflowSummary,
  WorkflowStepReport,
  WorkflowTaskOutcome,
} from "@/types";

/** 商品列表筛选条件 */
export interface ProductFilter {
  analysisStatus?: ProductAnalysisStatus;
  category?: ProductCategory;
  /** 名称 / 描述 / 标签的模糊匹配 */
  keyword?: string;
  /** 返回条数上限（不传表示不限制）；与 offset 配合实现分页 */
  limit?: number;
  /** 跳过条数，默认 0 */
  offset?: number;
}

/** 分页信封。total 为「筛选后的总条数」，与 items.length 不同 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * 列表页查询条件（页码语义）。
 * 由 URL searchParams 解析而来，因此所有字段都可缺省。
 */
export interface ProductListQuery {
  keyword?: string;
  category?: ProductCategory;
  analysisStatus?: ProductAnalysisStatus;
  /** 从 1 开始 */
  page: number;
  pageSize: number;
}

/** 默认分页大小：3 列网格下正好 3 行 */
export const DEFAULT_PRODUCT_PAGE_SIZE = 9;
/** 分页大小上限，防止 URL 传入超大值把数据库拖垮 */
export const MAX_PRODUCT_PAGE_SIZE = 60;

/* ------------------------------------------------------------------ */
/* 写入入参（业务语义，不含数据库列名）                                */
/* ------------------------------------------------------------------ */

/** 新建商品。id / 时间戳由存储层生成，不需要调用方提供 */
export interface NewProductInput {
  /** 不传时使用当前商家的 id（单商家 Demo 场景） */
  businessId?: string;
  name: string;
  description?: string;
  category: ProductCategory;
  subCategory?: string;
  price: number;
  unit?: string;
  stock?: number;
  origin?: string;
  specification?: string;
  storageMethod?: string;
  shelfLife?: string;
  imageUrl?: string | null;
  tags?: string[];
  analysisStatus?: ProductAnalysisStatus;
}

/** 更新商品：只传需要改的字段 */
export type UpdateProductInput = Partial<NewProductInput>;

/** 新建 Product DNA（字段与 src/types 的 ProductDNA 对齐，不含 id / 时间戳） */
export interface NewProductDnaInput {
  productId: string;
  category: string;
  subCategory: string;
  visualFeatures: string[];
  coreFeatures: string[];
  sellingPoints: string[];
  targetUsers: string[];
  /** 领域字段名；数据库列为 scenarios */
  consumptionScenarios: string[];
  userPainPoints: string[];
  marketingAngles: string[];
  riskNotes: string[];
  aiVersion: string;
  confidence: number;
  approved: boolean;
}

/** 更新 Product DNA：不允许改归属商品 */
export type UpdateProductDnaInput = Partial<Omit<NewProductDnaInput, "productId">>;

/** 新建商家品牌档案（字段与 src/types 的 BrandProfile 对齐，不含 id / 时间戳 / completeness） */
export interface NewBrandProfileInput {
  /** 归属商家；不传时由实现层解析当前商家（单商家 Demo 场景） */
  businessId?: string;
  positioning: string;
  brandStory: string;
  slogan: string;
  ipConcept: string;
  brandValues: string[];
  targetAudience: string[];
  /** 领域字段名；AI 契约里叫 brandKeywords */
  brandPersonality: string[];
  /** 领域字段名；AI 契约里叫 tone */
  toneOfVoice: string[];
  /** 领域字段名；AI 契约里叫 visualDirection */
  visualKeywords: string[];
  /** 合规与事实风险提示（含 Mock 占位标记） */
  riskNotes: string[];
  /** 本次生成的主依据商品，可为空 */
  sourceProductId?: string | null;
  aiVersion: string;
  confidence: number;
  approved: boolean;
}

/** 更新品牌档案：不允许改归属商家 */
export type UpdateBrandProfileInput = Partial<Omit<NewBrandProfileInput, "businessId">>;

/** 新建内容（字段与 src/types 的 ContentItem 对齐，不含 id / 时间戳 / metrics） */
export interface NewContentInput {
  /** 归属商家；不传时由实现层解析当前商家（单商家 Demo 场景） */
  businessId?: string;
  productId: string;
  /**
   * 商品名快照。
   * 存快照而不是每次 join 商品表，是因为内容正文里本来就会提到当时的商品名，
   * 商品后来改名不应改写历史内容上的署名；同时列表查询也省掉一次 join。
   */
  productName: string;
  platform: ContentPlatform;
  /** 领域字段名；AI 契约里叫 type */
  format: ContentFormat;
  title: string;
  hook: string;
  body: string;
  /** 领域字段名；AI 契约里叫 callToAction */
  cta: string;
  /** 领域字段名；AI 契约里叫 tags */
  hashtags: string[];
  visualSuggestions: string[];
  /** 领域字段名；AI 契约里叫 scenes */
  shotList: string[];
  voiceover: string;
  status: ContentStatus;
  /** 合规与事实风险提示（含 Mock 占位标记） */
  riskNotes: string[];
  aiVersion: string;
  confidence: number;
}

/**
 * 更新内容：不允许改**槽位**（productId / platform / format）与归属商家。
 * 槽位三列是唯一索引的组成部分，允许修改等于允许「把内容搬到另一个位置」，
 * 那是另一种业务动作（复制 / 迁移），不该藏在「重新生成」这条路径里。
 */
export type UpdateContentInput = Partial<
  Omit<NewContentInput, "businessId" | "productId" | "platform" | "format">
>;

/** 更新商家资料 */
export interface UpdateBusinessInput {
  name?: string;
  shortName?: string;
  description?: string;
  logoUrl?: string | null;
  owner?: string;
  location?: string;
  mainCategory?: string;
  storeCount?: number;
  channels?: string[];
}

/** 更新老板数字分身 */
export interface UpdateOwnerTwinInput {
  displayName?: string;
  avatarLabel?: string;
  businessPhilosophy?: string[];
  tone?: string[];
  salesStyle?: string;
  targetCustomers?: string[];
  forbiddenExpressions?: string[];
}

/* ------------------------------------------------------------------ */
/* 仓储接口                                                            */
/* ------------------------------------------------------------------ */

export interface ProductRepository {
  list(filter?: ProductFilter): Promise<Product[]>;
  /** 筛选后的总条数，供分页计算总页数 */
  count(filter?: ProductFilter): Promise<number>;
  /** 列表页专用：一次拿到「当前页 + 总数」 */
  listPage(query?: Partial<ProductListQuery>): Promise<Paginated<Product>>;
  /** 供 generateStaticParams 使用 */
  listIds(): Promise<string[]>;
  getById(id: string): Promise<Product | null>;
  /**
   * 指定商家名下的商品数。
   *
   * 供注册流程判断「这个商家是不是一件商品都没有，需不需要灌起步数据」。
   * 为什么不复用 `count(filter)`：`ProductFilter` 目前**没有**商家维度
   * （单商家时期不需要），而注册发生在会话建立之前，「当前商家」无从解析 ——
   * 所以这里要的是一个显式商家入参的计数。
   */
  countForBusiness(businessId: string): Promise<number>;
  /**
   * 指定商品是否属于指定商家。
   *
   * 为什么需要一个看起来「多余」的方法：领域类型 `Product` **不带商家字段**
   * （界面永远只看当前商家的商品，带上它只会让每一处展示都要多写一个判断），
   * 因此 `getById` 拿到的东西无法回答「它是不是这家的」。
   *
   * 而知识库写入必须回答这个问题：知识可以挂商品，挂错商品的知识
   * 会被另一个商家的消费者检索到 —— 这类泄漏不会报错，只会安静地发生。
   * 与其让每个调用方各自 `getById` 后猜，不如把判断下推到唯一知道答案的地方。
   */
  belongsToBusiness(businessId: string, productId: string): Promise<boolean>;
  /**
   * 读取商品 DNA。
   * 保留在商品仓储上是为了让页面只依赖一个仓储；实际实现委托给 ProductDnaRepository。
   */
  getDna(productId: string): Promise<ProductDNA | null>;
  create(input: NewProductInput): Promise<Product>;
  /** 目标商品不存在时抛 NOT_FOUND */
  update(id: string, patch: UpdateProductInput): Promise<Product>;
  /** 目标商品不存在时抛 NOT_FOUND */
  delete(id: string): Promise<void>;
}

/** Product DNA 独立仓储：S2 的 Product Agent 写入结果主要走这里 */
export interface ProductDnaRepository {
  getByProductId(productId: string): Promise<ProductDNA | null>;
  /** 同一商品已存在 DNA 时抛 DB_ERROR（唯一索引冲突），重新分析请用 update */
  create(input: NewProductDnaInput): Promise<ProductDNA>;
  /** 目标 DNA 不存在时抛 NOT_FOUND */
  update(productId: string, patch: UpdateProductDnaInput): Promise<ProductDNA>;
}

/* ------------------------------------------------------------------ */
/* Agent 任务记录（agent_tasks）                                       */
/* ------------------------------------------------------------------ */

/** 终态集合：进入这些状态时仓储会自动写入 completedAt */
export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = [
  "completed",
  "failed",
];

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return TERMINAL_AGENT_STATUSES.includes(status);
}

/**
 * 新建 Agent 任务的入参。
 *
 * `input` 只放**可公开**的调用参数（如商品 id、是否使用图片）。
 * 不要把提示词全文或任何凭证放进去 —— 它会被序列化进数据库，也会出现在界面上。
 */
export interface NewAgentTaskInput {
  agentType: AgentId;
  /** 任务标题，直接展示给商家，例如「分析商品：连江鲜活鲍鱼」 */
  title: string;
  /** 归属商品；商品类任务应当填 */
  productId?: string | null;
  /** 所属工作流；由用户单点触发的任务留空 */
  workflowId?: string | null;
  status?: AgentStatus;
  progress?: number;
  input?: Record<string, unknown> | null;
}

/** 更新 Agent 任务。终态由 `status` 驱动，completedAt 由仓储自动维护 */
export interface UpdateAgentTaskInput {
  status?: AgentStatus;
  progress?: number;
  output?: Record<string, unknown> | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}

/** Agent 任务记录（领域视图，时间已转成展示字符串） */
export interface AgentTaskRecord {
  id: string;
  agentType: AgentId;
  title: string;
  status: AgentStatus;
  progress: number;
  productId: string | null;
  workflowId: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * Agent 任务仓储。
 *
 * 分工：这里只管「单个任务的记录与状态流转」（谁跑的、什么时候跑的、成没成）；
 * 「一轮经营整体走到哪一步」归 `AgentWorkflowRepository`（见下）。两者是
 * 「任务」与「工作流」的关系 —— 一个工作流包含若干任务，但复用 / 跳过的步骤
 * 不会产生任务记录（它们没进任何 Agent 服务），因此**不能**用任务表反推工作流状态。
 */
export interface AgentTaskRepository {
  create(input: NewAgentTaskInput): Promise<AgentTaskRecord>;
  /** 目标任务不存在时抛 NOT_FOUND */
  update(id: string, patch: UpdateAgentTaskInput): Promise<AgentTaskRecord>;
  /** 某商品最近一次指定类型的任务；用于详情页展示分析记录与并发保护 */
  findLatestByProduct(
    productId: string,
    agentType: AgentId,
  ): Promise<AgentTaskRecord | null>;
  /** 某商品的历史任务，按时间倒序 */
  listByProduct(
    productId: string,
    agentType: AgentId,
    limit?: number,
  ): Promise<AgentTaskRecord[]>;
  /**
   * 全库最近一次指定类型的任务。
   *
   * 供**不归属于单个商品**的 Agent（如品牌经理，输出是商家级档案）判断
   * 「当前是否正在生成」与「上次生成成功还是失败」。
   * Demo 为单商家，因此这里不做商家过滤；多商家时需补 business_id 维度。
   */
  findLatestByType(agentType: AgentId): Promise<AgentTaskRecord | null>;
  /**
   * 某个工作流下的全部任务，按创建时间倒序。
   *
   * S4-1 编排层用它回答两个问题：「本轮跑了哪些任务」「哪些任务还没到终态」。
   * `limit` 用于兜底 —— 一个计划的任务数受计划校验约束（见 `MAX_PLAN_TASKS`），
   * 正常不会失控，但仓储不应假设上游永远正确。
   */
  listByWorkflow(workflowId: string, limit?: number): Promise<AgentTaskRecord[]>;
  /**
   * 全库最近的任务，按创建时间倒序。
   *
   * S6-B 经营分析用它算「各 AI 员工的失败率与平均耗时」—— 这类统计必须跨
   * Agent 一次取回再聚合，否则就要为每个 Agent 单独查一次，
   * 而两次查询之间插进来的任务会让各 Agent 的分母来自不同时刻。
   * Demo 为单商家，因此不做商家过滤；多商家时需补 business_id 维度。
   */
  listRecent(limit?: number): Promise<AgentTaskRecord[]>;
}

/* ------------------------------------------------------------------ */
/* 工作流记录（agent_workflows）                                       */
/* ------------------------------------------------------------------ */

/**
 * 新建工作流的入参。
 *
 * `plan` 存 Business Brain 产出的原始计划快照。**刻意用 `Record<string, unknown>`
 * 而不是 AI 层的 `BusinessPlan` 类型** —— 仓储层不依赖 AI 层，服务层读出来时
 * 会用 Zod 重新校验一次。这层校验有真实价值：库里可能留着旧版本 schema 的计划。
 */
export interface NewAgentWorkflowInput {
  businessId: string;
  goal: string;
  status?: WorkflowStatus;
  plan?: Record<string, unknown> | null;
  summary?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

/** 工作流记录（领域视图，时间已转成展示字符串） */
export interface AgentWorkflowRecord {
  id: string;
  businessId: string;
  goal: string;
  status: WorkflowStatus;
  plan: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * 工作流仓储。
 *
 * 状态流转方法做成语义化而非通用 `update(id, patch)`，因为工作流的状态
 * 与 `completedAt`/`summary`/`errorMessage` 是**绑定**的，通用 patch 太容易写出
 * 「标了 completed 却没写 summary」这种半成品状态。
 */
export interface AgentWorkflowRepository {
  create(input: NewAgentWorkflowInput): Promise<AgentWorkflowRecord>;
  findById(id: string): Promise<AgentWorkflowRecord | null>;
  /**
   * 最近一条处于 running 的工作流。
   *
   * 用于防重复启动：同一商家已有运行中的工作流时不再开新的。
   * Demo 为单商家，因此不做 business 过滤；多商家时需补 business_id 维度。
   */
  findLatestRunning(): Promise<AgentWorkflowRecord | null>;
  /** 目标工作流不存在时抛 NOT_FOUND */
  markRunning(id: string): Promise<AgentWorkflowRecord>;
  markCompleted(
    id: string,
    summary: AgentWorkflowSummary,
  ): Promise<AgentWorkflowRecord>;
  /** 部分完成：有成功也有失败。summary 必填 —— 正是靠它说明「哪部分成了」 */
  markPartiallyCompleted(
    id: string,
    params: { summary: AgentWorkflowSummary; errorMessage?: string | null },
  ): Promise<AgentWorkflowRecord>;
  markFailed(
    id: string,
    params: { errorMessage: string; summary?: AgentWorkflowSummary | null },
  ): Promise<AgentWorkflowRecord>;
  listRecent(limit?: number): Promise<AgentWorkflowRecord[]>;
}

export interface BusinessRepository {
  getProfile(): Promise<BusinessProfile | null>;
  /**
   * 全库最早创建的商家，**绕过会话作用域**；库为空返回 null。
   *
   * 只给「注册」这样的 bootstrap 流程用。理由：注册发生在会话建立**之前**，
   * 此刻 `getProfile()` 会因为「未登录」而返回 null（见 `session-context` 的
   * 安全底线），于是「库里是否已有演示商家可以认领」这个问题就答不出来了 ——
   * 否则已有的未认领演示商家无法与首个账号关联。
   *
   * 它是一个**故意的越权读**，所以只返回展示所需的商家档案、不返回任何
   * 该商家的业务数据，并且调用方只有注册服务一处。
   */
  findEarliestProfile(): Promise<BusinessProfile | null>;
  /**
   * 新建商家档案（S7 注册流程用）。
   *
   * 与 `updateProfile` 分开而不是做成 upsert：一次「以为在改名字、实际新建了
   * 第二个商家」的事故，比多写一个方法贵得多。名字重复也**不**报错 ——
   * 「连江海产」这样的店名在现实里本来就会重名。
   */
  create(input: NewBusinessInput): Promise<BusinessProfile>;
  updateProfile(patch: UpdateBusinessInput): Promise<BusinessProfile>;
  getOwnerTwin(): Promise<OwnerTwin | null>;
  /**
   * 写入老板数字分身；尚无档案时直接创建。
   *
   * `options.businessId` 用于**指定目标商家**，注册流程必须传 ——
   * 那时会话还没建立，默认的「当前商家」解析不到刚建出来的那一个。
   */
  updateOwnerTwin(
    patch: UpdateOwnerTwinInput,
    options?: { businessId?: string },
  ): Promise<OwnerTwin>;
  listNotifications(): Promise<AgentNotification[]>;
}

/** 新建商家档案的输入 */
export interface NewBusinessInput {
  name: string;
  shortName: string;
  description?: string;
  owner?: string;
  location?: string;
  mainCategory?: string;
  storeCount?: number;
  channels?: string[];
}

export interface BrandRepository {
  /** 当前商家的品牌档案；未生成时返回 null（界面据此进入 empty 态） */
  getProfile(): Promise<BrandProfile | null>;
  /** 同一商家已存在品牌档案时抛 DB_ERROR（唯一索引冲突），重新生成请用 update */
  create(input: NewBrandProfileInput): Promise<BrandProfile>;
  /** 目标档案不存在时抛 NOT_FOUND */
  update(patch: UpdateBrandProfileInput): Promise<BrandProfile>;
}

export interface ContentRepository {
  list(): Promise<ContentItem[]>;
  getPlan(): Promise<ContentPlanItem[]>;
  /** 按槽位读取内容；不存在返回 null（界面据此进入「尚未生成」态） */
  findBySlot(slot: ContentSlot): Promise<ContentItem | null>;
  /** 该槽位已存在内容时抛 DB_ERROR（唯一索引冲突），重新生成请用 updateBySlot */
  create(input: NewContentInput): Promise<ContentItem>;
  /** 目标槽位不存在时抛 NOT_FOUND */
  updateBySlot(slot: ContentSlot, patch: UpdateContentInput): Promise<ContentItem>;
}

/* ------------------------------------------------------------------ */
/* AI 直播间（live_sessions / live_comments）（S6）                    */
/* ------------------------------------------------------------------ */

/**
 * 新建直播场次。
 *
 * `businessId` 必填 —— 直播是商家级活动，跨商家隔离必须由存储层最清楚的那一处兜住。
 */
export interface NewLiveSessionInput {
  businessId: string;
  title: string;
  productId: string;
  productName: string;
  status?: LiveSessionStatus;
  startedAt?: Date;
}

export interface UpdateLiveSessionInput {
  status?: LiveSessionStatus;
  endedAt?: Date | null;
  /** 评论数 / AI 处理数由追加动作自动维护，这里仅供测试或校正 |
   */
  commentsCount?: number;
  aiHandledCount?: number;
  hostTranscript?: string;
  rehearsalReport?: LiveRehearsalReport | null;
}

/** 新建评论 */
export interface NewLiveCommentInput {
  sessionId: string;
  authorName: string;
  content: string;
}

/** 更新评论的 AI 分类结果 / 处理状态 */
export interface UpdateLiveCommentInput {
  intent?: LiveIntent | null;
  priority?: LivePriority | null;
  handled?: boolean;
}

/** 新建 AI 直播导演建议 */
export interface NewLiveSuggestionInput {
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
  /** AI 处理失败时的说明；成功为 null */
  failureMessage?: string | null;
}

/**
 * 直播仓储（S6 扩展为可写）。
 *
 * `getStats()` 返回的是**模拟指标**（在线 / 点赞 / 涨粉没有真实来源），
 * 与真实可计算的指标（评论数 / AI 处理数）刻意分开：前者是演示数据，
 * 后者由当前场次的评论实时算出（见 `live.service`）。
 */
export interface LiveRepository {
  /** 当前（最近一场）直播场次；从未开播返回 null */
  getSession(): Promise<LiveSession | null>;
  /**
   * 历史直播场次，按开始时间倒序（最近在前）。
   *
   * S6-B 经营分析需要「开过几场直播」这个事实；只拿 `getSession()` 的最近一场，
   * 场次数永远只会是 0 或 1，是一个看起来有值、实则恒定的假指标。
   */
  listSessions(limit?: number): Promise<LiveSession[]>;
  /** 模拟指标（演示数据）；无场次时返回 null */
  getStats(): Promise<LiveStats | null>;
  /** 某场次的评论，按时间**正序**（与聊天流一致）；不传 sessionId 取最近一场 */
  listComments(sessionId?: string): Promise<LiveComment[]>;
  /** 某场次的 AI 建议，按时间**倒序**（最新在前）；不传 sessionId 取最近一场 */
  listSuggestions(sessionId?: string): Promise<LiveSuggestion[]>;

  /* ---------------- S6：写操作 ---------------- */

  createSession(input: NewLiveSessionInput): Promise<LiveSession>;
  /** 目标场次不存在时抛 NOT_FOUND */
  updateSession(id: string, patch: UpdateLiveSessionInput): Promise<LiveSession>;
  /** 追加一条评论（评论数 +1），返回落库后的评论 */
  appendComment(input: NewLiveCommentInput): Promise<LiveComment>;
  /** 目标评论不存在时抛 NOT_FOUND */
  updateComment(id: string, patch: UpdateLiveCommentInput): Promise<LiveComment>;
  /** 保存 AI 建议；同一评论重试时更新原记录，首次成功才增加 AI 处理数 */
  appendSuggestion(input: NewLiveSuggestionInput): Promise<LiveSuggestion>;
  /** 某条评论是否已有建议（避免同一条评论被重复处理而堆叠卡片） */
  findSuggestionByComment(commentId: string): Promise<LiveSuggestion | null>;
}

/* ------------------------------------------------------------------ */
/* 知识库（knowledge_documents / knowledge_chunks）（S5）              */
/* ------------------------------------------------------------------ */

/** 新建知识文档 */
export interface NewKnowledgeDocumentInput {
  /** 不传时由实现层解析当前商家（单商家 Demo 场景） */
  businessId?: string;
  name: string;
  type: KnowledgeDocumentType;
  source: KnowledgeDocumentSource;
  summary?: string;
  /** 正文；系统同步文档也必须有正文，否则没有可检索的内容 */
  content?: string;
  productId?: string | null;
}

/** 更新知识文档。`source` 不允许改 —— 人工文档不该被同步流程接管 */
export type UpdateKnowledgeDocumentInput = Partial<
  Omit<NewKnowledgeDocumentInput, "businessId" | "source">
> & {
  /** 索引状态由索引服务写入 */
  indexStatus?: KnowledgeDocument["indexStatus"];
  indexError?: string | null;
};

export interface KnowledgeDocumentFilter {
  type?: KnowledgeDocumentType;
  source?: KnowledgeDocumentSource;
  productId?: string | null;
  /** 名称 / 正文的模糊匹配 */
  keyword?: string;
}

/**
 * 按名取文档（系统同步的幂等键）。
 *
 * 系统同步每次都 upsert 同一份《XX · 商品资料》，而不是每次都插一条新的 ——
 * 否则跑两次同步，知识库里就有两份几乎一样的产品文档，
 * 检索时它们会互相挤占 TopK。
 */
export interface KnowledgeDocumentKey {
  businessId: string;
  type: KnowledgeDocumentType;
  name: string;
}

/** 新建切片（向量已由调用方生成 —— 仓储不认识 Provider） */
export interface NewKnowledgeChunkInput {
  documentId: string;
  businessId: string;
  productId: string | null;
  sourceType: KnowledgeDocumentType;
  title: string;
  chunkIndex: number;
  content: string;
  /** 允许为空：索引失败时先落内容，向量留给重试补 */
  embedding: number[] | null;
  metadata?: ChunkMetadata | null;
}

/**
 * 一条**已经算好向量**的待索引切片。
 *
 * 它是「索引候选」的持久化形态：正文切分、向量化都发生在服务层，
 * 仓储只负责把它一次性写进去。之所以不复用 `NewKnowledgeChunkInput`：
 * 那个类型要求调用方填 `documentId` / `businessId` / `productId` / `title` /
 * `metadata` —— 而这些字段**全部可以从文档推出来**。
 * 让服务层手抄一遍，就等于把「切片的归属字段与文档一致」交给调用方自觉维护，
 * 而一旦不一致，检索会跨商家或跨商品命中（这类错误没有任何报错）。
 */
export interface IndexedKnowledgeChunkInput {
  chunkIndex: number;
  content: string;
  /** 章节标题；识别不到为空串 */
  section: string;
  start: number;
  end: number;
  /** 已通过维度与有限性校验的向量。仓储会再校验一次，但**不做修补** */
  embedding: number[];
}

/** 建一份「正文 + 全部切片」已经就绪的知识文档 */
export interface NewIndexedKnowledgeDocumentInput extends NewKnowledgeDocumentInput {
  chunks: readonly IndexedKnowledgeChunkInput[];
}

/**
 * 向量检索入参。
 *
 * `businessId` **必填**（不是可选）—— 跨商家检索是这个项目里最不可接受的错误，
 * 把它做成必填参数，任何一次「忘了传」都会在编译期被拦下，
 * 而不是在运行时静默返回别家的知识。
 */
export interface KnowledgeSearchParams {
  businessId: string;
  queryEmbedding: number[];
  /**
   * 限定商品；不传表示**不按商品过滤**（检索该商家全部知识）。
   * 传具体商品 id 时命中「该商品的知识 + 全店知识」（`product_id = $x OR product_id IS NULL`）。
   *
   * 为什么不把「不传」解释成「只要全店知识」：绝大多数提问不带商品，
   * 那样解释会让商品级文档被整体排除，而界面上看不出任何原因。跨商家泄漏由
   * `businessId` 单独兜住，不靠这个字段。
   */
  productId?: string | null;
  sourceTypes?: readonly KnowledgeDocumentType[];
  limit?: number;
  /** 相似度下限；低于它的命中在仓储层就被丢掉，不占用 TopK */
  minSimilarity?: number;
}

/** 一条检索命中：切片本体 + 相似度 */
export interface KnowledgeChunkSearchHit {
  chunk: KnowledgeChunk;
  /** 余弦相似度，越大越相关 */
  similarity: number;
}

export interface KnowledgeDocumentRepository {
  findDocuments(filter?: KnowledgeDocumentFilter): Promise<KnowledgeDocument[]>;
  getDocumentById(id: string): Promise<KnowledgeDocument | null>;
  findDocumentByKey(key: KnowledgeDocumentKey): Promise<KnowledgeDocument | null>;
  /** 同一 (businessId, type, name) 已存在时抛 DB_ERROR，请改用 upsertDocument */
  createDocument(input: NewKnowledgeDocumentInput): Promise<KnowledgeDocument>;
  updateDocument(
    id: string,
    patch: UpdateKnowledgeDocumentInput,
  ): Promise<KnowledgeDocument>;
  deleteDocument(id: string): Promise<void>;
  /**
   * **原子**建立「文档 + 它的全部切片」。
   *
   * 为什么必须是一个方法而不是「先 createDocument 再 createChunks」：
   * 两步之间任何失败都会留下**半套状态** —— 文档在、切片不在（检索永远命中不到，
   * 界面却显示文档已存在），或者切片在、文档不在（悬空切片）。
   * 这两种状态都没有任何报错，只能靠人事后发现。
   *
   * 调用前必须已经把向量全部算好：本方法**不在内部调用模型**，
   * 因此事务的持有时间只有「两次 INSERT」，不会把几秒的网络等待包进事务里。
   * 成功返回的文档 `indexStatus` 为 `indexed` —— 能写进来的切片必然是建好了索引的。
   */
  createIndexedDocument(
    input: NewIndexedKnowledgeDocumentInput,
  ): Promise<KnowledgeDocument>;
  /**
   * **原子**替换某文档的索引：更新文档字段 + 删除旧切片 + 写入新切片。
   *
   * 与 `createIndexedDocument` 同理，三步必须在同一事务里 ——
   * 若先删旧切片再写入新切片，中间失败会让文档**从「检索得到」变成「检索不到」**，
   * 而商家只看到一次「更新失败」。正确顺序是：新向量全部算好之后才进事务，
   * 进来就一定能全部写成功。
   *
   * 索引状态由本方法统一置为 `indexed`、清空 `indexError`：
   * 唯一的调用场景就是「新索引已经构建成功」，留一个参数让调用方自己记得翻状态，
   * 早晚会有一个调用点忘掉，然后界面上就出现「分块 8 个，状态：待索引」。
   */
  replaceDocumentIndex(
    id: string,
    patch: UpdateKnowledgeDocumentInput,
    chunks: readonly IndexedKnowledgeChunkInput[],
  ): Promise<KnowledgeDocument>;
  /** 系统同步专用：按 (商家, 类型, 名称) 存在则更新、不存在则新建 */
  upsertDocument(input: NewKnowledgeDocumentInput): Promise<KnowledgeDocument>;
  /** 删除某商品的全部**系统同步**文档（商品删除 / 重新同步时用） */
  deleteSystemDocumentsByProduct(productId: string): Promise<number>;
  /** 各文档的切片数（一次分组统计，避免 N 次单查） */
  countChunksByDocuments(): Promise<Record<string, number>>;
}

export interface KnowledgeChunkRepository {
  /** 批量写入切片（一次事务，见实现层的「不留半套向量」说明） */
  createChunks(inputs: readonly NewKnowledgeChunkInput[]): Promise<KnowledgeChunk[]>;
  deleteChunksByDocument(documentId: string): Promise<number>;
  /** 列出某文档的切片，按序号升序 */
  listByDocument(documentId: string): Promise<KnowledgeChunk[]>;
  searchSimilar(params: KnowledgeSearchParams): Promise<KnowledgeChunkSearchHit[]>;
  countByDocument(documentId: string): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* 知识缺口（knowledge_gaps）（S5）                                    */
/* ------------------------------------------------------------------ */

/**
 * 记录一次「没答上来」。
 *
 * 仓储负责**去重聚合**（同商家 + 同聚合键 → 计数 +1），
 * 而不是让服务层先查后写：那是典型的竞态（两个提问并发时各查一次都发现
 * 「不存在」，于是各插一行）。唯一索引 + upsert 才是正确做法。
 *
 * 聚合身份由 `gapKey` 承载，它的定义在 `src/rag/knowledge-gap.ts`
 * （商家 + 商品 + 规范化问题）。`normalizedQuestion` 与 `gapKey` 都由服务层算好传入，
 * 但**仓储会重新推导一遍并比对**：两者不一致说明有一处的规则变了或被绕过，
 * 此时静默接受会插出重复行（且不会有任何报错），因此直接拒绝。
 */
export interface KnowledgeGapOccurrenceInput {
  businessId?: string;
  productId?: string | null;
  /** 最近一次提问时的原话（面板展示用） */
  question: string;
  /** 规范化文本；传空串时仓储会退回用 `question` 现算 */
  normalizedQuestion: string;
  /** 服务层算好的聚合键；不传则由仓储自行推导 */
  gapKey?: string;
  intent: string;
  reason: string;
}

export interface KnowledgeGapRepository {
  /**
   * 列出缺口。
   *
   * 排序固定为「未解决优先 → 出现次数多优先 → 最近出现优先」：
   * 面板要回答的是「我现在最该补哪块知识」，而次数是唯一能自己排序的证据。
   * 按创建时间排会让一个陈年、只出现过两次的问题压住今天被问 20 次的那个。
   */
  list(params?: {
    status?: KnowledgeGapStatus;
    limit?: number;
  }): Promise<KnowledgeGapRecord[]>;
  getById(id: string): Promise<KnowledgeGapRecord | null>;
  /**
   * 记录一次提问：命中同一聚合键则计数 +1、刷新 lastSeenAt；
   * 未命中则新建。状态流转见实现层注释（resolved 会重开，ignored 不会）。
   */
  recordOccurrence(input: KnowledgeGapOccurrenceInput): Promise<KnowledgeGapRecord>;
  /** 状态流转；`resolved` 时通常带上补齐它的文档 id */
  updateStatus(
    id: string,
    status: KnowledgeGapStatus,
    resolvedDocumentId?: string | null,
  ): Promise<KnowledgeGapRecord>;
  countOpen(): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* 客服会话（customer_conversations / customer_messages）（S5）        */
/* ------------------------------------------------------------------ */

export interface NewConversationInput {
  businessId?: string;
  customerName: string;
  customerLabel?: string;
  channel?: ConversationChannel;
  productId?: string | null;
  tags?: string[];
}

export interface UpdateConversationInput {
  status?: ConversationStatus;
  unreadCount?: number;
  tags?: string[];
}

/** 追加一条消息 */
export interface NewCustomerMessageInput {
  conversationId: string;
  role: ChatRole;
  content: string;
  /** 人工消息为 null（没有「是否有依据」这回事） */
  grounded?: boolean | null;
  intent?: CustomerIntent | null;
  confidence?: number | null;
  citations?: KnowledgeSource[];
  needsHuman?: boolean;
  knowledgeGapId?: string | null;
  retrievedCount?: number;
}

/**
 * 客服会话仓储。
 *
 * `CustomerConversation` 上的 `lastMessage` / `updatedAtText` / `messageCount`
 * 是**派生字段**，由实现层在读取时补全（Mock 从内存算、DB 用一次聚合查询）——
 * 它们不落库：落库就要在每次追加消息后手动维护，漏一次列表就显示错。
 */
export interface ConversationRepository {
  listConversations(limit?: number): Promise<CustomerConversation[]>;
  getConversation(id: string): Promise<CustomerConversation | null>;
  createConversation(input: NewConversationInput): Promise<CustomerConversation>;
  updateConversation(
    id: string,
    patch: UpdateConversationInput,
  ): Promise<CustomerConversation>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;
  appendMessage(input: NewCustomerMessageInput): Promise<ChatMessage>;

  /* ---------------- S5 Task80：按商家隔离的读取 ---------------- */

  /**
   * 按商家列出会话。
   *
   * 与 `listConversations()` 的差别只有一处：商家是**入参**而不是由实现层
   * 自己猜「当前商家」。上层（客服 Service）已经在业务语义上确定了商家，
   * 让存储层再猜一次，等于给「上层以为是 A 家、存储层按 B 家查」留了一个
   * 不报错的分叉点。
   */
  listConversationsForBusiness(
    businessId: string,
    limit?: number,
  ): Promise<CustomerConversation[]>;

  /**
   * 按商家读取单个会话。
   *
   * **不属于该商家时返回 `null`，而不是抛 `UNAUTHORIZED` 或「存在但无权访问」**：
   * 后两者本身就是一次信息泄漏 —— 攻击者可以靠错误码的差别探测出
   * 「这个 conversationId 在系统里存在，只是不属于我」。
   * 「不存在」与「不是你的」必须无法区分，这是任务书第四十二节 Case 8 的硬要求。
   */
  findConversationForBusiness(
    businessId: string,
    conversationId: string,
  ): Promise<CustomerConversation | null>;

  /* ---------------- S5 Task81：客服经营指标 ---------------- */

  /**
   * 统计某商家自 `since` 起写入的 **AI 回答消息**。
   *
   * 返回两个数而不是一个，是为了让「分子 / 分母」来自**同一次查询**：
   * 分两次查的话，两次之间刚好插进来一条消息，就会出现「依据充分 3 条 /
   * 回答 2 条」这种在界面上无法解释的比值。
   *
   * 分母的口径是「AI 真正给出了回答的消息数」——
   * 模型超时 / 检索报错时**不会写入 assistant 消息**（见
   * `services/customer-service.ts` 的失败语义表），因此系统故障天然不在分母里，
   * 不需要靠 `grounded IS NOT NULL` 之类的条件去排除它。
   *
   * `role` 固定为 `agent`（不开放成参数）：这个统计只有一个业务含义，
   * 开放成参数只会让「客户消息也算进回答率」这种错误变得可写。
   */
  countAssistantMessagesSince(
    businessId: string,
    since: Date,
  ): Promise<{ answered: number; grounded: number }>;
}

export interface AnalyticsRepository {
  getOverview(): Promise<AnalyticsOverview>;
  /** 驾驶舱顶部的四项核心状态 */
  getDashboardMetrics(): Promise<OverviewMetric[]>;
  getBusinessGoal(): Promise<BusinessGoal | null>;
}

export interface SalesRepository {
  list(businessId: string): Promise<SaleRecord[]>;
  /** 已存在的记录编号跳过，返回实际新写入条数。 */
  import(rows: NewSaleRecord[]): Promise<number>;
  update(businessId: string, id: string, changes: Omit<NewSaleRecord, "businessId" | "isDemo" | "recordNo">): Promise<SaleRecord | null>;
  deleteOne(businessId: string, id: string): Promise<boolean>;
  deleteDemo(businessId: string): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* 经营日报（business_reports）（S6-B）                                */
/* ------------------------------------------------------------------ */

/**
 * 新建一份经营日报。
 *
 * `snapshot` 与 `report` 一起存（都是领域类型，不是 `Record<string, unknown>`）：
 * 与工作流的 `plan` 不同，这里的两份数据**都是本项目自己产出的**，
 * 不存在「库里留着别家 schema」的兼容问题，因此直接用类型约束，
 * 免掉读出时再解析一遍的成本。
 *
 * 快照必须一起存 —— 日报的意义是「当时看到的数据 + 基于它的判断」。
 */
export interface NewBusinessReportInput {
  businessId: string;
  snapshot: AnalyticsSnapshot;
  report: AnalyticsReport;
}

/**
 * 经营日报仓储。
 *
 * 与其它仓储同一约定：**只读实现按「最新在前」排序**，
 * 排序规则属于业务语义（复盘永远先看最近一次），不该让每个调用方各写一遍。
 */
export interface AnalyticsReportRepository {
  create(input: NewBusinessReportInput): Promise<BusinessReport>;
  /** 最新一份日报；从未生成过返回 null（界面据此进入 empty 态） */
  findLatest(): Promise<BusinessReport | null>;
  /** 历史日报，按创建时间倒序 */
  listRecent(limit?: number): Promise<BusinessReport[]>;
  /** 目标日报不存在时返回 null */
  findById(id: string): Promise<BusinessReport | null>;
}

/**
 * 仓储集合，服务层通过它访问数据。
 *
 * S4-2 移除了两个「演示态」仓储：
 * - `agents`（AI 员工列表）—— 员工的名称 / 职责 / 图标 / 能力标签是**常量目录**
 *   （见 `@/lib/agents`），不是数据；运行时状态一律由 `agentTasks` +
 *   `agentWorkflows` 推出。原先它在 `DATA_SOURCE=db` 下会抛 NOT_IMPLEMENTED，
 *   把「静态目录」和「业务数据」混在一个仓储里是根因。
 * - `workflow`（Phase 0 的只读工作流视图）—— 它返回的是预置的演示工作流。
 *   驾驶舱改读真实数据后，这份 Mock 一旦被重新接上就会让商家看到假进度，
 *   因此**删除而不是保留**。
 */
export interface Repositories {
  products: ProductRepository;
  productDna: ProductDnaRepository;
  business: BusinessRepository;
  brand: BrandRepository;
  content: ContentRepository;
  live: LiveRepository;
  conversations: ConversationRepository;
  /** Agent 任务记录（S2-2 起由 Product Agent 使用） */
  agentTasks: AgentTaskRepository;
  /** 工作流持久化与状态机（S4-1 编排层） */
  agentWorkflows: AgentWorkflowRepository;
  /** 知识文档（S5） */
  knowledgeDocuments: KnowledgeDocumentRepository;
  /** 知识切片与向量检索（S5） */
  knowledgeChunks: KnowledgeChunkRepository;
  /** 知识缺口聚合（S5） */
  knowledgeGaps: KnowledgeGapRepository;
  analytics: AnalyticsRepository;
  sales: SalesRepository;
  /** 经营日报（S6-B：Analytics Agent 的产出与历史） */
  reports: AnalyticsReportRepository;
  /** 账号（S7） */
  users: UserRepository;
  /** 登录会话（S7） */
  sessions: SessionRepository;
}

/* ------------------------------------------------------------------ */
/* 账号与会话（S7）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 账号记录 —— **不含密码哈希**。
 *
 * 密码哈希单独用 `UserCredentialRecord` 承载，因为「读一个用户」与
 * 「校验密码」是两件事：把哈希放在通用记录里，它会跟着
 * 序列化、日志、调试输出到处跑，而它一次都不需要在那些地方出现。
 */
export interface UserRecord {
  id: string;
  businessId: string;
  email: string;
  name: string;
  createdAt: string;
}

/** 仅用于登录校验：唯一一处会读到密码哈希的地方 */
export interface UserCredentialRecord {
  id: string;
  businessId: string;
  email: string;
  name: string;
  passwordHash: string;
}

export interface NewUserInput {
  email: string;
  name: string;
  /** 已经过 `hashPassword()` 的哈希值，**绝不能**是明文 */
  passwordHash: string;
  /** 归属商家；不传时落到当前主商家 */
  businessId?: string;
}

export interface UserRepository {
  /** 按邮箱查找（邮箱由服务层归一为小写后传入）；不存在返回 null */
  findByEmail(email: string): Promise<UserCredentialRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** 邮箱已被占用时抛 DB_ERROR（唯一索引冲突），由服务层翻译成可读文案 */
  create(input: NewUserInput): Promise<UserRecord>;
  /**
   * 当前库里有多少账号。
   *
   * 用途是**判断「这是不是第一个账号」**，从而决定注册时要不要
   * 引导用户「认领」已有演示商家。让用户自己选归属商家是不安全的
   * （那等于允许任何人认领任意商家），所以只能由服务端按这个计数决定。
   */
  count(): Promise<number>;
}

/**
 * 会话记录 —— **不含 token 明文，也不含哈希**。
 *
 * 哈希是查询条件，不是展示内容；读出来只有副作用（一个能拿来查库的凭据
 * 在内存里多飘一会儿），没有任何好处。
 */
export interface SessionRecord {
  id: string;
  userId: string;
  businessId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

export interface SessionRepository {
  /**
   * 按 token 哈希找**仍然有效**的会话（未过期）。
   *
   * 过期判定用**数据库的时间**（`now()`）而不是应用进程的时间：
   * 应用与数据库不在同一台机器时，两者的时钟可能相差几分钟，
   * 用进程时间会出现「本地看着还没过期、实际早该失效」。这也让
   * 「把系统时间调回去」无法延长一个已失效的会话。
   */
  findValidByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<SessionRecord>;
  /** 退出登录：删掉这一条。不存在时静默成功（幂等） */
  deleteByTokenHash(tokenHash: string): Promise<void>;
  /** 改密码 / 主动踢下线：一次性注销该用户的全部会话，返回删除条数 */
  deleteAllForUser(userId: string): Promise<number>;
  /** 清理已过期会话，返回删除条数 */
  deleteExpired(): Promise<number>;
  /** 更新最近使用时间（用于「登录设备」列表与不活跃清理） */
  touch(id: string): Promise<void>;
}
