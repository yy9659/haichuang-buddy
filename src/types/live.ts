/**
 * AI 直播间类型定义（S6 · 任务书第六 / 七 / 十七~二十节）
 *
 * 本轮把 `/live` 从「演示页面」升级为**真正可交互的 AI 直播导演**：
 * 评论经真实 DashScope 理解、必要时走 RAG 检索、产出面向**主播**的建议与话术。
 *
 * 命名的两条原则（任务书第六节）：
 * 1. **沿用项目既有命名**，不为任务书里的另一个叫法重建一套模型。
 *    因此 `LiveIntent` 是在原有取值上**扩展**（新增 purchase_intent / objection /
 *    comparison / spam），既有值（storage_question / price_question …）原样保留。
 * 2. 直播是**面向主播**的：`LiveSuggestion` 描述的是「评论是什么、该不该回、
 *    为什么、主播怎么回、有什么风险、下一步做什么」，而不是给消费者的一句话。
 *    这与 Customer Service Agent 的 `CustomerServiceAnswer` 是**两套职责**，
 *    刻意不合并。
 */

import type { KnowledgeSource } from "./conversation";

/** 直播场次状态。S6 收敛为三态（去掉旧版未被使用的 `paused`） */
export type LiveSessionStatus = "idle" | "live" | "ended";

/**
 * 评论意图。
 *
 * 前 8 个是 Phase 0 起的既有取值（保留，避免破坏 status-meta 与历史数据），
 * 后 5 个是 S6 为直播场景补齐的：购买意图 / 异议 / 比较 / 互动 / 垃圾。
 * 运行时清单 `LIVE_INTENTS` 与类型同源 —— 界面渲染、Zod 校验都读同一份。
 */
export const LIVE_INTENTS = [
  "product_question",
  "storage_question",
  "cooking_question",
  "logistics_question",
  "after_sale",
  "price_question",
  "origin_question",
  "purchase_intent",
  "objection",
  "comparison",
  "praise",
  "spam",
  "other",
] as const;

export type LiveIntent = (typeof LIVE_INTENTS)[number];

export function isLiveIntent(value: unknown): value is LiveIntent {
  return (
    typeof value === "string" && (LIVE_INTENTS as readonly string[]).includes(value)
  );
}

/** 优先级：程序可先按意图给基线，模型再微调（任务书第二十七节） */
export const LIVE_PRIORITIES = ["high", "medium", "low"] as const;
export type LivePriority = (typeof LIVE_PRIORITIES)[number];

export function isLivePriority(value: unknown): value is LivePriority {
  return (
    typeof value === "string" && (LIVE_PRIORITIES as readonly string[]).includes(value)
  );
}

/**
 * 回应方式。
 *
 * 与 `shouldRespond` 的区别：`shouldRespond` 回答「要不要回」，
 * `responseMode` 回答「**怎么回**」——立刻回、稍后带过、转客服确认、直接忽略。
 * 两者并存是刻意的：一个强购买意图可能 `shouldRespond=true`，
 * 但话术应当「稍后重点讲」而不是打断当下节奏。
 */
export const LIVE_RESPONSE_MODES = [
  "answer_now",
  "mention_later",
  "send_to_customer_service",
  "ignore",
] as const;
export type LiveResponseMode = (typeof LIVE_RESPONSE_MODES)[number];

export function isLiveResponseMode(value: unknown): value is LiveResponseMode {
  return (
    typeof value === "string" &&
    (LIVE_RESPONSE_MODES as readonly string[]).includes(value)
  );
}

/** 推荐动作：主播接下来具体做什么 */
export const LIVE_RECOMMENDED_ACTIONS = [
  "explain_product",
  "explain_storage",
  "explain_cooking",
  "clarify_logistics",
  "handle_objection",
  "reinforce_selling_point",
  "guide_to_customer_service",
  "engage_audience",
  "ignore",
] as const;
export type LiveRecommendedAction = (typeof LIVE_RECOMMENDED_ACTIONS)[number];

