/**
 * Mock AI Provider —— 本地确定性实现
 *
 * 存在的意义：让 Agent / 提示词 / 结构化输出链路**在没有模型凭证时也能被完整执行与测试**，
 * 这样接真实通义千问时，只需替换 Provider，Agent 代码一行都不用动。
 *
 * 重要约定（与项目「不伪造 AI 结果」的一贯做法一致）：
 * - 本 Provider **不联网、不调用任何外部模型**，输出由输入资料确定性推导。
 * - 产出里会带一条 `MOCK_OUTPUT_MARKER` 风险提示，明确标注「这是占位数据」。
 *   真实 Provider 落地后该标记自然消失，不会被误当成真实分析结果落库。
 * - 提供**故障注入场景**，用于验证「脏 JSON → 自动纠错」与「连续失败 → 明确报错」两条路径。
 *
 * 扩展方式（S3-1 起）：本 Provider 保持**通用**——它不认识任何具体业务 Schema，
 * 只按提示词里的结构化上下文块判断「这次要产出哪一种结构化结果」，
 * 各自生成一份**候选值**，再用调用方传入的 `schema.safeParse` 判定是否可用。
 * 新增 Agent 时只需在此登记一个「上下文块标记 → 候选构造器」，
 * 不需要改 Agent 或 Provider 接口。
 *
 * 计划层的故障注入（S4-1）：`invalid-agent` / `circular-dependency` 两个场景会
 * **只在第一次**结构化调用时把计划改坏 —— 第二次调用（模型已看到纠错提示）产出合法计划，
 * 这样才真正走通「回喂 → 修好」的路径。若改成「每次都坏」，就只能测出最终失败那一条分支。
 */

import {
  ANALYTICS_CONTEXT_BLOCK_START,
  parseAnalyticsContextBlock,
  buildDemoSalesReview,
  type AnalyticsPromptContext,
} from "@/ai/prompts/analytics-agent";
import {
  BRAND_CONTEXT_BLOCK_START,
  parseBrandContextBlock,
  type BrandContext,
} from "@/ai/prompts/brand-agent";
import {
  BUSINESS_CONTEXT_BLOCK_START,
  parseBusinessContextBlock,
  type BusinessContext,
  type BusinessContextChannel,
} from "@/ai/prompts/business-brain";
import {
  CONTENT_CONTEXT_BLOCK_START,
  parseContentContextBlock,
  type ContentContext,
} from "@/ai/prompts/content-agent";
import {
  INSUFFICIENT_GROUNDING_ANSWER,
  KNOWLEDGE_CONTEXT_BLOCK_START,
  parseKnowledgeContextBlock,
  type KnowledgeContext,
} from "@/ai/prompts/customer-service-agent";
import {
  LIVE_CONTEXT_BLOCK_START,
  isFactualLiveIntent,
  parseLiveContextBlock,
  type LiveContext,
} from "@/ai/prompts/live-agent";
import { MAX_PLAN_TASKS } from "@/ai/schemas/business-plan";
import { buildMockPosterDesign, POSTER_CONTEXT_START } from "@/ai/prompts/poster-design";
import {
  CONTEXT_BLOCK_START,
  parseProductContextBlock,
  type ProductContext,
} from "@/ai/prompts/product-agent";
import { AppError } from "@/lib/result";
import { EMBEDDING_DIMENSIONS, normalizeVector } from "@/lib/embedding";
/**
 * 分词器**不在本文件里**。
 *
 * 它同时被 RAG 检索层使用（`lexicalCoverage` 的稀疏侧信号），若留在这里，
 * 检索层就得 import Provider 的私有实现 —— 一旦换成真实 Provider，
 * 检索层会跟着一起塌。因此它住在 `src/lib/text-tokens.ts`。
 */
import { tokenizeForEmbedding } from "@/lib/text-tokens";
import {
  CONTENT_FORMAT_LABEL,
  CONTENT_PLATFORM_LABEL,
} from "@/lib/status-meta";
import type { ContentFormat, ContentPlatform, LiveIntent } from "@/types";

import type {
  AIProvider,
  AnalyzeImageInput,
  EmbedInput,
  GenerateObjectInput,
  GenerateTextInput,
  StreamTextInput,
} from "./types";

/** 占位数据标记：出现在 riskNotes 首位，提醒任何下游不要把它当真实分析 */
export const MOCK_OUTPUT_MARKER =
  "【Mock】占位数据，未经真实模型分析，请勿直接对外使用";

/** 故障注入场景 */
export const MOCK_AI_SCENARIOS = [
  /** 正常：始终返回合法结构化输出 */
  "ok",
  /** 第一次返回脏输出（带围栏 + 缺字段），第二次返回合法输出 —— 验证纠错重试 */
  "messy-then-ok",
  /** 始终返回脏输出 —— 验证用尽重试后给出明确的 SCHEMA_INVALID */
  "always-invalid",
  /** 调用超时 */
  "timeout",
  /** 服务不可用 */
  "unavailable",
  /**
   * 第一次的计划里写进一个白名单外的 Agent，第二次恢复正常。
   * 越界值会在**契约层**被白名单拦住（Zod enum），因此它验证的是第一层纠错。
   */
  "invalid-agent",
  /**
   * 第一次的计划里让前两个任务互相依赖，第二次恢复正常。
   * 循环依赖形状合法，Zod 看不见，必须由 `plan-validator` 报出来 ——
   * 因此它验证的是第二层（语义）纠错。
   */
  "circular-dependency",
  /**
   * 第一次的客服回答里把 citation 的 chunkId 换成**检索结果里不存在**的假 id，
   * 第二次恢复正常。用于验证「伪造引用必须被拒绝」（任务书第四十节 Case ③）。
   *
   * 为什么这个场景必须存在：伪造引用是这类系统里**最难靠人工发现**的缺陷 ——
   * 界面上看起来一切正常（有回答、有「依据 1 条」），点开才发现指向的是一段
   * 不存在的内容。没有故障注入，这条主链上的校验就永远没被真正执行过。
   */
  "fabricated-citation",
] as const;

export type MockAiScenario = (typeof MOCK_AI_SCENARIOS)[number];

export interface MockAIProviderOptions {
  scenario?: MockAiScenario;
  /** 覆盖 Provider 标识，便于多 Provider 并存的日志区分 */
  id?: string;
}

/** 脏输出样本：可被提取出 JSON，但缺少大量必要键 → 必定触发纠错重试 */
const MESSY_STRUCTURED_OUTPUT = [
  "好的，我根据商品资料先给出一个初稿：",
  "```json",
  '{ "category": "海产品", "sellingPoints": "个头大、够新鲜" }',
  "```",
  "如果还需要补充，请告诉我。",
].join("\n");

/** 从商品名推断一个兜底子类目 */
function inferSubcategory(name: string): string {
  const stripped = name.replace(/^(连江|鲜活|手工|头水|黄岐)+/g, "").trim();
  return stripped || "海产";
}

/**
 * 依据上下文构造 Product DNA 候选值（确定性）。
 * 候选人可能不被目标 Schema 接受 —— 由调用方用 `schema.safeParse` 判定，
 * 这正是 Mock Provider 保持「通用」的方式：它不认识具体 Schema，只提供候选。
 */
function buildProductDnaCandidate(context: ProductContext | null): Record<string, unknown> {
  const name = context?.name?.trim() || "示例商品";
  const description = context?.description?.trim() ?? "";
  const category = context?.category?.trim() || "海产品";
  const subcategory = context?.subCategory?.trim() || inferSubcategory(name);
  const tags = (context?.tags ?? []).filter((tag) => tag.trim().length > 0);

  return {
    category,
    subcategory,
    visualFeatures: [
      `${name}主体完整、形态饱满，色泽自然`,
      "拍摄以浅色背景为主，主体位于画面中心",
      "包装简洁，可直接用作电商主图",
    ],
    coreFeatures: [
      `品类归属：${category} · ${subcategory}`,
      context?.origin ? `产地：${context.origin}` : "产地信息待补充",
      context?.specification ? `规格：${context.specification}` : "规格信息待补充",
      ...(description ? [`资料要点：${description.slice(0, 40)}`] : []),
    ],
    sellingPoints: [
      ...(tags.length > 0
        ? tags.slice(0, 3).map((tag) => `突出「${tag}」这一差异点`)
        : ["产地直供，减少中间环节", "冷链配送，锁住新鲜度"]),
      "适合家庭日常烹饪与节庆餐桌",
    ],
    targetUsers: [
      "注重食材新鲜度的家庭主厨",
      "为节庆与送礼挑选海产的消费者",
      "偏好产地直发的品质型买家",
    ],
    scenarios: ["家庭日常三餐", "节庆聚餐与宴客", "节日礼赠与商务馈赠"],
    painPoints: [
      "担心海产不新鲜、到手有异味",
      "怕规格虚标、实际分量不足",
      "不清楚如何处理和烹饪",
    ],
    marketingAngles: [
      "产地溯源：从连江海域到餐桌",
      "烹饪教程：3 分钟做出一道家常海鲜",
      "节庆礼盒场景种草",
    ],
    riskNotes: [MOCK_OUTPUT_MARKER, "避免使用「最」「第一」等绝对化用语"],
    confidence: 0.35,
  };
}

