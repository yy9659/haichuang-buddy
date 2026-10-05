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
  /**
   * 最近一次生成 / 修改的时间。
   * Phase 0 的演示数据不填（界面回退显示 `createdAt`）；
   * AI 生成的内容一定填 —— 「重新生成」是**覆盖**同一条内容，若不记这个时间，
   * 界面上那句「生成于 xxx」会永远停在首次生成的时间上，是在骗人。
   */
  updatedAt?: string;
  /**
   * 以下三项是 **AI 生成过的内容才有**的元信息，演示数据一律不填。
   * 界面据此判断是否显示「AI 生成」标记、模型把握度与风险提示，
   * 也据此区分「这条内容经过 Content Agent」与「这条只是演示样例」。
   */
  /** AI 契约版本号 */
  aiVersion?: string;
  /** 模型对本次产出的把握 0 ~ 1 */
  confidence?: number;
  /** 合规与事实风险提示（含 Mock 占位标记） */
  riskNotes?: string[];
  /** 内容表现数据；新生成的内容尚未发布，因此全为 0 */
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

/**
 * 内容槽位：一个「商品 × 平台 × 内容形态」的位置。
 *
 * 为什么需要这个概念：内容工厂里同一个商品在不同平台要出不同调性的内容，
 * 因此「一条内容」的唯一标识不是商品、也不是平台，而是两者的组合。
 * 数据库对这三列建唯一索引，「重新生成」即覆盖同一个槽位 ——
 * 否则连点几次「生成」就会堆出一串几乎一样的内容，把内容资产变成垃圾场。
 */
export interface ContentSlot {
  productId: string;
  platform: ContentPlatform;
  format: ContentFormat;
}

/** 海报只读取商户的商品档案，不从模型文案中猜测价格或图片。 */
export interface ProductPosterSource {
  id: string;
  name: string;
  price: number;
  unit: string;
  imageUrl: string | null;
  tags: string[];
  specification: string;
}

export interface ContentDraftCopy {
  title: string;
  hook: string;
  body: string;
  cta: string;
}

/** 今日内容计划中的一条 */
export interface ContentPlanItem {
  id: string;
  timeText: string;
  title: string;
  platform: ContentPlatform;
  status: ContentStatus;
}
