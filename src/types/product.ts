/**
 * 商品与 Product DNA 类型定义
 * 对应技术文档 6.2 / 9.2 / 9.3 / 17.1 / 17.2
 */

export type ProductAnalysisStatus =
  | "pending"
  | "analyzing"
  | "analyzed"
  | "failed";

export type ProductCategory = "海产品" | "干货" | "预制菜" | "礼盒";

export interface Product {
  id: string;
  name: string;
  description: string;
  category: ProductCategory;
  subCategory: string;
  /** 单价（元） */
  price: number;
  /** 计价单位，如 500g / 盒 */
  unit: string;
  stock: number;
  origin: string;
  specification: string;
  storageMethod: string;
  shelfLife: string;
  /** Mock 阶段不使用真实图片，统一由 ProductThumb 渲染占位视觉 */
  imageUrl: string | null;
  analysisStatus: ProductAnalysisStatus;
  updatedAt: string;
  /** 经营数据（Mock） */
  metrics: {
    views: number;
    inquiries: number;
    conversions: number;
  };
  tags: string[];
}

/** 商品经理 Agent 的结构化输出 */
export interface ProductDNA {
  productId: string;
  category: string;
  subCategory: string;
  visualFeatures: string[];
  coreFeatures: string[];
  sellingPoints: string[];
  targetUsers: string[];
  consumptionScenarios: string[];
  userPainPoints: string[];
  marketingAngles: string[];
  riskNotes: string[];
  /** AI 分析版本 */
  aiVersion: string;
  /** 置信度 0 ~ 1 */
  confidence: number;
  generatedAt: string;
  /** 是否已被用户确认 */
  approved: boolean;
}
