/**
 * Drizzle 数据库 Schema（Supabase PostgreSQL）
 *
 * 设计原则：
 * - 表名 / 列名统一 snake_case，字段随任务书；为对齐 `src/types` 领域模型补充了少量必要列，
 *   每处补充都在注释里标注「领域字段对应」。
 * - 主键使用 uuid（Supabase 常见做法），领域层仍是 string，映射由仓储实现负责。
 * - 时间统一 timestamptz；金额用 numeric(10,2)，以 number 模式读回，避免浮点误差。
 * - 所有 jsonb 列都带 `$type<T>()`，读取后无需 any 断言。
 *
 * 本阶段（S1-1）只建立基础设施：业务表 → 仓储实现 → 服务层。
 * 不包含向量检索、AI 调用与业务 Agent 逻辑。
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { AnalyticsReport, AnalyticsSnapshot, KnowledgeSource, LiveRehearsalReport } from "@/types";

/* ------------------------------------------------------------------ */
/* 枚举                                                                */
/* ------------------------------------------------------------------ */

/** AI 数字员工类型，与 src/types/agent.ts 的 AgentId 一致 */
export const agentTypeEnum = pgEnum("agent_type", [
  "business_brain",
  "product_agent",
  "brand_agent",
  "content_agent",
  "live_agent",
  "customer_service_agent",
  "analytics_agent",
]);

/** Agent 运行状态机，见技术文档 9.1 */
export const agentStatusEnum = pgEnum("agent_status", [
  "idle",
  "queued",
  "running",
  "completed",
  "failed",
  /**
   * S4-1 新增：任务未被真正执行。成因记在任务 `output` 里：
   * `execution=reused`（已有结果可复用）或 `skipReason=dependency_failed`（上游失败被阻塞）。
   * 刻意不新增 `blocked` 值 —— 两者在状态机上是同一件事，成因交给 output 表达。
   */
  "skipped",
]);

/** Workflow 状态 */
export const workflowStatusEnum = pgEnum("workflow_status", [
  "idle",
  "running",
  "completed",
  "failed",
  /** S4-1 新增：有成功也有失败 —— 编排跑起来后的常态收尾，不该混进 failed */
  "partially_completed",
  /** 预留给人工中止（本轮暂不产生该状态） */
  "cancelled",
]);

/** 商品 AI 分析状态，与 ProductAnalysisStatus 一致 */
export const productAnalysisStatusEnum = pgEnum("product_analysis_status", [
  "pending",
  "analyzing",
  "analyzed",
  "failed",
]);

/** 商品分类，与 ProductCategory 一致 */
export const productCategoryEnum = pgEnum("product_category", [
  "海产品",
  "干货",
  "预制菜",
  "礼盒",
]);

/**
 * 知识库文档类型，与 `KnowledgeDocumentType` 一致。
 *
 * S5 变动：`after_sale` → `after_sales`（与领域类型统一为下划线写法），
 * 并新增 `manual`（商家人工录入的通用资料）。迁移里用
 * `ALTER TYPE … RENAME VALUE` 而不是「加新值、删旧值」——
 * 后者会让已有切片记录的 type 变成非法值。
 */
export const knowledgeTypeEnum = pgEnum("knowledge_type", [
  "product",
  "faq",
  "logistics",
  "after_sales",
  "brand",
  "cooking",
  "storage",
  "manual",
]);

/** 知识文档来源：系统自动同步 / 商家人工录入 */
export const knowledgeSourceEnum = pgEnum("knowledge_source", [
  "system",
  "manual",
]);

/** 索引状态：文档已写库但切片失败时，界面必须能看见 */
export const knowledgeIndexStatusEnum = pgEnum("knowledge_index_status", [
  "pending",
  "indexed",
  "failed",
]);

/** 知识缺口状态 */
export const knowledgeGapStatusEnum = pgEnum("knowledge_gap_status", [
  "open",
  "resolved",
  "ignored",
]);

/** 客服会话渠道（本阶段为内置模拟消费者，不对接真实平台消息） */
export const conversationChannelEnum = pgEnum("conversation_channel", [
  /**
   * 内置消费者模拟器（S5 Task80）。
   *
   * 为什么单列一个值而不是复用 `douyin`：模拟器里创建的会话**不是**来自抖音的真实咨询，
   * 把它记成「抖音小店」会让数据说一句不真的话。界面上暂时不展示渠道，
   * 但库里存的值将来一定要能被信任 —— 那时候再回头区分「哪些是模拟数据」
   * 已经无从判断了。后续接入真实平台时，真实渠道仍用下面四个值。
   */
  "simulator",
  "douyin",
  "wechat",
  "shipinhao",
  "store",
]);

/** 客服会话状态：AI 接待中 / AI 判断需人工 / 已结束 */
export const conversationStatusEnum = pgEnum("conversation_status", [
  "bot",
  "human",
  "closed",
]);

/** 消息角色 */
export const chatRoleEnum = pgEnum("chat_role", [
  "customer",
  "agent",
  "system",
]);

