/**
 * 内容工厂类型定义
 * 对应技术文档 6.4 内容运营 Agent 与 9.5 AI内容工厂
 */

export type ContentPlatform =
  | "douyin"
  | "xiaohongshu"
  | "wechat"
  | "shipinhao"
  | "detail"
  | "ads";

export type ContentFormat =
  | "short-video"
  | "article"
  | "poster-copy"
  | "voiceover";

export type ContentStatus =
  | "draft"
  | "reviewing"
  | "approved"
  | "published"
  | "failed";

/** 内容运营 Agent 的统一结构化输出 */
export interface ContentItem {
  id: string;
  productId: string;
  productName: string;
  title: string;
  hook: string;
  body: string;
  cta: string;
  hashtags: string[];
  visualSuggestions: string[];
  shotList: string[];
  voiceover: string;
  platform: ContentPlatform;
  format: ContentFormat;
  status: ContentStatus;
  createdAt: string;
  /** 内容表现数据（Mock） */
  metrics: ContentMetrics;
}

export interface ContentMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  /** 互动率，由程序计算：(likes + comments + shares) / views */
  engagementRate: number;
}

/** 内容生成输入（表单） */
export interface ContentBrief {
  productId: string;
  platform: ContentPlatform;
  format: ContentFormat;
  goal: string;
  audience: string;
  tone: string;
  length: string;
}

/** 今日内容计划中的一条 */
export interface ContentPlanItem {
  id: string;
  timeText: string;
  title: string;
  platform: ContentPlatform;
  status: ContentStatus;
}
