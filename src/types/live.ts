/**
 * AI 直播间类型定义
 * 对应技术文档 6.5 AI直播导演 Agent 与 9.6 AI直播间
 */

export type LiveSessionStatus = "idle" | "live" | "paused" | "ended";

/** 评论意图分类 */
export type LiveIntent =
  | "storage_question"
  | "price_question"
  | "cooking_question"
  | "origin_question"
  | "logistics_question"
  | "after_sale"
  | "praise"
  | "other";

export type LivePriority = "high" | "medium" | "low";

export interface LiveSession {
  id: string;
  title: string;
  productId: string;
  productName: string;
  status: LiveSessionStatus;
  startedAt: string;
  /** 已直播时长展示文案 */
  durationText: string;
}

export interface LiveStats {
  onlineCount: number;
  peakOnlineCount: number;
  likes: number;
  comments: number;
  questions: number;
  newFollowers: number;
  /** 直播互动率，由程序计算 */
  engagementRate: number;
}

/** 直播间实时评论（Mock 数据） */
export interface LiveComment {
  id: string;
  user: string;
  content: string;
  createdAtText: string;
  intent: LiveIntent;
  priority: LivePriority;
  /** 是否已被 AI 直播导演处理 */
  handled: boolean;
}

/** AI 直播导演的结构化输出 */
export interface LiveSuggestion {
  id: string;
  commentId: string;
  intent: LiveIntent;
  priority: LivePriority;
  /** 问题摘要 */
  question: string;
  /** 建议回答 */
  answer: string;
  /** 给主播的实时建议 */
  hostSuggestion: string;
  recommendedAction: string;
  knowledgeSource: string[];
  createdAtText: string;
}

/** 主播提词器片段 */
export interface TeleprompterSegment {
  id: string;
  type: "opening" | "selling-point" | "objection" | "cta";
  title: string;
  content: string;
  durationText: string;
  status: "done" | "current" | "upcoming";
}