/* ------------------------------------------------------------------ */
/* 1. businesses —— 商家主体                                           */
/* ------------------------------------------------------------------ */

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** 领域字段对应：BusinessProfile.shortName（顶栏品牌切换展示） */
  shortName: text("short_name").notNull(),
  description: text("description").notNull().default(""),
  logoUrl: text("logo_url"),
  /** 领域字段对应：BusinessProfile.owner */
  owner: text("owner").notNull().default(""),
  /** 领域字段对应：BusinessProfile.location */
  location: text("location").notNull().default(""),
  /** 领域字段对应：BusinessProfile.mainCategory */
  mainCategory: text("main_category").notNull().default(""),
  /** 领域字段对应：BusinessProfile.storeCount */
  storeCount: integer("store_count").notNull().default(0),
  /** 领域字段对应：BusinessProfile.channels */
  channels: jsonb("channels").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ */
/* 2. users —— 账号                                                    */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /**
     * 密码哈希（`scrypt`，格式见 `@/lib/password`）。
     *
     * **只存哈希，永远不存明文**；校验走 `timingSafeEqual` 定长比较。
     * 没有默认值是有意的：默认空串会让「忘了写密码」变成「一个空密码账号」，
     * 而空哈希在校验时若被误当成合法值，就是一个无需密码即可登录的后门。
     * 本表在 S7 之前从未写入过任何行，因此加此列不需要回填。
     */
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    index("users_business_id_idx").on(table.businessId),
  ],
);

export const publicKnowledgeDocuments = pgTable("public_knowledge_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  content: text("content").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  sourceName: text("source_name").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  verified: boolean("verified").notNull().default(false),
  status: text("status").notNull().default("draft"),
  updatedBy: text("updated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("public_knowledge_status_idx").on(table.status),
  check("public_knowledge_status_check", sql`${table.status} IN ('draft', 'published', 'archived')`),
  check("public_knowledge_category_check", sql`${table.category} IN ('产地与地标', '品质规范', '冷链与售后', '经营与推广')`),
  check("public_knowledge_publish_check", sql`${table.status} <> 'published' OR (${table.verified} AND length(trim(${table.sourceName})) > 0)`),
]);

/* ------------------------------------------------------------------ */
/* 2b. sessions —— 登录会话（S7）                                      */
/* ------------------------------------------------------------------ */

/**
 * 会话表。
 *
 * 为什么不用无状态 JWT：
 * 「退出登录」必须**立刻**生效。JWT 在过期前一直有效，要让它失效就得再加一张
 * 黑名单表 —— 那不如一开始就存会话。存会话还能实现「查看/踢掉其它设备」，
 * 以及改密码时一次性注销全部会话。
 *
 * 安全性上的两个硬约束：
 * 1. **只存 token 的哈希**（SHA-256）。明文 token 只在响应 cookie 里出现一次，
 *    库被读走也无法直接拿来登录。
 * 2. `expires_at` 是**数据库里**判定的，不依赖客户端 cookie 的 maxAge ——
 *    cookie 是用户可以改的，过期时间不能由它说了算。
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** token 的 SHA-256 十六进制摘要（明文不落库） */
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 到期时间；判定只认这一列 */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** 最近一次使用时间，用于「登录设备」展示与长期不活跃会话清理 */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

/* ------------------------------------------------------------------ */
/* 3. owner_profiles —— 老板数字分身（Owner Twin）                     */
/* ------------------------------------------------------------------ */

export const ownerProfiles = pgTable(
  "owner_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** 领域字段对应：OwnerTwin.displayName */
    displayName: text("display_name").notNull().default(""),
    /** 领域字段对应：OwnerTwin.avatarLabel */
    avatarLabel: text("avatar_label").notNull().default(""),
    /** 经营理念 */
    businessPhilosophy: jsonb("business_philosophy")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 表达语气 */
    tone: jsonb("tone").$type<string[]>().notNull().default([]),
    /** 销售风格 */
    salesStyle: text("sales_style").notNull().default(""),
    /** 目标客户 */
    targetCustomers: jsonb("target_customers")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 禁用表达（合规红线） */
    forbiddenExpressions: jsonb("forbidden_expressions")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("owner_profiles_business_id_idx").on(table.businessId)],
);

/* ------------------------------------------------------------------ */
/* 4. products —— 商品核心表                                           */
/* ------------------------------------------------------------------ */

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: productCategoryEnum("category").notNull(),
    /** 领域字段对应：Product.subCategory */
    subCategory: text("sub_category").notNull().default(""),
    price: numeric("price", { precision: 10, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    /** 领域字段对应：Product.unit，如 500g / 盒 */
    unit: text("unit").notNull().default(""),
    /** 领域字段对应：Product.stock */
    stock: integer("stock").notNull().default(0),
    origin: text("origin").notNull().default(""),
    specification: text("specification").notNull().default(""),
    storageMethod: text("storage_method").notNull().default(""),
    shelfLife: text("shelf_life").notNull().default(""),
    imageUrl: text("image_url"),
    /** 领域字段对应：Product.tags */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /** 领域字段对应：Product.metrics（views / inquiries / conversions） */
    metrics: jsonb("metrics")
      .$type<{ views: number; inquiries: number; conversions: number }>()
      .notNull()
      .default({ views: 0, inquiries: 0, conversions: 0 }),
    analysisStatus: productAnalysisStatusEnum("analysis_status")
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("products_business_id_idx").on(table.businessId),
    index("products_analysis_status_idx").on(table.analysisStatus),
    uniqueIndex("products_business_name_unique").on(table.businessId, table.name),
  ],
);