/** 视觉分析提示词里提取商品名（`商品「X」的图片`） */
const VISION_NAME_PATTERN = /商品[「"]([^」"]+)[」"]/;

/* ------------------------------------------------------------------ */
/* Brand Profile 候选（S3-1）                                          */
/* ------------------------------------------------------------------ */

/** 在列表里取前 n 条非空字符串 */
function take(list: readonly string[] | undefined, count: number): string[] {
  return (list ?? []).filter((item) => item.trim().length > 0).slice(0, count);
}

/**
 * 依据品牌上下文构造 Brand Profile 候选值（确定性）。
 *
 * 与 Product DNA 候选同样的原则：只从输入里**真实存在**的信息拼装，
 * 不编造产地、年份、认证等事实 —— Mock 也必须守住这条纪律，
 * 否则「用 Mock 跑通流程」会变成「用假事实跑通流程」。
 */
function buildBrandProfileCandidate(
  context: BrandContext | null,
): Record<string, unknown> {
  const businessName = context?.business.name?.trim() || "示例商家";
  const shortName = context?.business.shortName?.trim() || businessName;
  const location = context?.business.location?.trim() || "";
  const businessDescription = context?.business.description?.trim() || "";
  const mainCategory = context?.business.mainCategory?.trim() || "商品";
  const ownerName = context?.ownerTwin?.displayName?.trim() || "";

  const products = (context?.products ?? []).filter((product) => product.name.trim());
  const withDna = products.filter((product) => product.dna !== null);

  /** 汇总所有商品的 DNA，作为品牌推导的公共语料 */
  const merged = {
    coreFeatures: withDna.flatMap((product) => take(product.dna?.coreFeatures, 3)),
    sellingPoints: withDna.flatMap((product) => take(product.dna?.sellingPoints, 3)),
    targetUsers: withDna.flatMap((product) => take(product.dna?.targetUsers, 3)),
    scenarios: withDna.flatMap((product) =>
      take(product.dna?.consumptionScenarios, 2),
    ),
    marketingAngles: withDna.flatMap((product) =>
      take(product.dna?.marketingAngles, 2),
    ),
    visualFeatures: withDna.flatMap((product) =>
      take(product.dna?.visualFeatures, 2),
    ),
  };

  /**
   * 产地标签只取**主依据商品**的产地，取不到才退回商家所在地。
   *
   * ⚠️ 不要把全部商品的产地拼在一起：那会产出
   * 「福建连江 · 黄岐半岛、福建连江 · 马鼻镇…直发」这种既超长又不成句的定位，
   * 消费者看到的是「把资料原样倒出来」，而不是一句品牌语言。
   */
  const primaryProduct = products.find((product) => product.dna !== null) ?? products[0];
  const primaryOrigin = primaryProduct?.origin?.trim() ?? "";
  const originText = primaryOrigin || location;
  /** 用于 slogan：取「·」之后的具体地名（如「福建连江 · 黄岐半岛」→「黄岐半岛」） */
  const originShort = originText.includes("·")
    ? (originText.split("·").pop() ?? "").trim() || originText
    : originText;

  const ownerPhilosophy = take(context?.ownerTwin?.businessPhilosophy, 4);
  const ownerTone = take(context?.ownerTwin?.tone, 4);
  const ownerCustomers = take(context?.ownerTwin?.targetCustomers, 4);

  const productSummary = products
    .map((product) => product.name.trim())
    .slice(0, 4)
    .join("、");

  const brandValues = Array.from(
    new Set(
      ownerPhilosophy.length > 0
        ? ownerPhilosophy
        : ["资料清楚", "表达克制"],
    ),
  ).slice(0, 5);

  const targetAudience = Array.from(
    new Set(
      ownerCustomers.length > 0
        ? ownerCustomers
        : merged.targetUsers.length > 0
          ? merged.targetUsers
          : ["希望了解商品信息的顾客"],
    ),
  ).slice(0, 6);

  const brandKeywords = Array.from(
    new Set(
      [shortName, mainCategory, ...take(merged.coreFeatures, 2)]
        .map((item) => item.replace(/\s+/g, " ").trim())
        .filter((item) => item.length > 0 && item.length <= 40),
    ),
  ).slice(0, 6);

  const tone = Array.from(
    new Set(
      ownerTone.length > 0 ? ownerTone : ["自然", "不夸张"],
    ),
  ).slice(0, 5);

  const visualDirection = Array.from(
    new Set(
      merged.visualFeatures.length > 0
        ? take(merged.visualFeatures, 3)
        : ["展示实际商品", "清晰标注规格", "真实使用场景"],
    ),
  ).slice(0, 6);

  const storyParts = [
    `${businessName}${location ? `位于${location}` : ""}，主营${mainCategory}`,
    businessDescription,
    ownerName ? `由${ownerName}对外介绍商品` : "",
    productSummary ? `主营${productSummary}` : "",
    ownerPhilosophy.length > 0
      ? `经营理念包括「${ownerPhilosophy.join("、")}」`
      : "",
    merged.sellingPoints.length > 0
      ? `可介绍的商品特点有「${take(merged.sellingPoints, 2).join("、")}」`
      : "",
  ].filter(Boolean);

  return {
    brandPositioning: `${originShort ? `${originShort} · ` : ""}${shortName}为${targetAudience[0] ?? "顾客"}提供${mainCategory}选购信息`.slice(0, 120),
    brandStory: `${storyParts.join("，")}。介绍时以已核实的商品资料为准，未填写的经历、资质与履约承诺不对外宣称。`.slice(
      0,
      800,
    ),
    slogan: `${shortName}，把商品说明白。`.slice(0, 60),
    ipConcept: `以${ownerName || shortName}为表达主体，围绕已核实的商品资料、选购方法和实际使用场景制作内容。`.slice(
      0,
      300,
    ),
    brandValues,
    targetAudience,
    brandKeywords:
      brandKeywords.length > 0 ? brandKeywords : ["信息清楚", "表达克制"],
    tone,
    visualDirection,
    // Mock 依据有限，置信度刻意压低，与 Product DNA 的处理保持一致
    confidence: 0.35,
    riskNotes: [MOCK_OUTPUT_MARKER],
  };
}

/* ------------------------------------------------------------------ */
/* Content Asset 候选（S3-2）                                          */
/* ------------------------------------------------------------------ */

/**
 * 各平台的行动引导话术。
 * 只是为了让 Mock 在不同平台上产出**可区分**的结果，不代表真实平台规则 ——
 * 真实调性要求写在提示词里（`prompts/content-agent.ts` 的 PLATFORM_GUIDES）。
 */
const MOCK_PLATFORM_CTA: Readonly<Record<string, string>> = {
  douyin: "点击下方商品，今晚就能安排。",
  xiaohongshu: "想看更多做法，评论区扣「1」。",
  wechat: "想要的直接私我。",
  shipinhao: "有需要的来找我聊。",
  detail: "点击立即购买，产地直发。",
  ads: "现在下单，产地直发。",
};

/**
 * 依据内容上下文构造 Content Asset 候选值（确定性）。
 *
 * 与 Product DNA / Brand Profile 候选同样的原则：只从输入里**真实存在**的信息拼装，
 * 不编造产地、认证、包邮、销量等事实 —— Mock 也必须守住这条纪律，
 * 否则「用 Mock 跑通流程」会变成「用假事实跑通流程」。
 *
 * 另一条硬要求：**每个字段都按 Schema 的约束裁剪**（标题 60 字、正文 1200 字…）。
 * Mock 产出如果过不了自己的 Schema，就会走进「模型输出不合规 → 自动纠错」那条路，
 * 让测试无法区分「Mock 数据有问题」和「纠错通道有问题」。
 */
function buildContentCandidate(context: ContentContext | null): Record<string, unknown> {
  const product = context?.product;
  const name = product?.name?.trim() || "示例商品";
  const platform = context?.request.platform ?? "douyin";
  const type = context?.request.format ?? "short-video";
  const angle = context?.request.angle ?? "selling-point";

  const origin = product?.origin?.trim() ?? "";
  /** 取「·」之后的具体地名（如「福建连江 · 黄岐半岛」→「黄岐半岛」） */
  const originShort = origin.includes("·")
    ? (origin.split("·").pop() ?? "").trim() || origin
    : origin;

  const category = product?.category?.trim() || "海产品";
  const spec = product?.specification?.trim() ?? "";
  const priceText = product?.priceText?.trim() ?? "";
  const storage = product?.storageMethod?.trim() ?? "";
  const brand = context?.brand ?? null;
  const slogan = brand?.slogan?.trim() ?? "";
  const dna = product?.dna ?? null;

  const sellingPoints = take(dna?.sellingPoints, 3);
  const coreFeatures = take(dna?.coreFeatures, 3);
  const scenarios = take(dna?.consumptionScenarios, 2);
  const visualFeatures = take(dna?.visualFeatures, 2);

  const mainSelling = sellingPoints[0] ?? `查看${name}的商品资料`;
  const angleTitle = {
    "selling-point": `${name}有哪些特点`,
    cooking: `${name}怎么准备更方便`,
    trust: `买${name}前先看这些信息`,
    daily: `今天介绍一下${name}`,
  }[angle];
  const angleHook = {
    "selling-point": `${name}值得了解的地方是什么？${mainSelling}。`,
    cooking: `想试试${name}？先看看这份商品资料，再决定怎么做。`,
    trust: `买${name}前，先把已知的商品信息看清楚。`,
    daily: `今天和大家聊聊${name}，从商品资料说起。`,
  }[angle];

  const clip = (text: string, max: number): string => text.slice(0, max);
  const clipList = (items: readonly string[], max: number): string[] =>
    items.map((item) => clip(item, max)).filter((item) => item.length > 0);

  const facts = [
    origin ? `产地：${origin}` : "",
    spec ? `规格：${spec}` : "",
    priceText ? `价格：${priceText}` : "",
    storage ? `储存方式：${storage}` : "",
  ].filter((line) => line.length > 0);

  const bodyLines = [
    `${angleHook}${spec ? `规格 ${spec}。` : ""}`,
    "",
    ...facts.map((fact) => `· ${fact}`),
    "",
    sellingPoints.length > 0 ? `值得说的几点：${sellingPoints.join("；")}` : "",
    coreFeatures.length > 0 ? `商品资料要点：${coreFeatures.join("；")}` : "",
    scenarios.length > 0 ? `适合场景：${scenarios.join("、")}。` : "",
    slogan ? `我们坚持的一句话：${slogan}。` : "",
    "",
    "请按商品与品牌资料核对以上内容，具体以实际到货为准。",
  ];

  /** 去掉「取不到内容」而留下的空行，但保留段落之间的空行（它们是有意的分隔） */
  const body = bodyLines
    .filter((line, index) => {
      if (line.length > 0) {
        return true;
      }
      const prev = bodyLines[index - 1];
      const next = bodyLines[index + 1];
      return Boolean(prev && next && prev.length > 0 && next.length > 0);
    })
    .join("\n");

  /** 标签统一带 `#`，并去掉与商品名无关的标点，避免出现 `#连江 鲜活 鲍鱼` 这种带空格的标签 */
  const tags = Array.from(
    new Set(
      [originShort, category, name.replace(/\s+/g, "")]
        .filter((item) => item.length > 0)
        .map((item) => `#${item}`.slice(0, 24)),
    ),
  ).slice(0, 8);

  return {
    platform,
    type,
    title: clip(angleTitle, 60),
    hook: clip(angleHook, 120),
    body: clip(body, 1200),
    scenes: clipList(
      [
        originShort ? `0-2s ${originShort}产地实景，交代来源` : "0-2s 展示商品外观与包装",
        `2-6s ${name}特写，展示${spec || "外观与规格"}`,
        "6-12s 简单做法演示（清洗、下锅）",
        "12-18s 出锅与试吃反应",
      ],
      60,
    ),
    tags,
    callToAction: clip(MOCK_PLATFORM_CTA[platform] ?? "点击下方商品了解更多。", 80),
    visualSuggestions: clipList(
      [
        ...visualFeatures,
        "浅色背景、主体居中，突出新鲜质感",
        "竖屏拍摄，画面下方留出字幕安全区",
      ],
      60,
    ),
    voiceover: clip(
      `${[
        originShort ? `${originShort}的${name}` : name,
        spec ? `规格 ${spec}` : "",
        priceText ? `现在${priceText}` : "",
        mainSelling,
        slogan,
      ]
        .filter((part) => part.length > 0)
        .join("，")}。`,
      300,
    ),
    riskNotes: [MOCK_OUTPUT_MARKER, "避免使用「最」「第一」等绝对化用语"],
    // Mock 依据有限，置信度刻意压低，与其它 Agent 的处理保持一致
    confidence: 0.35,
  };
}

/* ------------------------------------------------------------------ */
/* Business Plan 候选（S4-1）                                          */
/* ------------------------------------------------------------------ */

/**
 * Mock 计划的任务数上限。六 Agent 全链路本身至少需要六步，额外渠道会继续
 * 占用任务位，因此与契约共用上限；下面的预算逻辑始终为客服、直播、分析预留三步。
 */
const MAX_MOCK_PLAN_TASKS = MAX_PLAN_TASKS;
/** Mock 最多为几件商品安排「商品理解」步骤 */
const MAX_MOCK_DNA_TASKS = 4;
/** Mock 默认产出哪两个内容槽位（抖音短视频 + 小红书图文是海产商家最常见的起手组合） */
const MOCK_CONTENT_TARGETS: readonly {
  platform: ContentPlatform;
  format: ContentFormat;
}[] = [
  { platform: "douyin", format: "short-video" },
  { platform: "xiaohongshu", format: "article" },
];

/**
 * 依据经营上下文构造 Business Plan 候选值（确定性）。
 *
 * 与前三个候选同一原则：只从输入里**真实存在**的信息拼装 ——
 * 商品名与 `productId` 一律取自上下文给出的清单，绝不凭空补一件商品。
 *
 * 有两条产出路径，按「商家有没有明确勾选渠道」分流（S4-2 新增第二条）：
 *
 * **A. 渠道驱动（`channels` 非空）** —— 驾驶舱对话框的路径。
 *   产出「主推商品 → 品牌档案 → 每个勾选渠道一步内容」的**完整链路**，
 *   且**即使某一步已有结果也照样排进计划**。
 *   为什么刻意违反系统提示词第 6 条（已有就不要安排）：Mock 是引擎的测试替身，
 *   它的职责是让「复用判定」这条分支在**零凭证 Demo** 里真的被走到。
 *   如果 Mock 像真实模型那样把已满足的步骤直接省掉，复用判定的输出永远是空集，
 *   商家就永远看不到「AI 建议：复用已有 Product DNA」这句最有说服力的话 ——
 *   而它恰恰是 S4-1 引擎最值得展示的能力。真实模型仍按提示词工作，
 *   此时复用判定退化为**兜底**（正如 `reuse-resolver.ts` 文件头所述）。
 *
 * **B. 保守规划（`channels` 为空）**：
 *   ① 品牌档案缺失 → 先补一份；② 尚缺商品理解的商品 → 各补一步（上限 4 件）；
 *   ③ 为首件商品产出内容；④ 客服预演；⑤ 直播预演；⑥ 经营分析。
 */
function buildBusinessPlanCandidate(
  context: BusinessContext | null,
): Record<string, unknown> {
  const goal = context?.goal?.trim() ?? "";
  const products = context?.products ?? [];

  /**
   * 拿不到商品清单时返回**一份空计划**，让 Schema 的 `min(1)` 明确失败。
   * 刻意不编一件商品出来顶替：那样会把「上下文解析失败」这个真问题伪装成
   * 「模型给了一份还行的计划」，而这类伪装正是最难排查的。
   */
  if (!goal || products.length === 0) {
    return {
      goal: goal || "（缺少经营目标）",
      summary: "上下文里没有可参与规划的商品，无法制定可执行的计划。",
      tasks: [],
      confidence: 0.2,
    };
  }

  const channels = context?.channels ?? [];
  if (channels.length > 0 || context?.fullChain || /客服|答疑|直播|彩排|复盘|日报/.test(goal)) {
    return buildChannelDrivenPlanCandidate(
      context!,
      goal,
      channels.length > 0 ? channels : context?.fullChain ? MOCK_CONTENT_TARGETS.slice(0, 1) : [],
    );
  }

  const tasks: Record<string, unknown>[] = [];
  /** 任务 id 只依赖当前位置，保证同一份上下文永远产出同一份计划 */
  const pushTask = (task: Omit<Record<string, unknown>, "id">): string => {
    const id = `task-${tasks.length + 1}`;
    tasks.push({ id, ...task });
    return id;
  };

  // ① 品牌档案：全店只有一份，缺失时才安排
  let brandTaskId: string | null = null;
  if (!context?.hasBrandProfile) {
    const seed = products[0];
    brandTaskId = pushTask({
      agent: "brand_agent",
      title: `生成本店品牌档案`,
      reason: `品牌档案决定后续内容的语气与主张，当前尚未生成；以「${seed.name}」作为素材起点。`,
      dependsOn: [],
      productId: seed.id,
      platform: null,
      format: null,
    });
  }

  // ② 商品理解：已有 DNA 的不重复分析（重复安排只白花一次模型调用）
  const dnaTaskIdByProduct = new Map<string, string>();
  const reservedForContent = MOCK_CONTENT_TARGETS.length + 3;
  for (const product of products) {
    if (tasks.length >= MAX_MOCK_PLAN_TASKS - reservedForContent) {
      break;
    }
    if (product.hasDna || dnaTaskIdByProduct.size >= MAX_MOCK_DNA_TASKS) {
      continue;
    }
    dnaTaskIdByProduct.set(
      product.id,
      pushTask({
        agent: "product_agent",
        title: `分析「${product.name}」生成商品理解`,
        reason: "该商品尚无商品理解，先补齐卖点、目标人群与消费场景，内容才有据可依。",
        dependsOn: [],
        productId: product.id,
        platform: null,
        format: null,
      }),
    );
  }

  // ③ 内容：为首件商品产出两个槽位，依赖品牌档案与它自己的商品理解（若已安排）
  const target = products[0];
  const contentDependsOn = [brandTaskId, dnaTaskIdByProduct.get(target.id)].filter(
    (value): value is string => typeof value === "string",
  );
  let contentTaskCount = 0;
  const contentTaskIds: string[] = [];
  for (const { platform, format } of MOCK_CONTENT_TARGETS) {
    if (tasks.length >= MAX_MOCK_PLAN_TASKS) {
      break;
    }
    contentTaskIds.push(pushTask({
      agent: "content_agent",
      title: `为「${target.name}」生成${CONTENT_PLATFORM_LABEL[platform]}${CONTENT_FORMAT_LABEL[format]}`,
      reason: `该商品可以立刻产出内容；先做${CONTENT_PLATFORM_LABEL[platform]}，用最低成本验证卖点是否讲得通。`,
      dependsOn: [...contentDependsOn],
      productId: target.id,
      platform,
      format,
    }));
    contentTaskCount += 1;
  }

  const customerTaskId = pushTask({
    agent: "customer_service_agent",
    title: `验证「${target.name}」的客服知识准备度`,
    reason: "用一条真实商品问题检查知识库能否给出有依据的回答，并暴露需要补充的资料。",
    dependsOn: [dnaTaskIdByProduct.get(target.id)].filter(
      (value): value is string => typeof value === "string",
    ),
    productId: target.id,
    platform: null,
    format: null,
  });

  const liveTaskId = pushTask({
    agent: "live_agent",
    title: `预演「${target.name}」直播场控`,
    reason: "模拟观众提问，验证直播导演能否基于商品与知识材料及时给出安全话术。",
    dependsOn: [
      brandTaskId,
      dnaTaskIdByProduct.get(target.id),
      ...contentTaskIds,
    ].filter((value): value is string => typeof value === "string"),
    productId: target.id,
    platform: null,
    format: null,
  });

  pushTask({
    agent: "analytics_agent",
    title: "生成本轮经营分析报告",
    reason: "汇总本轮协同产物与店铺数据，给出下一步可执行建议，形成经营闭环。",
    dependsOn: [customerTaskId, liveTaskId],
    productId: null,
    platform: null,
    format: null,
  });

  const summaryParts = [`围绕「${goal}」共安排 ${tasks.length} 步`];
  if (brandTaskId) {
    summaryParts.push("先补齐品牌档案");
  }
  if (dnaTaskIdByProduct.size > 0) {
    summaryParts.push(`为 ${dnaTaskIdByProduct.size} 件商品补齐商品理解`);
  }
  if (contentTaskCount > 0) {
    summaryParts.push(`为「${target.name}」产出 ${contentTaskCount} 条内容`);
  }
  summaryParts.push("再完成客服、直播预演与经营复盘");
  if (context?.hasOwnerTwin) {
    summaryParts.push("文案语气沿用老板数字分身");
  }

  return {
    goal,
    summary: `${summaryParts.join("，")}。`,
    tasks,
    // Mock 依据有限，置信度刻意压低，与其它 Agent 的处理保持一致
    confidence: 0.35,
  };
}

/**
 * 渠道驱动模式：主推商品 → 品牌档案 → 渠道内容 → 客服 → 直播 → 经营分析。
 *
 * 刻意「不省步骤」（已有结果也照样排），理由见 `buildBusinessPlanCandidate`。
 * 三条硬边界：
 * - 主推商品取 `primaryProductId`，它不存在时退回清单第一件（**不编造**）；
 * - 内容任务数按 `MAX_PLAN_TASKS - 5` 截断（两个前置步骤 + 三个闭环步骤之外的余量），
 *   贴近契约上限会掩盖「任务数没被裁」这类问题，因此宁可按顺序丢弃尾部渠道；
 * - 内容任务依赖两个前置步骤，且前置步骤在数组里排在前面 ——
 *   计划校验器要求「前置任务先出现」，顺序错了会被直接拒掉。
 */
function buildChannelDrivenPlanCandidate(
  context: BusinessContext,
  goal: string,
  channels: readonly BusinessContextChannel[],
): Record<string, unknown> {
  const primary =
    context.products.find((product) => product.id === context.primaryProductId) ??
    context.products[0];

  const tasks: Record<string, unknown>[] = [];
  const pushTask = (task: Omit<Record<string, unknown>, "id">): string => {
    const id = `task-${tasks.length + 1}`;
    tasks.push({ id, ...task });
    return id;
  };

  const audienceNote = context.targetAudience
    ? `目标人群是「${context.targetAudience}」，`
    : "";
  const fullChain = context.fullChain === true || /全链路|完整推广|完整闭环|推广闭环|六\s*agent/i.test(goal);
  const needsCustomer = fullChain || /客服|答疑|顾客问答|客户问答|咨询预演/.test(goal);
  const needsLive = fullChain || /直播|开播|场控/.test(goal);
  const needsReport = fullChain || /复盘|日报|分析报告|工作分析/.test(goal);

  // ① 主推商品的商品理解（已有结论时由复用判定改为「复用」，不重复花钱）
  const productTaskId = pushTask({
    agent: "product_agent",
    title: `确认「${primary.name}」的商品理解`,
    reason: primary.hasDna
      ? `本次的主推商品是「${primary.name}」，它已有商品理解结论，确认后即可直接用于内容创作。`
      : `本次的主推商品是「${primary.name}」，它尚无商品理解，先补齐卖点、目标人群与消费场景。`,
    dependsOn: [],
    productId: primary.id,
    platform: null,
    format: null,
  });

  // ② 品牌档案（已存在时同样由复用判定改为「复用」）
  const brandTaskId = pushTask({
    agent: "brand_agent",
    title: "确认本店品牌档案",
    reason: context.hasBrandProfile
      ? "品牌档案决定内容的语气与主张，本店已有档案，确认后沿用即可。"
      : "品牌档案决定内容的语气与主张，当前尚未生成，先补一份。",
    dependsOn: [],
    productId: primary.id,
    platform: null,
    format: null,
  });

  // ③ 每个勾选渠道一步内容
  const optionalCount = Number(needsCustomer) + Number(needsLive) + Number(needsReport);
  const contentBudget = Math.max(0, MAX_PLAN_TASKS - tasks.length - optionalCount);
  const contentTaskIds: string[] = [];
  for (const channel of channels.slice(0, contentBudget)) {
    contentTaskIds.push(pushTask({
      agent: "content_agent",
      title: `为「${primary.name}」生成${CONTENT_PLATFORM_LABEL[channel.platform]}${CONTENT_FORMAT_LABEL[channel.format]}`,
      reason: `${audienceNote}${CONTENT_PLATFORM_LABEL[channel.platform]}是本次选定的投放渠道，需要一份可直接使用的${CONTENT_FORMAT_LABEL[channel.format]}。`,
      // 内容要准，得先有商品理解与品牌语气；两者都已排进本计划，因此必挂依赖
      dependsOn: [productTaskId, brandTaskId],
      productId: primary.id,
      platform: channel.platform,
      format: channel.format,
    }));
  }

  const customerTaskId = needsCustomer ? pushTask({
    agent: "customer_service_agent",
    title: `验证「${primary.name}」的客服知识准备度`,
    reason: "发起一次基于知识库的商品问答预演，提前发现答不准或需要人工接管的问题。",
    dependsOn: [productTaskId],
    productId: primary.id,
    platform: null,
    format: null,
  }) : null;

  const liveTaskId = needsLive ? pushTask({
    agent: "live_agent",
    title: `预演「${primary.name}」直播场控`,
    reason: "用模拟观众问题验证直播导演的话术建议与风险控制是否可用。",
    dependsOn: [productTaskId, brandTaskId, ...contentTaskIds],
    productId: primary.id,
    platform: null,
    format: null,
  }) : null;

  if (needsReport) {
    pushTask({
      agent: "analytics_agent",
      title: "生成本轮工作复盘",
      reason: "汇总系统内可核验的内容、问答和任务记录，给出下一步行动。",
      dependsOn: [...contentTaskIds, customerTaskId, liveTaskId].filter(
        (value): value is string => typeof value === "string",
      ),
      productId: null,
      platform: null,
      format: null,
    });
  }

  const channelNames = channels
    .slice(0, contentBudget)
    .map(
      (channel) =>
        `${CONTENT_PLATFORM_LABEL[channel.platform]}${CONTENT_FORMAT_LABEL[channel.format]}`,
    )
    .join("、");

  return {
    goal,
    summary: `围绕「${goal}」共安排 ${tasks.length} 步：确认「${primary.name}」的商品依据，产出 ${channelNames}${needsCustomer ? "，验证答疑" : ""}${needsLive ? "，完成直播彩排" : ""}${needsReport ? "，整理工作复盘" : ""}。`,
    tasks,
    confidence: 0.35,
  };
}

/**
 * 计划层故障注入：把一份**形状合法**的候选改坏，用于验证两层纠错真的在起作用。
 *
 * 两个细节值得说明：
 * - 只认「含 tasks 数组」的候选 —— 其它 Agent 的产物没有任务概念，
 *   误改它们会让故障注入变成随机破坏。
 * - 深拷贝到任务一层再改，绝不原地修改：候选可能被同一轮的其它分支复用。
 */
function injectPlanDefect(
  candidate: Record<string, unknown>,
  scenario: MockAiScenario,
): Record<string, unknown> {
  if (scenario !== "invalid-agent" && scenario !== "circular-dependency") {
    return candidate;
  }
  const rawTasks = candidate.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    return candidate;
  }

  const tasks = rawTasks.map((task) => ({ ...(task as Record<string, unknown>) }));
  const [first, second] = tasks;

  if (scenario === "invalid-agent") {
    // 白名单外的 Agent：会在 Zod 契约层被拦下（第一层纠错）
    tasks[0] = { ...first, agent: "unknown_agent" };
  } else if (second) {
    // 前两个任务互相依赖：形状合法，只有语义校验器看得见（第二层纠错）
    tasks[0] = { ...first, dependsOn: [second.id] };
    tasks[1] = { ...second, dependsOn: [first.id] };
  } else {
    // 只有一个任务时不具备「互相依赖」的条件，退而制造自引用
    tasks[0] = { ...first, dependsOn: [first.id] };
  }

  return { ...candidate, tasks };
}

