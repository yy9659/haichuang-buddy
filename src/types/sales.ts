/** 商户手工录入或 CSV 导入的销售明细；金额以分存储，避免浮点累计误差。 */
export interface SaleRecord {
  id: string;
  businessId: string;
  recordNo: string;
  saleDate: string;
  productName: string;
  channel: string;
  quantity: number;
  revenueCents: number;
  costCents: number | null;
  isDemo: boolean;
  createdAt: string;
}

export type NewSaleRecord = Omit<SaleRecord, "id" | "createdAt">;

export interface SalesSummary {
  isDemo: boolean;
  count: number;
  revenueCents: number;
  quantity: number;
  /** 只有每一行都填写成本，才显示整批毛利。 */
  grossProfitCents: number | null;
  missingCostCount: number;
  recentSevenDaysCents: number;
  previousSevenDaysCents: number;
  byProduct: { name: string; revenueCents: number; quantity: number }[];
  byChannel: { name: string; revenueCents: number }[];
  daily: { date: string; revenueCents: number }[];
}

export type SalesReviewMode = "real" | "demo";

export interface SalesReviewFact {
  id: string;
  label: string;
  display: string;
}

/** 与 AI 建议一起保存的销售依据；金额与排名均由程序计算。 */
export interface SalesReviewSnapshot {
  mode: SalesReviewMode;
  fingerprint: string;
  asOf: string;
  dateRange: { start: string; end: string } | null;
  summary: SalesSummary;
  facts: SalesReviewFact[];
  products: { name: string; productId: string | null; revenueCents: number; grossProfitCents: number | null; primaryChannel?: string }[];
  recentRecordedDays: number;
  previousRecordedDays: number;
  futureRecordCount: number;
}

export interface SalesReviewInsight {
  title: string;
  explanation: string;
  evidenceIds: string[];
}

export interface SalesReviewAction extends SalesReviewInsight {
  priority: number;
  steps: string;
  destination: "sales" | "content" | "products" | "customer_service";
  productName: string | null;
}

export interface SalesReview {
  summary: string;
  opportunities: SalesReviewInsight[];
  watchouts: SalesReviewInsight[];
  actions: SalesReviewAction[];
  /** 服务端写入，模型不能决定来源标识。 */
  isMock?: boolean;
  providerId?: string;
}