/* ------------------------------------------------------------------ */
/* 5. product_dna —— 商品经理 Agent 的结构化输出                       */
/* ------------------------------------------------------------------ */

export const productDna = pgTable(
  "product_dna",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    category: text("category").notNull().default(""),
    subCategory: text("sub_category").notNull().default(""),
    /** 视觉特征 */
    visualFeatures: jsonb("visual_features")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 核心特征 */
    coreFeatures: jsonb("core_features").$type<string[]>().notNull().default([]),
    /** 核心卖点 */
    sellingPoints: jsonb("selling_points").$type<string[]>().notNull().default([]),
    /** 目标用户 */
    targetUsers: jsonb("target_users").$type<string[]>().notNull().default([]),
    /** 消费场景，领域字段对应：ProductDNA.consumptionScenarios */
    scenarios: jsonb("scenarios").$type<string[]>().notNull().default([]),
    /** 用户痛点 */
    painPoints: jsonb("pain_points").$type<string[]>().notNull().default([]),
    /** 营销角度 */
    marketingAngles: jsonb("marketing_angles")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 风险提示（合规相关） */
    riskNotes: jsonb("risk_notes").$type<string[]>().notNull().default([]),
    /** 领域字段对应：ProductDNA.aiVersion */
    aiVersion: text("ai_version").notNull().default("v1.0"),
    /** 领域字段对应：ProductDNA.confidence，范围 0 ~ 1 */
    confidence: real("confidence").notNull().default(0),
    /** 领域字段对应：ProductDNA.approved */
    approved: boolean("approved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** 一个商品同一时刻只保留一份 DNA，重新分析为 update */
    uniqueIndex("product_dna_product_id_unique").on(table.productId),
  ],
);

/* ------------------------------------------------------------------ */
/* 6. brand_profiles —— 品牌经理 Agent 的结构化输出（品牌档案）        */
/* ------------------------------------------------------------------ */

/**
 * 品牌档案表（S3-1 建立）。
 *
 * 与产品语义的对应关系：
 * - **一个商家一份品牌档案**（`brand_profiles_business_id_unique`），
 *   重新生成走 update 而不是追加新行 —— 否则「当前品牌是什么」将没有唯一答案。
 * - 品牌由 **Product DNA + Owner Profile** 推导而来，因此记录 `sourceProductId`
 *   作为「本次生成的主依据商品」，便于回溯；该商品被删除时置空（**不级联删品牌**，
 *   品牌已不依赖单个商品而存在）。
 * - 列名与 `src/types/brand.ts` 的领域字段一一对应；AI 契约里的 `brandKeywords`
 *   落到 `brand_personality`、`visualDirection` 落到 `visual_keywords`，
 *   改名集中在 `src/ai/schemas/brand-profile.ts` 一处。
 */