/**
 * 把候选里的 citation 换成一个不存在的 chunkId。
 *
 * 只改 `chunkId`、保留 `documentId`：这样契约层（Zod 只校验「非空字符串」）
 * 完全看不出问题，**必须**由 Agent 的引用校验才能发现 ——
 * 若连 documentId 一起编，反而可能被更早的某层意外拦住，就测不到真正的防线了。
 */
function injectFabricatedCitation(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const citations = candidate.citations;
  if (!Array.isArray(citations) || citations.length === 0) {
    return candidate;
  }
  return {
    ...candidate,
    citations: citations.map((item, index) => ({
      ...(typeof item === "object" && item !== null ? item : {}),
      chunkId: `kchunk_fabricated_${index + 1}`,
    })),
  };
}

/** 结构化输出的故障注入分发；未登记的场景原样返回 */
function injectStructuredDefect(
  candidate: Record<string, unknown>,
  scenario: MockAiScenario,
): Record<string, unknown> {
  if (scenario === "fabricated-citation") {
    return injectFabricatedCitation(candidate);
  }
  return injectPlanDefect(candidate, scenario);
}

/**
 * 依据知识上下文构造客服回答候选值（确定性）。
 *
 * 这份候选**真的基于检索到的片段**回答，而不是按问题查表返回预置文案 ——
 * 任务书第三十三节明确禁止后者（「不要 Mock 模式直接按问题返回预置答案，
 * 否则测试不到 RAG 链路」）。因此：
 *
 * - 有片段 → 正文取自**片段的真实内容**，引用指向**本次的 chunkId**；
 *   片段一旦换掉，回答与引用会跟着变 —— 这正是「链路是通的」的可观测证据。
 * - 没有片段 → 直接给「依据不足」的形状（grounded=false + needsHuman=true +
 *   说明缺哪类信息）。**不编一段听起来合理的话**。
 */