export function isLiveRecommendedAction(
  value: unknown,
): value is LiveRecommendedAction {
  return (
    typeof value === "string" &&
    (LIVE_RECOMMENDED_ACTIONS as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* 直播场次                                                            */
/* ------------------------------------------------------------------ */

export interface LiveSession {
  id: string;
  title: string;
  productId: string;
  productName: string;
  status: LiveSessionStatus;
  /** 开播时间（展示字符串） */
  startedAt: string;
  /** 结束时间；未结束为 null */
  endedAt: string | null;
  /** 已直播时长展示文案（进行中时实时计算） */
  durationText: string;
  /** 本场累计评论数（含种子历史评论） */
  commentsCount: number;
  /** 已经被 AI 成功处理过的评论数 */
  aiHandledCount: number;
  /** 主播口播文字；浏览器语音转写或人工补写，不保存原始音视频。 */
  hostTranscript?: string;
  /** 结束彩排后生成的文字依据评分。 */
  rehearsalReport?: LiveRehearsalReport | null;
}

export interface LiveRehearsalReport {
  score: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  nextPractice: string;
  /** 评分只依据文本，不声称识别了镜头表现、声音或真实成交。 */
  basis: "text_only";
  generatedAt: string;
  providerId: string;
  isMock: boolean;
}

/**
 * 直播间**模拟**指标（§42）。
 *
 * 在线人数 / 点赞 / 涨粉没有真实来源（未接直播平台），必须与
 * `LiveRealMetrics` 明确区分：这里的数字一律标「模拟数据」，
 * 绝不与真实可计算的指标混在同一处。
 */
export interface LiveStats {
  onlineCount: number;
  peakOnlineCount: number;
  likes: number;
  comments: number;
  questions: number;
  newFollowers: number;
  /** 直播互动率，由程序计算（模拟指标之间的比值） */
  engagementRate: number;
}

/** 直播间**真实**可计算的指标（§42）：全部由本场评论实时算出 */
export interface LiveRealMetrics {
  commentCount: number;
  aiHandledCount: number;
  highPriorityCount: number;
  groundedCount: number;
}

/* ------------------------------------------------------------------ */
/* 评论                                                                */
/* ------------------------------------------------------------------ */

/**
 * 单条评论的长度上限。
 *
 * 放在 `types/live.ts` 而不是 AI 层：客户端组件（输入框）也要用同一个上限做校验，
 * 而 Client 不允许 import `@/ai/*`（会把模型层打进浏览器 bundle）。
 * 与 `MAX_CUSTOMER_QUESTION_LENGTH` 放在 `types/conversation.ts` 是同一个理由。
 */
export const MAX_LIVE_COMMENT_LENGTH = 500;
export const MAX_REHEARSAL_QUESTIONS = 5;
export const MAX_HOST_TRANSCRIPT_LENGTH = 5000;
export const AI_REHEARSAL_AUTHOR = "AI 模拟观众";

export interface LiveComment {
  id: string;
  sessionId: string;
  /** 观众昵称 */
  authorName: string;
  content: string;
  /** AI 分析出的意图；**未被分析时为 null**（历史种子评论即为 null） */
  intent: LiveIntent | null;
  /** AI 判定的优先级；未分析为 null */
  priority: LivePriority | null;
  /** 是否已被 AI 直播导演处理（成功产出建议） */
  handled: boolean;
  createdAtText: string;
}

/* ------------------------------------------------------------------ */
/* AI 直播导演结论                                                     */
/* ------------------------------------------------------------------ */

/**
 * AI 直播导演对**单条评论**的结论（§20）。
 *
 * `failureMessage` 非 null 表示这一条**AI 处理失败**：评论仍然保留在评论流里，
 * 面板如实显示「AI 导演暂时不可用」，而不是删掉评论或伪造一条建议（§34）。
 */
export interface LiveSuggestion {
  id: string;
  commentId: string;
  /** 评论原文（面板直接展示，省得再回查） */
  commentContent: string;
  intent: LiveIntent;
  priority: LivePriority;
  shouldRespond: boolean;
  responseMode: LiveResponseMode;
  /** 给主播的实时建议 */
  hostSuggestion: string;
  /** 建议主播口播的话术 */
  suggestedReply: string;
  /** 营销切入点（仅营销型问题有；事实型问题为 null） */
  sellingAngle: string | null;
  grounded: boolean;
  /** 引用快照；无依据时为空数组 */
  citations: KnowledgeSource[];
  recommendedAction: LiveRecommendedAction;
  riskNotes: string[];
  confidence: number;
  /** 本次 AI 处理耗时（毫秒） */
  durationMs: number;
  createdAtText: string;
  /** AI 处理失败时的说明；成功为 null */
  failureMessage: string | null;
}

/* ------------------------------------------------------------------ */
/* 热点聚合（§28 / §29）                                              */
/* ------------------------------------------------------------------ */

/** 单个意图的热点统计。`share` 由程序计算，绝不让模型算百分比 */
export interface LiveHotTopic {
  intent: LiveIntent;
  count: number;
  /** 占比 0~1（count / 已分析评论总数） */
  share: number;
  /** 最近几条示例（最多 3 条评论原文） */
  recentExamples: string[];
}

/* ------------------------------------------------------------------ */
/* 提词器（§25：来源是真实商品 / DNA / 品牌，绝非 AI 胡编）            */
/* ------------------------------------------------------------------ */

/**
 * 主播提词器视图。
 *
 * 与旧版 `TeleprompterSegment` 的根本差别：**它不是一段写死的脚本文案**，
 * 而是三块真实数据的组合 —— 当前商品（含 Product DNA 卖点）、品牌语气
 * （Brand Profile）、以及最新一条高优先级 AI 建议。任一块缺失都如实留空。
 */
export interface LiveTeleprompterView {
  productName: string;
  productId: string;
  /** 商品核心卖点（来自 Product DNA；无 DNA 时为空数组） */
  sellingPoints: string[];
  /** 商品未完成 AI 分析时的提示；已完成或有 DNA 时为 null */
  dnaNotice: string | null;
  /** 品牌语气关键词（来自 Brand Profile；无品牌档案时为空数组） */
  brandTone: string[];
  /** 品牌档案缺失提示；存在时为 null */
  brandNotice: string | null;
  /** 最新一条高优先级建议；没有时为空 */
  latestSuggestion: LiveSuggestion | null;
}