export const brandProfiles = pgTable(
  "brand_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** 领域字段对应：BrandProfile.positioning */
    positioning: text("positioning").notNull().default(""),
    /** 领域字段对应：BrandProfile.brandStory */
    brandStory: text("brand_story").notNull().default(""),
    /** 领域字段对应：BrandProfile.slogan */
    slogan: text("slogan").notNull().default(""),
    /** 领域字段对应：BrandProfile.ipConcept */
    ipConcept: text("ip_concept").notNull().default(""),
    /** 领域字段对应：BrandProfile.brandValues */
    brandValues: jsonb("brand_values").$type<string[]>().notNull().default([]),
    /** 领域字段对应：BrandProfile.targetAudience */
    targetAudience: jsonb("target_audience")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 领域字段对应：BrandProfile.brandPersonality（AI 契约里叫 brandKeywords） */
    brandPersonality: jsonb("brand_personality")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 领域字段对应：BrandProfile.toneOfVoice（AI 契约里叫 tone） */
    toneOfVoice: jsonb("tone_of_voice").$type<string[]>().notNull().default([]),
    /** 领域字段对应：BrandProfile.visualKeywords（AI 契约里叫 visualDirection） */
    visualKeywords: jsonb("visual_keywords")
      .$type<string[]>()
      .notNull()
      .default([]),
    /**
     * 品牌合规 / 事实风险提示（领域字段对应：BrandProfile.riskNotes）。
     *
     * 为什么它必须**落库**而不是只留在 agent_tasks.output 里：
     * 1. Mock 占位标记写在这里，才能让「这份档案是不是真实模型产出的」在库里也能分辨；
     * 2. 绝对化用语、疑似虚构产地这类风险要随档案一起留痕，而不是随任务记录被翻过去。
     */
    riskNotes: jsonb("risk_notes").$type<string[]>().notNull().default([]),
    /** 本次生成的主依据商品；商品删除后置空，品牌档案保留 */
    sourceProductId: uuid("source_product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    /** 领域字段对应：BrandProfile.aiVersion 的取值来源，AI 契约版本号 */
    aiVersion: text("ai_version").notNull().default("v1.0"),
    /** 模型对本次产出的整体把握 0 ~ 1 */
    confidence: real("confidence").notNull().default(0),
    /** AI 产出默认未确认，必须由商家确认后才对外使用 */
    approved: boolean("approved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** 一个商家同时只保留一份品牌档案，重新生成为 update */
    uniqueIndex("brand_profiles_business_id_unique").on(table.businessId),
    index("brand_profiles_source_product_id_idx").on(table.sourceProductId),
  ],
);

/* ------------------------------------------------------------------ */
/* 7. contents —— Content Agent 的结构化输出（内容资产）               */
/* ------------------------------------------------------------------ */

/**
 * 内容资产表（S3-2 建立）。
 *
 * 与产品语义的对应关系：
 * - **一个「商品 × 平台 × 内容形态」槽位同时只保留一条内容**（`contents_slot_unique`）。
 *   重新生成走 update 覆盖同一个槽位 —— 否则连点几次「生成」就会堆出一串
 *   几乎一样的内容，把内容资产变成垃圾场。槽位概念见 `src/types/content.ts`。
 * - `product_name` 是**快照列**，不对商品表做 join：内容正文里本来就会提到当时的商品名，
 *   商品后来改名不应改写历史内容上的署名。
 * - 列名与 `src/types/content.ts` 的领域字段一一对应；AI 契约里的 `type` 落到 `format`、
 *   `scenes` 落到 `shot_list`、`tags` 落到 `hashtags`、`callToAction` 落到 `cta`，
 *   改名集中在 `src/ai/schemas/content.ts` 一处。
 * - `platform` / `format` / `status` 用 `text` + 应用层 Zod 约束而不是 pgEnum：
 *   平台与内容形态会随渠道演进（新平台、新体裁），用枚举意味着每加一个渠道就要一次迁移
 *   去改类型定义；只有「商品分类」那种稳定分类才适合 pgEnum。
 * - **不存 AI 原始 Markdown**：结构化字段分列存储，`body` 只放可发布正文。
 */
export const contents = pgTable(
  "contents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** 领域字段对应：ContentItem.productName（生成当时的商品名快照） */
    productName: text("product_name").notNull().default(""),
    platform: text("platform").notNull(),
    /** 领域字段对应：ContentItem.format；AI 契约里叫 type */
    format: text("format").notNull(),
    /** 领域字段对应：ContentItem.status（draft / reviewing / approved / published / failed） */
    status: text("status").notNull().default("draft"),
    title: text("title").notNull().default(""),
    /** 开场钩子：前 3 秒 / 首屏第一句 */
    hook: text("hook").notNull().default(""),
    /** 正文（保留换行） */
    body: text("body").notNull().default(""),
    /** 领域字段对应：ContentItem.cta；AI 契约里叫 callToAction */
    cta: text("cta").notNull().default(""),
    /** 领域字段对应：ContentItem.hashtags；AI 契约里叫 tags */
    hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),
    visualSuggestions: jsonb("visual_suggestions")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 领域字段对应：ContentItem.shotList；AI 契约里叫 scenes */
    shotList: jsonb("shot_list").$type<string[]>().notNull().default([]),
    /** 口播旁白 */
    voiceover: text("voiceover").notNull().default(""),
    /**
     * 合规与事实风险提示（领域字段对应：ContentItem.riskNotes）。
     * 必须落库而不只留在 agent_tasks.output：Mock 占位标记写在这里，
     * 「这条内容是不是真实模型产出的」才在库里也能分辨。
     */
    riskNotes: jsonb("risk_notes").$type<string[]>().notNull().default([]),
    /** 领域字段对应：ContentItem.aiVersion 的取值来源，AI 契约版本号 */
    aiVersion: text("ai_version").notNull().default("v1.0"),
    /** 领域字段对应：ContentItem.confidence，模型对本次产出的把握 0 ~ 1 */
    confidence: real("confidence").notNull().default(0),
    /**
     * 内容表现数据。新生成的内容**一律为 0** ——
     * 还没排期发布就填一个播放量就是假数据，真实数据等平台回流（S6 Analytics）。
     */
    metrics: jsonb("metrics")
      .$type<{
        views: number;
        likes: number;
        comments: number;
        shares: number;
        engagementRate: number;
      }>()
      .notNull()
      .default({ views: 0, likes: 0, comments: 0, shares: 0, engagementRate: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** 一个槽位同时只保留一条内容，重新生成为 update */
    uniqueIndex("contents_slot_unique").on(
      table.productId,
      table.platform,
      table.format,
    ),
    index("contents_business_id_idx").on(table.businessId),
    index("contents_product_id_idx").on(table.productId),
    index("contents_status_idx").on(table.status),
  ],
);

/* ------------------------------------------------------------------ */
/* 8. agent_workflows —— Agent 工作流（提前准备）                      */
/* ------------------------------------------------------------------ */

export const agentWorkflows = pgTable(
  "agent_workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** 经营目标，如「推广连江鲜活鲍鱼」 */
    goal: text("goal").notNull(),
    status: workflowStatusEnum("status").notNull().default("idle"),
    /** 领域字段对应：AgentWorkflow.progress，0 ~ 100 */
    progress: integer("progress").notNull().default(0),
    /** 领域字段对应：AgentWorkflow.activeStageIndex */
    activeStageIndex: integer("active_stage_index").notNull().default(0),
    /**
     * S4-1 新增：Business Brain 产出的**原始计划快照**（已过 Zod 校验）。
     *
     * 为什么必须落库而不是只放内存里：
     * 1. 可解释性 —— 事后能回答「这一轮为什么只跑了两个任务」；
     * 2. 重试 —— `retryWorkflow` 直接复用原计划，不必再花一次模型调用重新规划
     *    （重规划可能产出不同计划，让「重试」变成「换一件事做」）。
     */
    plan: jsonb("plan").$type<Record<string, unknown>>(),
    /**
     * S4-1 新增：本轮执行的统计摘要，形如
     * `{ totalTasks, executed, reused, skipped, failed }`。
     * 用于驾驶舱直接展示「复用 2 项 / 生成 2 项」，不必回查任务表做聚合。
     */
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    /** S4-1 新增：工作流整体失败原因（计划校验不通过 / 全部任务失败） */
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_workflows_business_id_idx").on(table.businessId),
    /**
     * S4-1 新增：`findLatestRunning` 要按 business 找运行中的工作流做防重复，
     * 没有这个索引就得全表扫。
     */
    index("agent_workflows_status_idx").on(table.status),
  ],
);