/** 文档类型 → 客服意图。本地一份而不是从 Agent 引入：Provider 不该依赖 Agent 层 */
const CUSTOMER_INTENT_BY_DOCUMENT_TYPE: Readonly<Record<string, string>> = {
  product: "product",
  storage: "storage",
  cooking: "cooking",
  logistics: "logistics",
  after_sales: "after_sales",
  price: "price",
};

/**
 * 问题原文 → 客服意图（Mock 的确定性分类器）。
 *
 * 为什么不能只靠「排在最前的那个片段的文档类型」：那在**依据充分**时是个不错的代理，
 * 但在**依据不足**时完全是任意的 —— 「依据不足」的定义就是「没有哪份材料真的对得上」，
 * 此时排名第一的片段是一次弱匹配，它的类型与问题想问什么没有关系。
 *
 * 这不是假想问题，实测结果（Task 78 接入缺口时暴露）：
 *   「多久发货？」        → after_sales  （缺口面板显示「缺少售后与赔付政策说明」）
 *   「多久能到？我明天要送人。」 → storage      （显示「缺少储存方式说明」）
 *   「你们有优惠吗？」     → other        （零命中分支硬编码 other ⇒ 整条缺口被静默吞掉）
 * 前两条让商家按错误的类目去补知识，第三条让一个真实的知识空缺根本不进面板。
 * 而 `intent` 正是缺口面板上「缺什么」那一列的来源，所以这不是显示细节。
 *
 * 分类器只看**问题本身**，因为这才是真实模型要做的事 —— Mock 的职责是
 * 「在语义质量上不假装」，而不是「在行为形状上偏离」。
 * 命中顺序即优先级（前面的先匹配），刻意把 after_sales 排在 logistics 之前：
 * 「退货运费谁承担」同时含两个类别的词，但它问的是售后，不该被「运费」抢走。
 * 两个都命不中时，才退回按文档类型判断（依据充分时那个信号仍然有意义）。
 *
 * 词表刻意短、刻意具体：这是 Mock，不是分类器产品。加长它只会让
 * 「Mock 判得准不准」变成一个需要维护的负担，而它本来就不代表真实语义质量。
 */
