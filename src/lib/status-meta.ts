import type {
  AgentStatus,
  ContentPlatform,
  ContentStatus,
  ConversationChannel,
  ConversationStatus,
  KnowledgeType,
  LiveIntent,
  LivePriority,
  ProductAnalysisStatus,
  StatusTone,
  WorkflowStatus,
} from "@/types";

interface Meta {
  label: string;
  tone: StatusTone;
}

/** Agent 运行状态 → 文案 / 色调 */
export const AGENT_STATUS_META: Record<AgentStatus, Meta> = {
  idle: { label: "空闲", tone: "neutral" },
  queued: { label: "排队中", tone: "warning" },
  running: { label: "执行中", tone: "primary" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "执行失败", tone: "danger" },
};

export const WORKFLOW_STATUS_META: Record<WorkflowStatus, Meta> = {
  idle: { label: "未启动", tone: "neutral" },
  running: { label: "运行中", tone: "primary" },
  completed: { label: "已完成", tone: "success" },
  failed: { label: "部分失败", tone: "danger" },
};

export const PRODUCT_ANALYSIS_META: Record<ProductAnalysisStatus, Meta> = {
  pending: { label: "待分析", tone: "neutral" },
  analyzing: { label: "分析中", tone: "primary" },
  analyzed: { label: "已生成 DNA", tone: "success" },
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
  storage_question: { label: "储存问题", tone: "info" },
  price_question: { label: "价格问题", tone: "warning" },
  cooking_question: { label: "烹饪问题", tone: "primary" },
  origin_question: { label: "产地问题", tone: "success" },
  logistics_question: { label: "物流问题", tone: "neutral" },
  after_sale: { label: "售后问题", tone: "danger" },
  praise: { label: "正向反馈", tone: "success" },
  other: { label: "其他", tone: "neutral" },
};

export const LIVE_PRIORITY_META: Record<LivePriority, Meta> = {
  high: { label: "高优先级", tone: "danger" },
  medium: { label: "中优先级", tone: "warning" },
  low: { label: "低优先级", tone: "neutral" },
};

export const CONVERSATION_STATUS_META: Record<ConversationStatus, Meta> = {
  bot: { label: "AI 接待", tone: "primary" },
  human: { label: "待转人工", tone: "warning" },
  closed: { label: "已结束", tone: "neutral" },
};

export const CONVERSATION_CHANNEL_LABEL: Record<ConversationChannel, string> = {
  douyin: "抖音小店",
  wechat: "微信",
  shipinhao: "视频号",
  store: "门店",
};

export const KNOWLEDGE_TYPE_LABEL: Record<KnowledgeType, string> = {
  product: "商品说明",
  faq: "常见问题",
  logistics: "物流政策",
  "after-sale": "售后政策",
  brand: "品牌资料",
  cooking: "烹饪方式",
  storage: "储存方式",
};