/* ------------------------------------------------------------------ */
/* 9. agent_tasks —— 工作流下的单个 Agent 任务                         */
/* ------------------------------------------------------------------ */

export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * 所属工作流。**可空** —— 商品分析这类由用户单点触发的任务并不从属于某个经营目标，
     * 等 S3 的 Workflow 编排落地后再按需回填。
     */
    workflowId: uuid("workflow_id").references(() => agentWorkflows.id, {
      onDelete: "cascade",
    }),
    /** 归属商品（商品类 Agent 任务专用）；商品删除时任务一并清理 */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    agentType: agentTypeEnum("agent_type").notNull(),
    title: text("title").notNull(),
    status: agentStatusEnum("status").notNull().default("queued"),
    /** 单个任务进度 0 ~ 100 */
    progress: integer("progress").notNull().default(0),
    /** 任务输入（Agent 调用参数） */
    input: jsonb("input").$type<Record<string, unknown>>(),
    /** 任务输出（已通过 Zod 校验的结构化结果） */
    output: jsonb("output").$type<Record<string, unknown>>(),
    /** 失败原因，便于前端展示与重试 */
    errorMessage: text("error_message"),
    /** 执行耗时（毫秒）；未完成时为 null */
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_tasks_workflow_id_idx").on(table.workflowId),
    index("agent_tasks_status_idx").on(table.status),
    index("agent_tasks_product_id_idx").on(table.productId),
  ],
);

/* ------------------------------------------------------------------ */
/* 10. knowledge_documents —— RAG 知识库文档                           */
/* ------------------------------------------------------------------ */

/**
 * 知识文档表（S5 扩展）。
 *
 * 与 S1 初建时的差别：那时只有「文件型知识源」的概念（name + type + fileUrl），
 * 现在它是 RAG 的真正入口，因此补齐了正文与索引状态：
 * - `content`：文档正文。人工录入直接写它；系统同步文档由已有真实数据拼装。
 *   正文与切片分离存储 —— 切片是为了检索，正文是为了让商家能编辑与核对。
 * - `source`：`system`（由商品 / DNA / 品牌自动同步）或 `manual`（人工录入）。
 *   重新同步时只覆盖 `system` 文档，人工文档必须保留每一个字。
 * - `product_id`：商品级文档的归属；全店级（物流 / 售后 / 品牌）为 null。
 * - `index_status` / `index_error`：切片 + 向量化是独立一步，会失败。
 *   把失败状态落库，界面才能显示「这份文档没索引成功」而不是假装它可用。
 */