const CUSTOMER_INTENT_KEYWORDS: readonly (readonly [string, readonly string[]])[] = [
  [
    "after_sales",
    ["售后", "退货", "退款", "退换", "换货", "赔付", "赔", "坏了", "死亡", "变质", "不新鲜", "腐烂", "投诉", "报备", "少发", "漏发", "发错"],
  ],
  [
    "logistics",
    ["发货", "物流", "快递", "配送", "运费", "包邮", "到货", "送达", "签收", "能到", "几天到", "送到", "什么时候发"],
  ],
  ["storage", ["保存", "储存", "存放", "冷藏", "冷冻", "保鲜", "保质", "放多久", "怎么存", "冰袋"]],
  ["cooking", ["煮", "蒸", "炒", "炖", "焖", "做法", "怎么做", "怎么吃", "火候", "解冻", "去壳", "处理"]],
  ["price", ["价格", "多少钱", "优惠", "活动", "便宜", "发票", "折扣", "满减", "涨价"]],
  ["product", ["规格", "几头", "产地", "包装", "礼盒", "重量", "净重", "个头", "大小", "斤"]],
];

/**
 * 解析客服意图：先看问题文本，再退回文档类型。
 *
 * @param fallbackSourceType 检索到的最佳片段所属文档类型；零命中时传 null
 */
function resolveCustomerIntent(
  question: string,
  fallbackSourceType: string | null,
): string {
  for (const [intent, keywords] of CUSTOMER_INTENT_KEYWORDS) {
    if (keywords.some((keyword) => question.includes(keyword))) {
      return intent;
    }
  }
  if (fallbackSourceType) {
    return CUSTOMER_INTENT_BY_DOCUMENT_TYPE[fallbackSourceType] ?? "other";
  }
  return "other";
}

function buildCustomerServiceCandidate(
  context: KnowledgeContext | null,
): Record<string, unknown> {
  const chunks = context?.chunks ?? [];
  const question = context?.question ?? "";

  if (chunks.length === 0) {
    return {
      answer: INSUFFICIENT_GROUNDING_ANSWER,
      /**
       * 零命中时**不再硬编码 other**：那会让「你们有优惠吗？」这类
       * 知识库确实没有覆盖、类别又很清楚的问题凭空消失（`other` 被 Agent
       * 解释成「没有缺什么知识」）。分类器判不出来时才落到 other。
       */
      intent: resolveCustomerIntent(question, null),
      grounded: false,
      confidence: 0.2,
      citations: [],
      needsHuman: true,
      knowledgeGap: "本次没有检索到任何可用片段，知识库中缺少覆盖该问题的文档。",
      riskNotes: [],
    };
  }

  const primary = chunks[0];
  const name = primary?.documentName || "知识库";
  const body = (primary?.content ?? "").replace(/\s+/g, " ").trim();
  const excerpt = body.length <= 120 ? body : `${body.slice(0, 120)}…`;

  return {
    answer: `根据《${name}》的内容：${excerpt}`,
    intent: resolveCustomerIntent(question, primary?.sourceType ?? null),
    grounded: true,
    confidence: 0.82,
    // 引用**只取自本次传入的片段**，且最多两条 —— 与真实模型的期望行为一致
    citations: chunks.slice(0, 2).map((chunk) => ({
      documentId: chunk.documentId,
      chunkId: chunk.chunkId,
    })),
    needsHuman: false,
    riskNotes: [MOCK_OUTPUT_MARKER],
  };
}

