/**
 * 品牌中心类型定义
 * 对应技术文档 6.3 品牌经理 Agent 与第 7 章 Owner Twin
 */

export interface BrandProfile {
  /** 品牌定位 */
  positioning: string;
  targetAudience: string[];
  brandValues: string[];
  brandPersonality: string[];
  slogan: string;
  brandStory: string;
  toneOfVoice: string[];
  visualKeywords: string[];
  ipConcept: string;
  /**
   * 合规与事实风险提示（绝对化用语、疑似虚构产地、命中禁用表达等）。
   * 由 Agent 扫描产出并随档案留痕；Mock 产出会在首位带占位标记。
   */
  riskNotes: string[];
  /** AI 契约版本号，提示词或 Schema 不兼容变更时递增 */
  aiVersion: string;
  /** 模型对本次产出的整体把握 0 ~ 1（**不是**完整度） */
  confidence: number;
  /** 是否已由商家确认；AI 产出恒为 false，确认前不得对外使用 */
  approved: boolean;
  updatedAt: string;
  /** 品牌完整度 0 ~ 1，由档案内容现算（见 repositories/brand-profile.ts） */
  completeness: number;
}

/** 老板数字分身 */
export interface OwnerTwin {
  displayName: string;
  avatarLabel: string;
  businessPhilosophy: string[];
  tone: string[];
  salesStyle: string;
  targetCustomers: string[];
  forbiddenExpressions: string[];
}

/** Demo 商家信息 */
export interface BusinessProfile {
  id: string;
  name: string;
  shortName: string;
  description?: string;
  owner: string;
  location: string;
  mainCategory: string;
  storeCount: number;
  channels: string[];
}