export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: knowledgeTypeEnum("type").notNull(),
    /** 领域字段对应：KnowledgeDocument.source */
    source: knowledgeSourceEnum("source").notNull().default("manual"),
    fileUrl: text("file_url"),
    /** 领域字段对应：KnowledgeDocument.summary（列表页摘要展示） */
    summary: text("summary").notNull().default(""),
    /** 领域字段对应：KnowledgeDocument.content（正文，切片来源） */
    content: text("content").notNull().default(""),
    /** 领域字段对应：KnowledgeDocument.productId */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    /** 领域字段对应：KnowledgeDocument.indexStatus */
    indexStatus: knowledgeIndexStatusEnum("index_status")
      .notNull()
      .default("pending"),
    /** 领域字段对应：KnowledgeDocument.indexError */
    indexError: text("index_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("knowledge_documents_business_id_idx").on(table.businessId),
    index("knowledge_documents_product_id_idx").on(table.productId),
    /**
     * 同一商家下「同类型 + 同名称」只允许一份。
     *
     * 系统同步文档靠它做幂等 upsert（每次同步都 upsert 同一份，不会堆出
     * 十份《连江鲜活鲍鱼 · 商品资料》）；人工文档靠它挡住重复提交。
     */
    uniqueIndex("knowledge_documents_business_name_unique").on(
      table.businessId,
      table.type,
      table.name,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* 11. knowledge_chunks —— 知识切片（S5 起真实写入向量）               */
/* ------------------------------------------------------------------ */

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    /**
     * 冗余归属商家。
     *
     * 加这一列（而不是检索时 join 文档表）是为了让**每一次向量查询都自带商家过滤**：
     * `WHERE business_id = $1` 写在检索语句里，跨商家泄漏就不可能发生；
     * 若依赖 join，任何一次「忘了带条件」的查询都会静默返回别家的知识。
     */
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    /** 归属商品；全店级知识为 null */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    /** 冗余文档类型，供检索按 sourceType 过滤 */
    sourceType: knowledgeTypeEnum("source_type").notNull(),
    /** 冗余文档名，检索命中后可直接展示引用来源，无需回查文档表 */
    title: text("title").notNull().default(""),
    /** 切片序号（从 0 开始），用于排序与「第几段」展示 */
    chunkIndex: integer("chunk_index").notNull().default(0),
    content: text("content").notNull(),
    /**
     * 向量以 PostgreSQL 原生 `real[]` 存储，不用 pgvector 的 `vector(1024)`。
     *
     * 原因见迁移 `0000_vengeful_nico_minoru.sql` 顶部：本地开发跑的 PGlite
     * 不含 pgvector 扩展。维度约束由应用层的 `isEmbeddingVector` 保证
     * （写入前校验 1024 维且全为有限数），不依赖列类型。
     *
     * 为什么降级可接受：检索本来就要在应用层算余弦（知识库是千条级），
     * 少一个向量索引不构成瓶颈。将来需要 pgvector 时按迁移顶部三步还原。
     */
    embedding: real("embedding").array(),
    /** 领域字段对应：KnowledgeChunk.metadata */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("knowledge_chunks_document_id_idx").on(table.documentId),
    index("knowledge_chunks_business_id_idx").on(table.businessId),
    index("knowledge_chunks_product_id_idx").on(table.productId),
  ],
);

/* ------------------------------------------------------------------ */
/* 12. knowledge_gaps —— 知识缺口（RAG 答不上来的问题聚合）            */
/* ------------------------------------------------------------------ */

/**
 * 知识缺口表（S5 新增）。
 *
 * 一个「缺口」是**同一类问题**，不是一次提问 —— 否则「这个怎么保存？」
 * 被问 30 次就会建 30 行，缺口面板直接变成噪声。因此以
 * `(business_id, gap_key)` 唯一，重复提问只累加 `occurrence_count`。
 *
 * **为什么唯一索引落在 `gap_key` 上，而不是 `(business_id, normalized_question)`。**
 * 先看老写法的两个漏洞：
 *   1. 键里没有商品维度 —— 但 `product_id` 是**可空**的，而 Postgres 的唯一索引
 *      把每一行 NULL 都视为互不相同。想用 `(business_id, product_id, normalized_question)`
 *      做聚合，商品级问题（product_id 非空）能正确合并，而政策级问题（product_id 为 NULL）
 *      会**每一行都算一条新缺口**，计数永远停在 1。两个诉求无法用同一组列同时满足。
 *   2. 把问题原文放进索引意味着索引体积随问题长度增长，而键其实只需要「相等判断」。
 * 改成单列哈希后，上述两点一起消失：NULL 在哈希**之前**就被折叠成确定的字符串，
 * 索引宽度恒定，且聚合边界（商家 / 商品 / 问题）由 `buildKnowledgeGapKey` 一处定义。
 *
 * `gap_key` 由应用层计算（`src/rag/knowledge-gap.ts`），**不用触发器或生成列**：
 * 哈希算法一旦要调整，改应用代码比改数据库对象安全得多，
 * 而且 Mock 仓储必须能算出逐位相同的键 —— 两套数据源行为一致是硬要求。
 *
 * 为什么把规范化后的问题仍然单独存一列（尽管它已被哈希覆盖）：
 * 面板要显示「商家当时看到的那句话长什么样」，排查聚合异常时也需要它。
 * 它是一个**可读的事实**，不是索引目标。
 */