/**
 * 直播评论 → 直播导演候选（S6）。
 *
 * 与客服候选同一原则：**链路必须真的通**——
 * - 有片段 → 引用取自本次 chunkId，话术基于片段内容；
 * - 无片段 / 营销型 → grounded=false + 风险提示 + 保守话术，**不编一段听起来确定的承诺**。
 *
 * 本地一份规则而不是从 Agent 引入：Provider 不该依赖 Agent 层。
 */
const LIVE_INTENT_KEYWORDS: readonly (readonly [LiveIntent, readonly string[]])[] = [
  ["spam", ["加微信", "私聊", "刷单", "免费领"]],
  ["after_sale", ["售后", "退货", "退款", "赔付", "坏了", "死了", "变质"]],
  ["logistics_question", ["多久到", "几天到", "发货", "物流", "快递", "包邮", "运费", "能到"]],
  ["storage_question", ["保存", "储存", "冷藏", "冷冻", "保鲜", "放几天", "怎么存"]],
  ["cooking_question", ["怎么吃", "怎么做", "怎么煮", "怎么蒸", "做法", "烹饪"]],
  ["objection", ["太贵", "有点贵", "便宜点", "划算", "值不值"]],
  ["purchase_intent", ["怎么买", "想买", "我要", "下单", "拍一个", "有货吗"]],
  ["comparison", ["对比", "哪个好", "区别"]],
  ["price_question", ["多少钱", "价格", "优惠"]],
  ["origin_question", ["产地", "哪里产的", "野生"]],
  ["product_question", ["规格", "多大", "几头", "礼盒", "适合"]],
  ["praise", ["讲得", "说得好", "赞", "关注了"]],
];

/** 评论 → 意图（关键词表命中即返回；都不命中为 other） */
function resolveLiveIntent(comment: string): LiveIntent {
  for (const [intent, keywords] of LIVE_INTENT_KEYWORDS) {
    if (keywords.some((keyword) => comment.includes(keyword))) {
      return intent;
    }
  }
  return "other";
}

/** 意图 → 推荐动作 / 优先级（与真实模型期望行为一致的确定性映射） */
const LIVE_ACTION_BY_INTENT: Readonly<Record<string, string>> = {
  storage_question: "explain_storage",
  cooking_question: "explain_cooking",
  logistics_question: "clarify_logistics",
  after_sale: "handle_objection",
  price_question: "explain_product",
  origin_question: "explain_product",
  product_question: "explain_product",
  purchase_intent: "reinforce_selling_point",
  objection: "handle_objection",
  comparison: "reinforce_selling_point",
  praise: "engage_audience",
  spam: "ignore",
  other: "engage_audience",
};

function livePriority(intent: LiveIntent): string {
  if (
    intent === "logistics_question" ||
    intent === "after_sale" ||
    intent === "storage_question" ||
    intent === "objection" ||
    intent === "purchase_intent"
  ) {
    return "high";
  }
  if (intent === "spam" || intent === "praise") {
    return "low";
  }
  return "medium";
}

function buildLiveDirectorCandidate(
  context: LiveContext | null,
): Record<string, unknown> {
  const chunks = context?.chunks ?? [];
  const comment = context?.comment ?? "";
  const intent = resolveLiveIntent(comment);

  const shouldRespond = intent !== "spam";
  const recommendedAction = shouldRespond
    ? (LIVE_ACTION_BY_INTENT[intent] ?? "engage_audience")
    : "ignore";

  if (chunks.length === 0) {
    /**
     * 无知识片段时的置信度**按意图分开**（与任务书 2.2 同一口径）：
     *
     * - 事实型意图（保存 / 物流 / 售后……）拿不到依据 = 模型确实没把握 → 0.2；
     * - 营销 / 转化型意图（异议、下单、夸赞……）本来就不依赖知识库，
     *   接一句话并不难 → 给正常把握度。
     *
     * Mock 是「确定性替身」，它给出的 confidence 应当和真实模型在同等情形下
     * 的合理取值一致 —— 否则用 Mock 写出来的用例会钉住一个错误语义。
     */
    const factual = isFactualLiveIntent(intent);
    return {
      intent,
      priority: livePriority(intent),
      shouldRespond,
      responseMode: shouldRespond ? "send_to_customer_service" : "ignore",
      hostSuggestion: shouldRespond
        ? "这条评论目前没有可用的知识依据，建议主播不要给出具体承诺，必要时引导观众咨询客服。"
        : "这条评论与直播内容无关，可以忽略。",
      suggestedReply: shouldRespond
        ? "这个信息我需要跟客服再确认一下，稍后给您准确答复。"
        : "感谢关注，我们继续看产品哈。",
      grounded: false,
      citations: [],
      recommendedAction,
      riskNotes: [MOCK_OUTPUT_MARKER, "本次没有检索到可用知识片段，已避免具体承诺。"],
      confidence: factual ? 0.2 : 0.75,
    };
  }

  const primary = chunks[0];
  const name = primary?.documentName || "知识库";
  const body = (primary?.content ?? "").replace(/\s+/g, " ").trim();
  const excerpt = body.length <= 100 ? body : `${body.slice(0, 100)}…`;

  return {
    intent,
    priority: livePriority(intent),
    shouldRespond,
    responseMode: shouldRespond ? "answer_now" : "ignore",
    hostSuggestion: `观众在问与《${name}》相关的问题，建议主播结合知识内容正面回应。`,
    suggestedReply: `根据《${name}》的内容：${excerpt}`,
    grounded: true,
    // 引用只取自本次传入的片段，最多两条 —— 与真实模型期望行为一致
    citations: chunks.slice(0, 2).map((chunk) => ({
      documentId: chunk.documentId,
      chunkId: chunk.chunkId,
    })),
    recommendedAction,
    riskNotes: [MOCK_OUTPUT_MARKER],
    confidence: 0.8,
  };
}

/**
 * 经营日报候选（S6-B）。
 *
 * ## 这个候选为什么必须严格遵守 Schema 的三道数值防线
 *
 * 与其它 Agent 不同，经营日报的 Schema 是**按快照动态构造**的：
 * `metricKeys` 只能引用当次快照里真实存在的键，文案里的百分比必须能在
 * `allowedPercents` 里找到出处，凡是「销售额 / 订单量 / 转化率 / 播放量」
 * 这类本系统没有的名词与数字同句出现就会被判违规。
 *
 * 因此本候选遵守两条纪律：
 * 1. **只引用白名单里的键**，键名以字面量写出（而不是从 `metrics` 里遍历生成）——
 *    遍历生成的键在上下文缺字段时会凭空消失，让「至少一条亮点」变成随机失败；
 * 2. **百分比一律由 `Math.round(value * 100)` 现算**，与
 *    `collectAllowedPercents()` 的计算方式完全一致，因此必然对得上账。
 *
 * ## 为什么这里没有 `MOCK_OUTPUT_MARKER`
 *
 * 其它 Agent 把它塞进各自的 `riskNotes` 字段；经营日报的契约里**没有**这个字段，
 * 硬塞会被 Zod 拒掉。占位提示因此改由界面承担 ——
 * `BusinessReportSection` 会依据 `provider.isMock` 显示「当前为占位模型」。
 * 这比往契约里加一个只服务于 Mock 的字段更诚实。
 */
