import type { DataSourceId } from "@/lib/env";
import type {
  AgentId,
  AgentStatus,
  ContentPlatform,
  ContentStatus,
  ConversationChannel,
  ConversationStatus,
  CustomerIntent,
  KnowledgeDocumentSource,
  KnowledgeDocumentType,
  KnowledgeGapStatus,
  KnowledgeIndexStatus,
  LiveIntent,
  LivePriority,
  LiveRecommendedAction,
  LiveResponseMode,
  ProductAnalysisStatus,
  StatusTone,
  WorkflowStatus,
} from "@/types";

interface Meta {
  label: string;
  tone: StatusTone;
}

/**
 * 数据来源 → 页面角标文案。
 *
 * 三种来源必须**分得清**，不能笼统写成「有数据」：
 * - `mock`  —— 进程内存，重启即还原，只能叫「演示数据」；
 * - `local` —— 本地 PGlite，重启后仍在，是**真实持久化**的库，若也说成「演示数据」，
 *              用户重启服务发现数据还在，反而会怀疑界面在骗人；
 * - `db`    —— 远程 Supabase PostgreSQL。
 *
 * 类型取自 `@/lib/env`，用 `import type` 引入（编译期擦除），
 * 因此本文件仍可被客户端组件安全引用。
 */
export const DATA_SOURCE_LABEL: Record<DataSourceId, string> = {
  mock: "演示数据（Mock）",
  local: "本地数据库",
  db: "数据库数据",
};

/** AI 数字员工名称（数据层从 agent_type 反查展示名时使用） */
export const AGENT_NAME_LABEL: Record<AgentId, string> = {
  business_brain: "AI经营大脑",
  product_agent: "商品经理",
  brand_agent: "品牌经理",
  content_agent: "内容运营",
  live_agent: "AI直播导演",
  customer_service_agent: "智能客服",
  analytics_agent: "经营分析师",
};

/** Agent 运行状态 → 文案 / 色调 */
export const AGENT_STATUS_META: Record<AgentStatus, Meta> = {
  idle: { label: "空闲", tone: "neutral" },
  queued: { label: "排队中", tone: "warning" },
  running: { label: "执行中", tone: "primary" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "执行失败", tone: "danger" },
  /**
   * 中性文案：「本次没执行」本身不是好消息也不是坏消息，
   * 究竟是因为「已有结果可复用」（省了钱）还是「上游失败被阻塞」（没做成），
   * 要看任务的 `output.execution` / `output.skipReason`，由编排层视图如实表达。
   * 在这里写死成「已复用」会把 dependency_failed 也说成好事。
   */
  skipped: { label: "已跳过", tone: "neutral" },
};

export const WORKFLOW_STATUS_META: Record<WorkflowStatus, Meta> = {
  idle: { label: "未启动", tone: "neutral" },
  running: { label: "运行中", tone: "primary" },
  completed: { label: "已完成", tone: "success" },
  /**
   * `failed` 此前兼表「部分失败」，S4-1 起语义收窄为**整体失败**
   * （无任何任务成功，或计划本身没通过校验）。
   */
  failed: { label: "执行失败", tone: "danger" },
  /** 有成功也有失败 —— 编排跑起来之后这是最常见的收尾状态，不该混进 failed */
  partially_completed: { label: "部分完成", tone: "warning" },
  cancelled: { label: "已取消", tone: "neutral" },
};

export const PRODUCT_ANALYSIS_META: Record<ProductAnalysisStatus, Meta> = {
  pending: { label: "待分析", tone: "warning" },
  analyzing: { label: "分析中", tone: "primary" },
  /**
   * 文案用「商品理解」而不是「DNA」：`src/lib/user-facing-text.ts` 已确立
   * 「Product DNA 对商家一律说商品理解」的口径，界面标签不该另起一个叫法 ——
   * 同一个东西两个名字，商家会以为是两回事。
   */
  analyzed: { label: "已生成商品理解", tone: "success" },
  failed: { label: "分析失败", tone: "danger" },
};

export const CONTENT_PLATFORM_LABEL: Record<ContentPlatform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  wechat: "朋友圈",
  shipinhao: "视频号",
  detail: "商品详情",
  ads: "广告投放",
};

export const CONTENT_FORMAT_LABEL: Record<
  "short-video" | "article" | "poster-copy" | "voiceover",
  string
> = {
  "short-video": "短视频脚本",
  article: "图文笔记",
  "poster-copy": "海报文案",
  voiceover: "视频旁白",
};

export const CONTENT_STATUS_META: Record<ContentStatus, Meta> = {
  draft: { label: "草稿", tone: "neutral" },
  reviewing: { label: "待确认", tone: "warning" },
  approved: { label: "已确认", tone: "success" },
  published: { label: "已发布", tone: "primary" },
  failed: { label: "生成失败", tone: "danger" },
};