export const knowledgeGaps = pgTable(
  "knowledge_gaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    /** 首次提问时的原话（面板展示用） */
    question: text("question").notNull(),
    /** 规范化文本（可读的事实 + 聚合边界的一部分） */
    normalizedQuestion: text("normalized_question").notNull(),
    /**
     * 聚合键：`sha256(businessId + productId + normalizedQuestion)` 的十六进制。
     * 同一聚合键在**数据库层**只能存在一条 —— 并发提问也不会插出两行。
     */
    gapKey: text("gap_key").notNull(),
    /** 归一化意图（storage / logistics / …）。**属于载荷，不属于身份**，见 schema 上方注释 */
    intent: text("intent").notNull().default("other"),
    /** 为什么答不上来（面向商家的说明） */
    reason: text("reason").notNull().default(""),
    status: knowledgeGapStatusEnum("status").notNull().default("open"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** 被哪份文档补齐（标记 resolved 时写入） */
    resolvedDocumentId: uuid("resolved_document_id").references(
      () => knowledgeDocuments.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    uniqueIndex("knowledge_gaps_business_gap_key_unique").on(
      table.businessId,
      table.gapKey,
    ),
    index("knowledge_gaps_status_idx").on(table.status),
    index("knowledge_gaps_business_id_idx").on(table.businessId),
  ],
);

/* ------------------------------------------------------------------ */
/* 13. customer_conversations —— 客服会话                              */
/* ------------------------------------------------------------------ */

export const customerConversations = pgTable(
  "customer_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    customerName: text("customer_name").notNull(),
    /** 次要标识，如「抖音 · 老客」 */
    customerLabel: text("customer_label").notNull().default(""),
    channel: conversationChannelEnum("channel").notNull().default("douyin"),
    status: conversationStatusEnum("status").notNull().default("bot"),
    /** 消费者问的是哪件商品；未指定为 null */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    unreadCount: integer("unread_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("customer_conversations_business_id_idx").on(table.businessId),
    index("customer_conversations_updated_at_idx").on(table.updatedAt),
  ],
);

/* ------------------------------------------------------------------ */
/* 14. customer_messages —— 客服消息                                   */
/* ------------------------------------------------------------------ */

export const customerMessages = pgTable(
  "customer_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => customerConversations.id, { onDelete: "cascade" }),
    role: chatRoleEnum("role").notNull(),
    content: text("content").notNull(),
    /** 是否完全由检索到的知识支撑；人工消息为 null */
    grounded: boolean("grounded"),
    /** 归一化意图 */
    intent: text("intent"),
    /** AI 自评置信度 0 ~ 1 */
    confidence: real("confidence"),
    /**
     * 引用来源快照（documentId / chunkId / title / type / score）。
     *
     * 存快照而不是只存 chunkId：知识可能被重新索引（chunk id 全变），
     * 而「当时这条回答引用的是哪份文档」是**历史事实**，不该被后续重建抹掉。
     */
    citations: jsonb("citations")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    /** 是否建议转人工 */
    needsHuman: boolean("needs_human").notNull().default(false),
    /** 触发 / 关联的知识缺口 */
    knowledgeGapId: uuid("knowledge_gap_id").references(() => knowledgeGaps.id, {
      onDelete: "set null",
    }),
    /** 检索到的片段数（诊断「为什么答不上来」） */
    retrievedCount: integer("retrieved_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("customer_messages_conversation_id_idx").on(table.conversationId),
    index("customer_messages_created_at_idx").on(table.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/* 15. live_sessions —— AI 直播间场次（S7 补齐）                       */
/* ------------------------------------------------------------------ */

/**
 * 直播场次表（S7 从 NOT_IMPLEMENTED 占位补齐为真实表）。
 *
 * - `business_id` 必填：直播是商家级活动，跨商家隔离由存储层最清楚的一处兜住。
 * - `product_name` 是**快照列**（与 `contents.product_name` 同理）：直播标题与
 *   商品绑定当时的名字，商品后来改名不应改写历史直播的署名。
 * - `comments_count` / `ai_handled_count` 是**冗余计数**：追加评论 / 建议时由仓储
 *   在同一事务里 `+1`，列表页不用每次 GROUP BY。Mock 与 DB 语义保持一致。
 */
export const liveSessions = pgTable(
  "live_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** 领域字段对应：LiveSession.productName（生成当时的商品名快照） */
    productName: text("product_name").notNull().default(""),
    status: text("status").notNull().default("idle"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    commentsCount: integer("comments_count").notNull().default(0),
    aiHandledCount: integer("ai_handled_count").notNull().default(0),
    hostTranscript: text("host_transcript").notNull().default(""),
    rehearsalReport: jsonb("rehearsal_report").$type<LiveRehearsalReport>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("live_sessions_business_id_idx").on(table.businessId),
    index("live_sessions_started_at_idx").on(table.startedAt),
  ],
);

/* ------------------------------------------------------------------ */
/* 16. live_comments —— AI 直播间评论（S7 补齐）                       */
/* ------------------------------------------------------------------ */

/**
 * 直播评论表。
 *
 * `intent` / `priority` 用 `text` 可空：未分析的评论为 null（与 Mock 种子一致），
 * 且意图清单会随场景演进（S6 一次就扩了 5 个值），用 pgEnum 每加一个值就要迁移。
 */
export const liveComments = pgTable(
  "live_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => liveSessions.id, { onDelete: "cascade" }),
    authorName: text("author_name").notNull().default(""),
    content: text("content").notNull(),
    intent: text("intent"),
    priority: text("priority"),
    handled: boolean("handled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("live_comments_session_id_idx").on(table.sessionId),
    index("live_comments_created_at_idx").on(table.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/* 17. live_suggestions —— AI 直播导演建议（S7 补齐）                  */
/* ------------------------------------------------------------------ */

/**
 * AI 直播导演对单条评论的结论。
 *
 * `citations` / `risk_notes` 是快照：引用来源与风险提示是「当时」的事实，
 * 知识库后续重建不应改写历史建议。
 */
export const liveSuggestions = pgTable(
  "live_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => liveComments.id, { onDelete: "cascade" }),
    /** 评论原文快照（面板直接展示，省得回查） */
    commentContent: text("comment_content").notNull(),
    intent: text("intent").notNull(),
    priority: text("priority").notNull(),
    shouldRespond: boolean("should_respond").notNull().default(false),
    responseMode: text("response_mode").notNull(),
    hostSuggestion: text("host_suggestion").notNull().default(""),
    suggestedReply: text("suggested_reply").notNull().default(""),
    sellingAngle: text("selling_angle"),
    grounded: boolean("grounded").notNull().default(false),
    /** 引用来源快照 */
    citations: jsonb("citations")
      .$type<KnowledgeSource[]>()
      .notNull()
      .default([]),
    recommendedAction: text("recommended_action").notNull(),
    riskNotes: jsonb("risk_notes").$type<string[]>().notNull().default([]),
    confidence: real("confidence").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    /** AI 处理失败时的说明；成功为 null */
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("live_suggestions_comment_id_idx").on(table.commentId),
    index("live_suggestions_created_at_idx").on(table.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/* 18. business_reports —— AI 经营日报（S7 补齐）                      */
/* ------------------------------------------------------------------ */

/**
 * 经营日报表：**快照与结论一起存**。
 *
 * `snapshot` 是程序计算的事实切片，`report` 是 Analytics Agent 的结论，
 * 两者都是本项目自己产出的领域类型（不是别家 schema），因此直接以
 * `jsonb` + `$type<T>()` 约束，读出不解析。
 */
export const businessReports = pgTable(
  "business_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    snapshot: jsonb("snapshot").$type<AnalyticsSnapshot>().notNull(),
    report: jsonb("report").$type<AnalyticsReport>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("business_reports_business_id_idx").on(table.businessId),
    index("business_reports_created_at_idx").on(table.createdAt),
  ],
);

/** 商户录入的销售明细。演示数据单独标记，避免和真实导入记录混算。 */
export const salesRecords = pgTable(
  "sales_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    recordNo: text("record_no").notNull(),
    saleDate: text("sale_date").notNull(),
    productName: text("product_name").notNull(),
    channel: text("channel").notNull(),
    quantity: integer("quantity").notNull(),
    revenueCents: integer("revenue_cents").notNull(),
    costCents: integer("cost_cents"),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sales_records_business_no_unique").on(table.businessId, table.recordNo),
    index("sales_records_business_date_idx").on(table.businessId, table.saleDate),
  ],
);

/* ------------------------------------------------------------------ */
/* 行类型导出（仓储实现里用于做显式映射）                              */
/* ------------------------------------------------------------------ */

export type BusinessRow = typeof businesses.$inferSelect;
export type NewBusinessRow = typeof businesses.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type OwnerProfileRow = typeof ownerProfiles.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;
export type ProductDnaRow = typeof productDna.$inferSelect;
export type NewProductDnaRow = typeof productDna.$inferInsert;
export type BrandProfileRow = typeof brandProfiles.$inferSelect;
export type NewBrandProfileRow = typeof brandProfiles.$inferInsert;
export type ContentRow = typeof contents.$inferSelect;
export type NewContentRow = typeof contents.$inferInsert;
export type AgentWorkflowRow = typeof agentWorkflows.$inferSelect;
export type NewAgentWorkflowRow = typeof agentWorkflows.$inferInsert;
export type AgentTaskRow = typeof agentTasks.$inferSelect;
export type NewAgentTaskRow = typeof agentTasks.$inferInsert;
export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;
export type NewKnowledgeDocumentRow = typeof knowledgeDocuments.$inferInsert;
export type KnowledgeChunkRow = typeof knowledgeChunks.$inferSelect;
export type NewKnowledgeChunkRow = typeof knowledgeChunks.$inferInsert;
export type KnowledgeGapRow = typeof knowledgeGaps.$inferSelect;
export type NewKnowledgeGapRow = typeof knowledgeGaps.$inferInsert;
export type CustomerConversationRow = typeof customerConversations.$inferSelect;
export type NewCustomerConversationRow = typeof customerConversations.$inferInsert;
export type CustomerMessageRow = typeof customerMessages.$inferSelect;
export type NewCustomerMessageRow = typeof customerMessages.$inferInsert;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type LiveSessionRow = typeof liveSessions.$inferSelect;
export type NewLiveSessionRow = typeof liveSessions.$inferInsert;
export type LiveCommentRow = typeof liveComments.$inferSelect;
export type NewLiveCommentRow = typeof liveComments.$inferInsert;
export type LiveSuggestionRow = typeof liveSuggestions.$inferSelect;
export type NewLiveSuggestionRow = typeof liveSuggestions.$inferInsert;
export type BusinessReportRow = typeof businessReports.$inferSelect;
export type NewBusinessReportRow = typeof businessReports.$inferInsert;
export type SalesRecordRow = typeof salesRecords.$inferSelect;