function buildAnalyticsReportCandidate(
  context: AnalyticsPromptContext | null,
): Record<string, unknown> {
  const metrics = context?.metrics ?? {};

  /** 取原始数值；不存在或为 null（今日无数据）时返回 null */
  const raw = (key: string): number | null => {
    const entry = metrics[key];
    return entry && typeof entry.value === "number" ? entry.value : null;
  };
  /** 计数类：缺字段按 0（`null` 表示「没这条数据」，对计数而言与 0 等价） */
  const count = (key: string): number => raw(key) ?? 0;
  /** 比率类 → 展示用百分比；与数值守卫同一算法，必然在允许集合内 */
  const percent = (key: string): string | null => {
    const value = raw(key);
    return value === null ? null : `${Math.round(value * 100)}%`;
  };

  const health = context?.health ?? "good";
  const healthLabel =
    health === "risk" ? "存在风险" : health === "attention" ? "需要关注" : "经营健康";

  const totalProducts = count("product.totalProducts");
  const analyzedProducts = count("product.analyzedProducts");
  const totalAssets = count("content.totalAssets");
  const generatedToday = count("content.generatedToday");
  const reusedTaskCount = count("workflow.reusedTaskCount");
  const failedRuns = count("workflow.failedRuns");
  const completedTasks = count("agents.completedTasks");
  const failedTasks = count("agents.failedTasks");
  const openGaps = count("customerService.openKnowledgeGapCount");
  const groundedRate = raw("customerService.groundedRate");

  /* ---------------- 摘要 ---------------- */
  const summaryParts = [
    `今天系统记录了 ${totalProducts} 件商品、今日新增 ${generatedToday} 条内容，共完成 ${completedTasks} 个 AI 任务。`,
    `程序按阈值判定的经营健康度为「${healthLabel}」。`,
  ];
  if (openGaps > 0) {
    summaryParts.push(`当前有 ${openGaps} 个未解决知识缺口，建议优先处理。`);
  } else if (failedTasks > 0) {
    summaryParts.push(`有 ${failedTasks} 个 AI 任务失败，需要排查原因。`);
  } else {
    summaryParts.push("暂未发现需要立即处理的异常信号。");
  }
  const executiveSummary = summaryParts.join("").slice(0, 400);

  /* ---------------- 亮点（至少一条） ---------------- */
  const highlights: Record<string, unknown>[] = [];
  if (reusedTaskCount > 0) {
    highlights.push({
      title: "AI 复用了已有结果",
      evidence: `本次经营计划中复用了 ${reusedTaskCount} 个已有结论，没有重复调用模型。`,
      metricKeys: ["workflow.reusedTaskCount"],
    });
  }
  if (analyzedProducts > 0) {
    highlights.push({
      title: "商品理解已覆盖部分商品",
      evidence: `已完成 ${analyzedProducts} 件商品的 AI 分析，共 ${totalProducts} 件商品。`,
      metricKeys: ["product.analyzedProducts", "product.totalProducts"],
    });
  }
  if (generatedToday > 0) {
    highlights.push({
      title: "今天产出了新的营销内容",
      evidence: `今日新增 ${generatedToday} 条内容资产，累计 ${totalAssets} 条。`,
      metricKeys: ["content.generatedToday", "content.totalAssets"],
    });
  }
  if (completedTasks > 0 && highlights.length < 3) {
    highlights.push({
      title: "AI 员工完成了多轮任务",
      evidence: `已结束的任务中成功 ${completedTasks} 个。`,
      metricKeys: ["agents.completedTasks"],
    });
  }
  if (highlights.length === 0) {
    // §17：数据稀少时如实说明状态，不编故事
    highlights.push({
      title: "经营数据开始积累",
      evidence: `当前已记录 ${totalProducts} 件商品、${totalAssets} 条内容资产，系统刚开始沉淀经营数据。`,
      metricKeys: ["product.totalProducts", "content.totalAssets"],
    });
  }

  /* ---------------- 问题 ---------------- */
  const issues: Record<string, unknown>[] = [];
  if (openGaps > 0) {
    issues.push({
      title: "存在未解决的知识缺口",
      severity: openGaps >= 5 ? "high" : openGaps >= 2 ? "medium" : "low",
      evidence: `未解决知识缺口共 ${openGaps} 个，这些问题当前拿不到知识依据。`,
      metricKeys: ["customerService.openKnowledgeGapCount"],
      possibleCauses: [
        "可能原因之一是近期某类提问集中出现，而知识库尚未覆盖该主题，可结合缺口分布进一步确认。",
        "也可能是已有文档没有覆盖客户的具体问法，建议对照缺口的提问原话核对。",
      ],
    });
  }
  if (failedTasks > 0) {
    issues.push({
      title: "有 AI 任务执行失败",
      severity: failedTasks >= 3 ? "high" : "medium",
      evidence: `失败的任务数为 ${failedTasks} 个。`,
      metricKeys: ["agents.failedTasks"],
      possibleCauses: [
        "可能是模型调用超时或额度受限，建议查看失败任务记录里的错误信息。",
        "也可能是输入资料不足导致结构校验未通过，可检查对应商品或品牌资料的完整度。",
      ],
    });
  }
  if (failedRuns > 0) {
    issues.push({
      title: "有经营工作流没有跑完",
      severity: "medium",
      evidence: `失败的工作流运行共 ${failedRuns} 次。`,
      metricKeys: ["workflow.failedRuns"],
      possibleCauses: [
        "可能是某个前置任务失败导致后续步骤被阻塞，建议打开那一轮工作流查看是哪一步先失败的。",
      ],
    });
  }
  if (groundedRate !== null && groundedRate < 0.7) {
    const shown = percent("customerService.groundedRate");
    issues.push({
      title: "客服有依据回答占比未达标",
      severity: groundedRate < 0.5 ? "high" : "medium",
      evidence: `客服有依据回答占比为 ${shown ?? "偏低"}。`,
      metricKeys: ["customerService.groundedRate"],
      possibleCauses: [
        "可能原因之一是知识库覆盖面不足，部分提问检索不到可用资料，可结合知识缺口分布确认。",
      ],
    });
  }
  if (health === "risk" && issues.length === 0) {
    // 一致性约束：risk 必须至少有 one 条问题。兜底一条，指向最可能的风险信号。
    issues.push({
      title: "程序判定存在经营风险",
      severity: "high",
      evidence: "程序按阈值判定健康度为风险，请先处理下方列出的优先行动。",
      metricKeys: ["agents.failedTasks"],
      possibleCauses: [
        "可能是多项指标同时偏离常态，建议按行动建议逐条排查。",
      ],
    });
  }

  /* ---------------- 行动建议（优先级连续且互不相同） ---------------- */
  const actions: Record<string, unknown>[] = [];
  if (openGaps > 0) {
    actions.push({
      title: "补齐未解决的知识缺口",
      reason: `有 ${openGaps} 个未解决知识缺口，客户提问暂时拿不到知识依据。`,
      actionType: "knowledge",
      recommendedAction:
        "打开客服工作台的知识缺口面板，按被问次数从高到低，先为排名第一的缺口补一份说明文档并完成索引。",
    });
  }
  if (failedTasks > 0) {
    actions.push({
      title: "排查失败的 AI 任务",
      reason: `有 ${failedTasks} 个 AI 任务失败，失败会直接拉低经营健康度。`,
      actionType: "workflow",
      recommendedAction:
        "在驾驶舱的最近经营任务里打开失败的那一轮，查看失败原因；如果是资料缺失，补齐后重新发起。",
    });
  }
  if (analyzedProducts < totalProducts) {
    actions.push({
      title: "为未分析的商品补齐商品理解",
      reason: `还有 ${totalProducts - analyzedProducts} 件商品没有 AI 分析结论，内容创作缺少依据。`,
      actionType: "product",
      recommendedAction: "在商品中心挑一件主推商品，点击「AI 分析」生成 Product DNA。",
    });
  }
  if (generatedToday === 0) {
    actions.push({
      title: "先产出一条可用的营销内容",
      reason: "今天还没有新增内容，账号缺少新的素材。",
      actionType: "content",
      recommendedAction:
        "选一件已有商品理解的商品，用内容运营生成一条抖音短视频脚本，先把今天的素材补上。",
    });
  }
  if (actions.length === 0) {
    actions.push({
      title: "再跑一轮完整的经营任务",
      reason: "当前 AI 任务记录还很少，先让每个环节都跑一次，经营数据才有参考价值。",
      actionType: "workflow",
      recommendedAction:
        "在驾驶舱点「启动今日经营」，选一件商品与两个渠道，走完一轮完整流程。",
    });
  }

  const prioritized = actions.slice(0, 4).map((action, index) => ({
    priority: index + 1,
    ...action,
  }));

  /* ---------------- 明日重点 ---------------- */
  const tomorrowFocus: string[] = [];
  if (openGaps > 0) {
    tomorrowFocus.push("补一份被问得最多的知识文档");
  }
  if (analyzedProducts < totalProducts) {
    tomorrowFocus.push("给还没做 AI 分析的商品补齐商品理解");
  }
  if (failedTasks > 0) {
    tomorrowFocus.push("查清失败任务的真正原因");
  }
  tomorrowFocus.push("下班前再看一次经营日报，确认今天的问题是否收口");

  return {
    executiveSummary,
    health,
    highlights: highlights.slice(0, 3),
    issues: issues.slice(0, 3),
    actions: prioritized,
    tomorrowFocus: tomorrowFocus.slice(0, 4),
    // Mock 依据有限，置信度刻意压低，与其它 Agent 的处理保持一致
    confidence: 0.35,
    ...(context?.sales?.summary.count ? { salesReview: buildDemoSalesReview(context.sales) } : {}),
  };
}

/**
 * 结构化请求的上下文块标记 → 候选构造器。
 * 新增 Agent 时在这里登记两行（标记 + 分发分支），Provider 接口与 Agent 代码都不用改。
 */
const STRUCTURED_REQUEST_MARKERS: readonly string[] = [
  POSTER_CONTEXT_START,
  CONTEXT_BLOCK_START,
  BRAND_CONTEXT_BLOCK_START,
  CONTENT_CONTEXT_BLOCK_START,
  BUSINESS_CONTEXT_BLOCK_START,
  KNOWLEDGE_CONTEXT_BLOCK_START,
  LIVE_CONTEXT_BLOCK_START,
  ANALYTICS_CONTEXT_BLOCK_START,
];

