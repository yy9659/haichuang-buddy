/**
 * 智能客服类型定义（S5 重写）
 * 对应技术文档 6.6 智能客服 Agent 与 9.7 智能客服
 *
 * 与 S4 版本的差别：那时这里的知识库相关类型是「给演示页面看的展示模型」，
 * 现在它们必须承载真实的 RAG 链路 —— 引用要能追溯到 chunk、回答要带
 * `grounded` 判定、缺口要能聚合。因此知识库本身（文档 / 切片 / 缺口）的类型
 * 搬到了 `@/types/knowledge`，这里只保留「会话与消息」这一层。
 */

import type { KnowledgeDocumentType } from "./knowledge";

/**
 * 会话渠道。
 *
 * `simulator` 是**内置消费者模拟器**（S5 Task80）：比赛第一版不接真实平台消息，
 * 页面上「新建会话」创建的都会是这个渠道。刻意不复用 `douyin` ——
 * 那条会话并不来自抖音，把它标成抖音小店就是在数据里写一句不真的话。
 */
export type ConversationChannel =
  | "simulator"
  | "douyin"
  | "wechat"
  | "shipinhao"
  | "store";

/**
 * 会话状态。
 *
 * `human` 的语义是「AI 判断需要人工介入」而不是「已有人工接手」——
 * 后者需要一个「谁接的」的字段，本阶段不做。这里如实表达 AI 的结论。
 */
export type ConversationStatus = "bot" | "human" | "closed";

/**
 * 一条引用来源（面向商家的展示形态）。
 *
 * `documentId` / `chunkId` **必须**保留：它们是「这条回答有没有编造引用」的
 * 唯一凭据，也是调试点开原文的入口。界面默认只显示 `title`（文档名），
 * 不显示 uuid —— 但类型里不能把它们丢掉，否则一旦需要核查就无从查起。
 */
export interface KnowledgeSource {
  id: string;
  documentId: string;
  chunkId: string;
  title: string;
  type: KnowledgeDocumentType;
  snippet: string;
  /** 检索相关度 0 ~ 1 */
  score: number;
}

export interface CustomerConversation {
  id: string;
  customerName: string;
  customerLabel: string;
  channel: ConversationChannel;
  lastMessage: string;
  updatedAtText: string;
  unreadCount: number;
  status: ConversationStatus;
  tags: string[];
  /** 关联商品（消费者问的是哪件商品）；未指定为 null */
  productId: string | null;
  /** 消息条数（派生，用于列表右侧的次要信息） */
  messageCount: number;
}

export type ChatRole = "customer" | "agent" | "system";

/**
 * 一次消费者提问的长度上限。
 *
 * 为什么放在类型层而不是 AI 层或服务层：**它是三处共用的一份契约** ——
 * 输入框要在本地拦住超长（不浪费一次往返）、会话服务要在写入消息前拦住
 * （避免库里留下一条永远得不到回答的孤儿提问）、Agent 自己还要再拦一次
 * （它是 AI 的输入契约，谁都可能直接调它）。
 * 三处各写一个 300，就一定会有一天它们不一致。
 *
 * 放在 `@/types` 还解决一个更硬的约束：客户端组件必须能读到它，
 * 而 `@/services` / `@/ai` 都是服务端模块 —— 从那里 import 一个常量
 * 会把整条数据库依赖拖进浏览器包（Next 会直接构建失败）。
 */
export const MAX_CUSTOMER_QUESTION_LENGTH = 300;

/** 客服意图（与 `CustomerServiceAnswerSchema.intent` 一一对应） */
export const CUSTOMER_INTENTS = [
  "product",
  "storage",
  "cooking",
  "logistics",
  "after_sales",
  "price",
  "other",
] as const;

export type CustomerIntent = (typeof CUSTOMER_INTENTS)[number];

export function isCustomerIntent(value: unknown): value is CustomerIntent {
  return (
    typeof value === "string" &&
    (CUSTOMER_INTENTS as readonly string[]).includes(value)
  );
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  createdAtText: string;
  /** AI 回答置信度 0 ~ 1（人工消息为 undefined） */
  confidence?: number;
  /** **该回答是否完全由检索到的知识支撑**（人工消息为 undefined） */
  grounded?: boolean;
  /** 归一化意图 */
  intent?: CustomerIntent;
  /** 引用的知识来源（已通过 chunkId 合法性校验） */
  knowledgeSources?: KnowledgeSource[];
  /** 知识库缺失，建议转人工 */
  needsHuman?: boolean;
  /** 触发的知识缺口记录 id（便于从消息跳到缺口面板） */
  knowledgeGapId?: string;
  /** 检索到的知识片段条数（含被过滤掉的），用于诊断「为什么答不上来」 */
  retrievedCount?: number;
}

/**
 * 客服 Agent 对一次提问的完整结论（领域形态，由 Agent 产出、Service 消费）。
 *
 * 与 AI 契约（`CustomerServiceAnswerSchema`）的差别：契约只描述**模型**必须返回什么；
 * 这里多带检索侧的事实（命中的片段、是否达到阈值、耗时），
 * 因为「答不上来」的原因往往在检索而不在模型。
 */
export interface CustomerServiceAnswer {
  answer: string;
  intent: CustomerIntent;
  grounded: boolean;
  confidence: number;
  citations: KnowledgeSource[];
  needsHuman: boolean;
  /** 依据不足时说明缺哪类信息（面向商家的措辞） */
  knowledgeGap: string | null;
  riskNotes: string[];
  /** 检索到并进入提示词的片段数 */
  retrievedCount: number;
  /** Top 命中相似度（无命中为 0） */
  topSimilarity: number;
}