export const LIVE_INTENT_META: Record<LiveIntent, Meta> = {
  product_question: { label: "商品咨询", tone: "info" },
  storage_question: { label: "储存问题", tone: "info" },
  price_question: { label: "价格问题", tone: "warning" },
  cooking_question: { label: "烹饪问题", tone: "primary" },
  origin_question: { label: "产地问题", tone: "success" },
  logistics_question: { label: "物流问题", tone: "neutral" },
  after_sale: { label: "售后问题", tone: "danger" },
  purchase_intent: { label: "购买意图", tone: "success" },
  objection: { label: "异议处理", tone: "danger" },
  comparison: { label: "比价比较", tone: "warning" },
  praise: { label: "正向反馈", tone: "success" },
  spam: { label: "垃圾信息", tone: "neutral" },
  other: { label: "其他", tone: "neutral" },
};

export const LIVE_PRIORITY_META: Record<LivePriority, Meta> = {
  high: { label: "高优先级", tone: "danger" },
  medium: { label: "中优先级", tone: "warning" },
  low: { label: "低优先级", tone: "neutral" },
};

/** 回应方式 → 文案 / 色调（S6） */
export const LIVE_RESPONSE_MODE_META: Record<LiveResponseMode, Meta> = {
  answer_now: { label: "立即回应", tone: "danger" },
  mention_later: { label: "稍后带过", tone: "warning" },
  send_to_customer_service: { label: "建议转客服", tone: "info" },
  ignore: { label: "无需回应", tone: "neutral" },
};

/** 推荐动作 → 中文标签（S6）。动作本身是稳定的枚举，展示名集中在这里 */
export const LIVE_ACTION_LABEL: Record<LiveRecommendedAction, string> = {
  explain_product: "讲解商品",
  explain_storage: "讲解储存",
  explain_cooking: "讲解做法",
  clarify_logistics: "澄清物流",
  handle_objection: "处理异议",
  reinforce_selling_point: "强化卖点",
  guide_to_customer_service: "引导客服确认",
  engage_audience: "互动带节奏",
  ignore: "忽略",
};

export const CONVERSATION_STATUS_META: Record<ConversationStatus, Meta> = {
  bot: { label: "AI 接待", tone: "primary" },
  human: { label: "待转人工", tone: "warning" },
  closed: { label: "已结束", tone: "neutral" },
};

export const CONVERSATION_CHANNEL_LABEL: Record<ConversationChannel, string> = {
  simulator: "模拟会话",
  douyin: "抖音小店",
  wechat: "微信",
  shipinhao: "视频号",
  store: "门店",
};

export const KNOWLEDGE_TYPE_LABEL: Record<KnowledgeDocumentType, string> = {
  product: "商品说明",
  faq: "常见问题",
  logistics: "物流政策",
  after_sales: "售后政策",
  brand: "品牌资料",
  cooking: "烹饪方式",
  storage: "储存方式",
  manual: "人工资料",
};

/** 知识来源 → 文案（系统同步 / 人工录入） */
export const KNOWLEDGE_SOURCE_LABEL: Record<KnowledgeDocumentSource, string> = {
  system: "系统同步",
  manual: "人工录入",
};

/**
 * 索引状态 → 文案 / 色调（S5）。
 *
 * 必须展示给商家：文档写进知识库、和「它真的能被检索到」是两件事。
 * `pending` 表示还没切好片、`failed` 表示切片或向量化失败了 ——
 * 这两种状态下这份文档**检索不到**，界面上若一律显示成正常的条目，
 * 商家会以为自己已经补充过知识，而 AI 仍然答不上来。
 */
export const KNOWLEDGE_INDEX_STATUS_META: Record<KnowledgeIndexStatus, Meta> = {
  pending: { label: "待索引", tone: "warning" },
  indexed: { label: "已索引", tone: "success" },
  failed: { label: "索引失败", tone: "danger" },
};

/** 知识缺口状态 → 文案 / 色调 */
export const KNOWLEDGE_GAP_STATUS_META: Record<KnowledgeGapStatus, Meta> = {
  open: { label: "待补充", tone: "warning" },
  resolved: { label: "已解决", tone: "success" },
  ignored: { label: "已忽略", tone: "neutral" },
};

/** 客服意图 → 文案（与 `CustomerIntent` 一一对应） */
export const CUSTOMER_INTENT_LABEL: Record<CustomerIntent, string> = {
  product: "商品咨询",
  storage: "储存方式",
  cooking: "烹饪方式",
  logistics: "物流时效",
  after_sales: "售后政策",
  price: "价格咨询",
  other: "其他问题",
};

/**
 * 知识优先级（任务书第十七节）。
 *
 * 数字越小越优先。核心判断：**商家人工写的政策高于 AI 生成的资料** ——
 * 「多久发货」这种问题必须以商家写下的物流说明为准，而不是让模型
 * 从品牌故事里推一个听起来合理的时效。
 *
 * 检索重排把优先级换算成一个**小幅加成**（不是压倒性权重）：
 * 若让优先级完全压过相似度，一条恰好也提到了「发货」两个字的《品牌故事》
 * 会排到真正讲时效的《物流政策》前面 —— 那就本末倒置了。
 */
export const KNOWLEDGE_SOURCE_PRIORITY: Record<KnowledgeDocumentType, number> = {
  logistics: 1,
  after_sales: 1,
  faq: 2,
  manual: 1,
  storage: 3,
  cooking: 3,
  product: 4,
  brand: 5,
};