/** 按提示词里出现的上下文块生成候选值；都不匹配时退回 Product DNA 形状 */
function buildStructuredCandidate(prompt: string): Record<string, unknown> {
  if (prompt.includes(POSTER_CONTEXT_START)) return { ...buildMockPosterDesign(prompt) };
  if (prompt.includes(ANALYTICS_CONTEXT_BLOCK_START)) {
    return buildAnalyticsReportCandidate(parseAnalyticsContextBlock(prompt));
  }
  if (prompt.includes(BUSINESS_CONTEXT_BLOCK_START)) {
    return buildBusinessPlanCandidate(parseBusinessContextBlock(prompt));
  }
  if (prompt.includes(CONTENT_CONTEXT_BLOCK_START)) {
    return buildContentCandidate(parseContentContextBlock(prompt));
  }
  if (prompt.includes(BRAND_CONTEXT_BLOCK_START)) {
    return buildBrandProfileCandidate(parseBrandContextBlock(prompt));
  }
  if (prompt.includes(LIVE_CONTEXT_BLOCK_START)) {
    return buildLiveDirectorCandidate(parseLiveContextBlock(prompt));
  }
  if (prompt.includes(KNOWLEDGE_CONTEXT_BLOCK_START)) {
    return buildCustomerServiceCandidate(parseKnowledgeContextBlock(prompt));
  }
  return buildProductDnaCandidate(parseProductContextBlock(prompt));
}

/** 确定性伪随机：同一输入永远得到同一结果，便于断言 */
function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 2147483647;
  }
  return hash;
}

/* ------------------------------------------------------------------ */
/* 确定性 Embedding（S5）                                              */
/* ------------------------------------------------------------------ */

/**
 * FNV-1a 32 位散列。
 *
 * 为什么不用上面那个 `hashString`：它是为「同样的输入给同样的伪随机数」设计的，
 * 分布质量一般。特征散列（feature hashing）要把成千上万个词映射到 1024 个桶里，
 * 分布不均会让大量词挤在少数几维上 —— 结果是**语义无关的两段文本也高度相似**，
 * 检索出来的东西看起来有结果、其实全是噪声。FNV-1a 的雪崩性足够好。
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // 乘以 FNV 质数并用 `>>> 0` 保持 32 位无符号
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}


/**
 * 确定性文本向量（特征散列 + L2 归一化）。
 *
 * 三条性质，缺一不可：
 * 1. **完全确定**：同一段文本每次得到逐位相同的向量 —— 否则「重新索引」会
 *    产出与旧向量不可比的向量，检索结果每次刷新都在变。
 * 2. **相同词元 → 相似向量**：共享词越多，余弦相似度越高，于是
 *    Retriever 的阈值判定与排序在 Mock 下真的能跑出有意义的结果。
 * 3. **长度为 `EMBEDDING_DIMENSIONS`**：与数据库列 `vector(1024)` 一致，
 *    否则 Mock 模式会在写库时报维度错误，零凭证 Demo 直接跑不起来。
 *
 * 每个词元用两个散列分别决定「落在哪一维」与「正负号」，是标准的 feature hashing
 * 做法：只映射到正维会让所有词元互相叠加，向量之间几乎全部高度相似，
 * 排序彻底失去区分度。
 *
 * ⚠️ 词袋哈希的一个已知局限：短问句与长段落的余弦**天然偏低**，而且
 * **零重叠的两段文本也会拿到 0.05~0.12 的余弦**（特征散列的碰撞底噪），
 * 与真实信号同量级。因此检索不能只看余弦 —— 必须叠加词面覆盖度做 hybrid，
 * 阈值也必须按 Provider 分别配置，见 `src/rag/retriever.ts` 的 `RETRIEVAL_PROFILES`。
 */
export function buildDeterministicEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

  for (const { token, weight } of tokenizeForEmbedding(text)) {
    const slot = fnv1a(token) % EMBEDDING_DIMENSIONS;
    const sign = (fnv1a(`#${token}`) & 1) === 0 ? 1 : -1;
    vector[slot] += sign * weight;
  }

  // 归一化后余弦相似度就等于内积，检索层不必再各算一次范数
  return normalizeVector(vector);
}

/** 生成一段确定性的「图像可见内容」描述 */
function buildVisualDescription(name: string, imageCount: number): string {
  const seed = hashString(`${name}:${imageCount}`);

  return [
    `${name}主体清晰可辨，形态完整，占画面中心位置`,
    "色泽自然，表面无明显破损或异常",
    imageCount > 1
      ? `共 ${imageCount} 张图片，角度互补，能看出规格对比`
      : "单张图片，规格参照物不明显",
    seed % 2 === 0
      ? "背景为浅色纯色，适合直接用作电商主图"
      : "背景带有生活化道具，适合场景化内容",
    "画质清晰，无明显反光或遮挡",
  ].join("\n");
}

/** 从任意文本里提取商品名，提取不到时回退为「该商品」 */
function resolveProductName(text: string): string {
  return VISION_NAME_PATTERN.exec(text)?.[1]?.trim() || "该商品";
}

/**
 * 创建 Mock Provider。
 * 注意：内部维护调用计数，**同一个实例**才具备「第一次脏、第二次好」的场景语义。
 */
export function createMockAIProvider(
  options: MockAIProviderOptions = {},
): AIProvider {
  const scenario: MockAiScenario = options.scenario ?? "ok";
  let structuredCallCount = 0;

  function assertScenarioUsable(): void {
    if (scenario === "timeout") {
      throw new AppError({
        code: "MODEL_TIMEOUT",
        message: "模型响应超时，请稍后重试",
        detail: "Mock Provider 注入的 timeout 场景",
      });
    }
    if (scenario === "unavailable") {
      throw new AppError({
        code: "MODEL_UNAVAILABLE",
        message: "模型服务暂时不可用",
        detail: "Mock Provider 注入的 unavailable 场景",
      });
    }
  }

  function nextStructuredText(prompt: string): string {
    structuredCallCount += 1;
    const candidate = buildStructuredCandidate(prompt);

    if (scenario === "always-invalid") {
      return MESSY_STRUCTURED_OUTPUT;
    }
    if (scenario === "messy-then-ok" && structuredCallCount === 1) {
      return MESSY_STRUCTURED_OUTPUT;
    }

    // 故障注入**只在首次**生效：第二次（已看到纠错提示）必须给出合法输出，
    // 否则只能测出「两轮都坏 → 最终失败」，测不到「回喂后修好」这条主路径。
    const withDefect =
      structuredCallCount === 1
        ? injectStructuredDefect(candidate, scenario)
        : candidate;

    return JSON.stringify(withDefect, null, 2);
  }

  async function generateTextImpl(input: GenerateTextInput): Promise<string> {
    assertScenarioUsable();

    // 含任一结构化上下文块 → 视为结构化生成请求；否则按自由文本（如视觉描述）处理
    if (STRUCTURED_REQUEST_MARKERS.some((marker) => input.prompt.includes(marker))) {
      return nextStructuredText(input.prompt);
    }

    return buildVisualDescription(resolveProductName(input.prompt), 0);
  }

  return {
    id: options.id ?? "mock",

    generateText: generateTextImpl,

    async generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
      assertScenarioUsable();

      const raw = nextStructuredText(input.prompt);
      const candidate = parseJsonOrNull(raw);
      const validated = input.schema.safeParse(candidate);

      if (!validated.success) {
        throw new AppError({
          code: "SCHEMA_INVALID",
          message: "模型输出不符合约定结构",
          detail: validated.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; "),
        });
      }

      return validated.data;
    },

    async streamText(input: StreamTextInput): Promise<ReadableStream<string>> {
      const full = await generateTextImpl(input);

      return new ReadableStream<string>({
        start(controller) {
          const chunkSize = 12;
          for (let index = 0; index < full.length; index += chunkSize) {
            controller.enqueue(full.slice(index, index + chunkSize));
          }
          controller.close();
        },
      });
    },

    async analyzeImage(input: AnalyzeImageInput): Promise<string> {
      assertScenarioUsable();

      if (input.imageUrls.length === 0) {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: "没有可分析的图片",
          detail: "imageUrls 为空，调用方应先判断商品是否已上传图片",
        });
      }

      return buildVisualDescription(
        resolveProductName(input.prompt),
        input.imageUrls.length,
      );
    },

    /**
     * 文本向量化（S5）。
     *
     * 确定性的 hash-based 向量，**不联网、不可随机**。
     * 与真实模型的关系：它只保证「接口可用 + 相同词元更靠近」，
     * 并不代表真实语义质量 —— 因此界面上的「相关度 82%」在 Mock 模式下
     * 只应被理解为「这条路跑通了」，而不是一个可比较的语义分数。
     *
     * 空文本与真实 Provider 一样明确拒绝：若在这里返回零向量，
     * Mock 模式下「切片里混进空串」这个缺陷就永远暴露不出来，
     * 等到换成真实模型才炸，那时已经离现场很远了。
     */
    async embed(input: EmbedInput): Promise<number[][]> {
      assertScenarioUsable();

      if (input.values.length === 0) {
        return [];
      }

      const emptyIndex = input.values.findIndex((value) => value.trim().length === 0);
      if (emptyIndex !== -1) {
        throw new AppError({
          code: "VALIDATION_FAILED",
          message: "存在空文本，无法向量化",
          detail: `第 ${emptyIndex + 1} 条文本为空。切片阶段应保证每段都非空。`,
        });
      }

      return input.values.map((value) => buildDeterministicEmbedding(value));
    },
  };
}

function parseJsonOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
