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
  updatedAt: string;
  /** 品牌完整度 0 ~ 1 */
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
  owner: string;
  location: string;
  mainCategory: string;
  storeCount: number;
  channels: string[];
}
