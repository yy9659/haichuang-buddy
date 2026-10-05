/**
 * AI 直播导演 Agent 单测（S6）
 *
 * 覆盖任务书第九 / 十 / 十一 / 十二 / 十三 / 十四节的判定逻辑：
 *
 *   意图预分类 → RAG 路由 → 检索 → 依据判定 → 引用校验 → 承诺措辞兜底
 *
 * 与客服 Agent 用例同一原则：链路用 Mock Provider，但**切片、向量化、检索、
 * 引用校验都是真实执行的**（不是「按评论查表返回预置答案」）。因此断言在换成
 * 真实 DashScope 后依然成立 —— 它们验证的是我们自己写的判定，不是模型。
 *
 * 直播与客服的关键差别也在这里被钉住：**事实型评论必须走检索**，
 * 营销 / 互动型评论不检索、也绝不允许被标成「有知识依据」。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { runLiveAgent, requiresRetrieval } from "@/ai/agents/live-agent";
import { createMockAIProvider } from "@/ai/provider/mock";
import type { AIProvider } from "@/ai/provider/types";
import {
  isFactualLiveIntent,
  preclassifyLiveIntent,
} from "@/ai/prompts/live-agent";
import { INSUFFICIENT_LIVE_CONFIDENCE } from "@/ai/schemas/live-director";
import { resetServerEnvCache } from "@/lib/env";
import { AppError } from "@/lib/result";
import { MOCK_BUSINESS, MOCK_LIVE_PRODUCT_ID } from "@/lib/mock";
import { getRepositories } from "@/repositories";
import { createMockKnowledgeChunkRepository } from "@/repositories/mock/knowledge";
import { resetStoredKnowledge } from "@/repositories/mock/store";
import type {
  KnowledgeChunkSearchHit,
  KnowledgeSearchParams,
} from "@/repositories/types";
import {
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
} from "@/services/knowledge.service";
import type { Product } from "@/types";

process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

const BUSINESS_ID = MOCK_BUSINESS.id;

/** 把种子文档跑一遍真实索引流程（切片 → 向量 → 写切片表 → 标记 indexed） */
async function indexAllDocuments(): Promise<void> {
  const listed = await listKnowledgeDocuments();
  if (!listed.ok) {
    throw new Error(`加载种子知识失败：${listed.error.message}`);
  }
  for (const document of listed.data) {
    const reindexed = await reindexKnowledgeDocument(document.id);
    if (!reindexed.ok) {
      throw new Error(
        `索引种子知识「${document.name}」失败：${reindexed.error.code} ${reindexed.error.message}`,
      );
    }
  }
}

/**
 * 直播 Agent 需要一个当前商品。
 *
 * 这里取的是**演示商品 prod_001（连江鲜活鲍鱼）**而不是临时新建一件 ——
 * 因为检索是**按商品过滤**的：种子知识《鲜活鲍鱼储存说明》挂在 prod_001 上，
 * 换一件临时商品会把它整体排除，测出来的就是「知识库没覆盖」的假象。
 * 用与真实直播同一件商品，这组用例才和生产路径一致。
 */
async function loadLiveProduct(): Promise<Product> {
  const product = await getRepositories().products.getById(MOCK_LIVE_PRODUCT_ID);
  if (!product) {
    throw new Error(`演示商品 ${MOCK_LIVE_PRODUCT_ID} 不存在，Mock 种子被改动过？`);
  }
  return product;
}

/** Agent 需要的检索依赖：接 Mock 仓储，Agent 自己不知道数据在哪 */
function buildDeps(provider: AIProvider = createMockAIProvider()) {
  const chunkRepository = createMockKnowledgeChunkRepository();
  const search = (
    params: KnowledgeSearchParams,
  ): Promise<KnowledgeChunkSearchHit[]> => chunkRepository.searchSimilar(params);
  return { provider, search };
}

async function run(
  comment: string,
  overrides: {
    provider?: AIProvider;
    product?: Product;
    businessId?: string;
  } = {},
) {
  const product = overrides.product ?? (await loadLiveProduct());
  return runLiveAgent(
    {
      comment,
      businessId: overrides.businessId ?? BUSINESS_ID,
      product,
    },
    buildDeps(overrides.provider ?? createMockAIProvider()),
  );
}

/**
 * 一个只覆盖 `generateText` 的桩 Provider。
 *
 * 用途是精确控制**模型输出**（例如故意写一句带承诺的话术），
 * 用来验证 Agent 侧的兜底 —— 这类行为 Mock Provider 不会自发产生。
 *
 * `embed` 刻意**转发给真实 Mock Provider**：向量化要与检索一起真实执行，
 * 否则「事实型评论走了检索」这件事就被桩掉了，用例会失去意义。
 */
function createStubProvider(payload: Record<string, unknown>): AIProvider {
  const embedding = createMockAIProvider();
  return {
    id: "stub",
    async generateText() {
      return JSON.stringify(payload);
    },
    async generateObject<T>(): Promise<T> {
      throw new Error("本场景不应调用 generateObject");
    },
    async streamText() {
      throw new Error("本场景不应调用 streamText");
    },
    async analyzeImage(): Promise<string> {
      throw new Error("本场景不应调用 analyzeImage");
    },
    embed: (input) => embedding.embed(input),
  };
}

beforeEach(() => {
  resetStoredKnowledge();
});

/* ------------------------------------------------------------------ */
/* 意图预分类与 RAG 路由（纯函数）                                     */
/* ------------------------------------------------------------------ */

describe("直播导演 · 意图预分类与 RAG 路由", () => {
  it("能从评论里识别出事实型意图", () => {
    expect(preclassifyLiveIntent("这个鲍鱼怎么保存？能放几天？")).toBe(
      "storage_question",
    );
    expect(preclassifyLiveIntent("今天下单明天能到吗？")).toBe("logistics_question");
    expect(preclassifyLiveIntent("收到货死了怎么办？有售后吗")).toBe("after_sale");
    expect(preclassifyLiveIntent("不会杀鲍鱼，能给个教程吗")).toBe("cooking_question");
    expect(preclassifyLiveIntent("这个价格是活的还是冻的？")).toBe("price_question");
  });

  it("能识别出营销 / 互动型意图", () => {
    expect(preclassifyLiveIntent("感觉有点贵，能便宜点吗")).toBe("objection");
    expect(preclassifyLiveIntent("我想下单，怎么买？")).toBe("purchase_intent");
    expect(preclassifyLiveIntent("老板讲得很实在，先关注了")).toBe("praise");
    expect(preclassifyLiveIntent("加微信私聊，有免费领")).toBe("spam");
  });

  it("没把握时返回 null，而不是硬塞一个 other", () => {
    expect(preclassifyLiveIntent("在吗")).toBeNull();
    expect(preclassifyLiveIntent("。。。")).toBeNull();
  });

  it("只有事实型意图必须走检索；未识别（null）也检索", () => {
    expect(requiresRetrieval("storage_question")).toBe(true);
    expect(requiresRetrieval("logistics_question")).toBe(true);
    expect(requiresRetrieval("after_sale")).toBe(true);

    expect(requiresRetrieval("praise")).toBe(false);
    expect(requiresRetrieval("objection")).toBe(false);
    expect(requiresRetrieval("spam")).toBe(false);

    // 程序没识别出意图时宁可多查一次，也不能漏掉一个事实问题
    expect(requiresRetrieval(null)).toBe(true);
  });

  it("事实型意图清单覆盖政策与商品事实，但不含营销 / 互动", () => {
    expect(isFactualLiveIntent("product_question")).toBe(true);
    expect(isFactualLiveIntent("origin_question")).toBe(true);
    expect(isFactualLiveIntent("comparison")).toBe(false);
    expect(isFactualLiveIntent("purchase_intent")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 事实型评论：走检索 + 有依据                                         */
/* ------------------------------------------------------------------ */

describe("直播导演 · 事实型评论（任务书第十 / 十三节）", () => {
  it("知识库覆盖储存问题时，给出有依据的建议与可核查的引用", async () => {
    await indexAllDocuments();

    const result = await run("这个鲍鱼怎么保存？能放几天？");
    if (!result.ok) {
      throw new Error(`期望成功，实际失败：${result.error.code} ${result.error.message}`);
    }

    expect(result.data.retrieval.used).toBe(true);
    expect(result.data.retrieval.sufficient).toBe(true);
    expect(result.data.result.grounded).toBe(true);
    expect(result.data.result.citations.length).toBeGreaterThan(0);

    // 引用必须指向真实存在的文档，而不是「有引用」就够
    const titles = result.data.result.citations.map((item) => item.title);
    expect(titles).toContain("鲜活鲍鱼储存说明");
    for (const citation of result.data.result.citations) {
      expect(citation.chunkId.length).toBeGreaterThan(0);
      expect(citation.documentId.length).toBeGreaterThan(0);
      expect(citation.snippet.length).toBeGreaterThan(0);
    }

    // 话术要真的用上知识内容（冷藏 / 冷冻），而不是通用话术
    expect(result.data.result.suggestedReply).toMatch(/冷藏|冷冻|0-4/);
  });

  it("知识库没有物流时效时，「明天能到吗」判为依据不足且不许承诺", async () => {
    await indexAllDocuments();

    const result = await run("今晚下单明天能到吗？");
    if (!result.ok) {
      throw new Error(`依据不足也应成功返回，实际失败：${result.error.message}`);
    }

    expect(result.data.retrieval.used).toBe(true);
    expect(result.data.retrieval.sufficient).toBe(false);
    expect(result.data.result.grounded).toBe(false);
    // 依据不足 => 不得留下任何引用（否则界面会出现「无依据却挂着引用」）
    expect(result.data.result.citations).toHaveLength(0);
    // 必须至少给一条风险提示，主播才知道这句话没有依据兜底
    expect(result.data.result.riskNotes.length).toBeGreaterThan(0);
    // 置信度用固定的低值，而不是模型自评的把握
    expect(result.data.result.confidence).toBe(INSUFFICIENT_LIVE_CONFIDENCE);
  });
});

/* ------------------------------------------------------------------ */
/* 营销 / 互动型评论：不检索、不冒充「有依据」                         */
/* ------------------------------------------------------------------ */

describe("直播导演 · 营销 / 互动型评论（任务书第十一节）", () => {
  it("夸赞类评论不触发检索，也不被标成「有知识依据」", async () => {
    await indexAllDocuments();

    const result = await run("老板讲得很实在，先关注了");
    if (!result.ok) {
      throw new Error("期望成功");
    }

    expect(result.data.preclassifiedIntent).toBe("praise");
    expect(result.data.retrieval.used).toBe(false);
    expect(result.data.result.grounded).toBe(false);
    expect(result.data.result.citations).toHaveLength(0);
  });

  it("异议类评论不检索，但不因「没有知识依据」而被压低置信度", async () => {
    await indexAllDocuments();

    const result = await run("感觉有点贵，能便宜点吗");
    if (!result.ok) {
      throw new Error("期望成功");
    }

    expect(result.data.retrieval.used).toBe(false);
    expect(result.data.result.grounded).toBe(false);
    expect(result.data.result.citations).toHaveLength(0);
    /**
     * S6-B §2.2：`grounded` 与 `confidence` 是两个概念。
     * 营销 / 转化型评论本来就不依赖知识库，它的 grounded=false 是正常状态 ——
     * 若照样压到 0.2，界面就会把一条站得住的营销建议标成「低可信」。
     * 这里断言它**保持模型给的值**（Mock 对营销型给 0.75）。
     */
    expect(result.data.result.confidence).toBeGreaterThan(
      INSUFFICIENT_LIVE_CONFIDENCE,
    );
    expect(result.data.result.confidence).toBe(0.75);
  });
});

/* ------------------------------------------------------------------ */
/* 引用校验（任务书第十三节 Case ③）                                   */
/* ------------------------------------------------------------------ */

describe("直播导演 · 引用校验", () => {
  it("模型编造检索结果里不存在的 chunkId 时，整条建议被拒绝", async () => {
    await indexAllDocuments();

    const result = await run("这个鲍鱼怎么保存？能放几天？", {
      provider: createMockAIProvider({ scenario: "fabricated-citation" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("伪造引用必须导致失败");
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.message).toContain("引用");
    // 错误详情要能指出是哪一个 id 编的，否则排查只能靠猜
    expect(result.error.detail).toContain("kchunk_fabricated");
  });

  it("被拒绝的建议不会产出任何引用（不存在「假引用被展示」的中间态）", async () => {
    await indexAllDocuments();

    const result = await run("这个鲍鱼怎么保存？能放几天？", {
      provider: createMockAIProvider({ scenario: "fabricated-citation" }),
    });
    expect(result.ok).toBe(false);
    expect("data" in result).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 承诺措辞兜底（任务书第十二节）                                      */
/* ------------------------------------------------------------------ */

describe("直播导演 · 承诺措辞兜底", () => {
  it("依据不足时话术含「明天一定能到」，会被换成保守模板并写明原因", async () => {
    await indexAllDocuments();

    const result = await run("今晚下单明天能到吗？", {
      provider: createStubProvider({
        intent: "logistics_question",
        priority: "high",
        shouldRespond: true,
        responseMode: "answer_now",
        hostSuggestion: "观众关心时效，建议主播正面回应。",
        suggestedReply: "放心，今天下单明天一定能到，绝对新鲜。",
        grounded: false,
        citations: [],
        recommendedAction: "clarify_logistics",
        riskNotes: ["卖点属于营销表达，不是认证事实。"],
        confidence: 0.9,
      }),
    });

    if (!result.ok) {
      throw new Error("期望成功");
    }

    expect(result.data.result.grounded).toBe(false);
    // 承诺措辞必须被替换掉 —— 不能靠模型「自觉」
    expect(result.data.result.suggestedReply).not.toContain("一定能到");
    expect(result.data.result.suggestedReply).not.toContain("绝对");
    expect(result.data.result.suggestedReply).toContain("客服");
    expect(
      result.data.result.riskNotes.some((note) => note.includes("保守表述")),
    ).toBe(true);
    expect(
      result.data.warnings.some((warning) => warning.includes("承诺措辞")),
    ).toBe(true);
  });

  it("有依据时话术不被改写（兜底只在依据不足时触发）", async () => {
    await indexAllDocuments();

    const result = await run("这个鲍鱼怎么保存？能放几天？");
    if (!result.ok) {
      throw new Error("期望成功");
    }
    expect(result.data.result.grounded).toBe(true);
    expect(
      result.data.warnings.some((warning) => warning.includes("承诺措辞")),
    ).toBe(false);
  });

  it("营销型评论的承诺措辞只做风险提示，不把整段话术换成客服话术", async () => {
    await indexAllDocuments();

    const reply = "我们家鲍鱼绝对比别家新鲜，品质有保证，放心拍。";
    const result = await run("感觉有点贵，别家比你们便宜", {
      provider: createStubProvider({
        intent: "objection",
        priority: "high",
        shouldRespond: true,
        responseMode: "answer_now",
        hostSuggestion: "这是价格异议，别直接反驳，转向产品价值点。",
        suggestedReply: reply,
        sellingAngle: "产地与鲜活度差异化",
        grounded: false,
        citations: [],
        recommendedAction: "reinforce_selling_point",
        riskNotes: ["卖点属于营销表达，不是认证事实。"],
        confidence: 0.8,
      }),
    });

    if (!result.ok) {
      throw new Error("期望成功");
    }

    // 营销话术保留原文 —— 换成「我去问客服」会跑题，且浪费模型给的切入点
    expect(result.data.result.suggestedReply).toBe(reply);
    // 但承诺措辞必须被点名，主播才知道哪句不能照说
    expect(
      result.data.result.riskNotes.some((note) => note.includes("承诺性措辞")),
    ).toBe(true);
    expect(
      result.data.warnings.some((warning) => warning.includes("不做整句替换")),
    ).toBe(true);
    // 卖点角度照常保留（模型确实给了）
    expect(result.data.result.sellingAngle).toBe("产地与鲜活度差异化");
  });
});

/* ------------------------------------------------------------------ */
/* 输入与失败路径                                                      */
/* ------------------------------------------------------------------ */

describe("直播导演 · 输入与失败路径", () => {
  it("空评论 / 超长评论直接拒绝，不浪费一次模型调用", async () => {
    const empty = await run("   ");
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe("VALIDATION_FAILED");
    }

    const tooLong = await run("鲍".repeat(501));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("缺少商家标识时拒绝，而不是放宽跨商家检索条件", async () => {
    const result = await run("鲍鱼怎么保存？", { businessId: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("检索层抛错时返回 DB_ERROR，而不是伪装成「知识库没有内容」", async () => {
    const product = await loadLiveProduct();
    const result = await runLiveAgent(
      { comment: "鲍鱼怎么保存？", businessId: BUSINESS_ID, product },
      {
        provider: createMockAIProvider(),
        search: async () => {
          throw new Error("connection reset by peer");
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DB_ERROR");
    }
  });
});

/* ------------------------------------------------------------------ */
/* S6-B §2.1：直播专用结构纠错预算                                     */
/* ------------------------------------------------------------------ */

/** 一份必然通过 `LiveDirectorResultSchema` 的合法营销型产出 */
const VALID_OBJECTION_PAYLOAD = {
  intent: "objection",
  priority: "high",
  shouldRespond: true,
  responseMode: "answer_now",
  hostSuggestion: "这是价格异议，别正面反驳，转向产品价值点。",
  suggestedReply: "我们家是当天现捞的，鲜活度是主要差别，您可以先看规格。",
  sellingAngle: "产地与鲜活度差异化",
  grounded: false,
  citations: [],
  recommendedAction: "handle_objection",
  riskNotes: ["卖点属于营销表达，不是认证事实。"],
  confidence: 0.8,
} as const;

/**
 * 一个「先坏几次、再变好」的 Provider。
 *
 * `badAttempts` 次返回**提取不出 JSON** 的脏文本（等价于模型没有按结构作答），
 * 之后返回合法产出。用来验证纠错预算到底用了几次。
 */
function createFlakyProvider(badAttempts: number): {
  provider: AIProvider;
  calls: () => number;
} {
  let calls = 0;
  const embedding = createMockAIProvider();
  const provider: AIProvider = {
    id: "flaky",
    async generateText() {
      calls += 1;
      if (calls <= badAttempts) {
        return "抱歉，我没法按那个格式回答。";
      }
      return JSON.stringify(VALID_OBJECTION_PAYLOAD);
    },
    async generateObject<T>(): Promise<T> {
      throw new Error("本场景不应调用 generateObject");
    },
    async streamText() {
      throw new Error("本场景不应调用 streamText");
    },
    async analyzeImage(): Promise<string> {
      throw new Error("本场景不应调用 analyzeImage");
    },
    embed: (input) => embedding.embed(input),
  };
  return { provider, calls: () => calls };
}

/** 一个**每次调用都失败**的 Provider，用于验证「失败不消耗结构纠错预算」 */
function createAlwaysFailingProvider(error: Error): {
  provider: AIProvider;
  calls: () => number;
} {
  let calls = 0;
  const embedding = createMockAIProvider();
  const provider: AIProvider = {
    id: "failing",
    async generateText(): Promise<string> {
      calls += 1;
      throw error;
    },
    async generateObject<T>(): Promise<T> {
      throw new Error("本场景不应调用 generateObject");
    },
    async streamText() {
      throw new Error("本场景不应调用 streamText");
    },
    async analyzeImage(): Promise<string> {
      throw new Error("本场景不应调用 analyzeImage");
    },
    embed: (input) => embedding.embed(input),
  };
  return { provider, calls: () => calls };
}

describe("直播导演 · 结构化输出的纠错预算（S6-B §2.1）", () => {
  // 用营销型评论：不触发检索，模型调用次数就是「结构化尝试次数」，读数干净
  const COMMENT = "感觉有点贵，别家比你们便宜";

  it("第一次就通过 → 只调 1 次模型", async () => {
    const flaky = createFlakyProvider(0);
    const result = await run(COMMENT, { provider: flaky.provider });
    if (!result.ok) {
      throw new Error("期望成功");
    }
    expect(flaky.calls()).toBe(1);
    expect(result.data.attempts).toBe(1);
    expect(result.data.repaired).toBe(false);
  });

  it("第一次结构失败、第二次成功 → 调 2 次", async () => {
    const flaky = createFlakyProvider(1);
    const result = await run(COMMENT, { provider: flaky.provider });
    if (!result.ok) {
      throw new Error("期望成功");
    }
    expect(flaky.calls()).toBe(2);
    expect(result.data.attempts).toBe(2);
    expect(result.data.repaired).toBe(true);
  });

  it("连续两次结构失败、第三次成功 → 调 3 次（直播预算上限）", async () => {
    const flaky = createFlakyProvider(2);
    const result = await run(COMMENT, { provider: flaky.provider });
    if (!result.ok) {
      throw new Error("期望成功");
    }
    expect(flaky.calls()).toBe(3);
    expect(result.data.attempts).toBe(3);
    expect(result.data.repaired).toBe(true);
  });

  it("三次都结构失败 → 停在 3 次，不无限重试", async () => {
    const flaky = createFlakyProvider(99);
    const result = await run(COMMENT, { provider: flaky.provider });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCHEMA_INVALID");
      // 错误文案要说明是「连续 N 次」，让排查者一眼看出预算用尽
      expect(result.error.message).toContain("3");
    }
    expect(flaky.calls()).toBe(3);
  });

  it("网络 / 鉴权 / 限流类失败不进入结构纠错 —— 只调 1 次", async () => {
    const cases: { label: string; error: Error }[] = [
      { label: "普通网络错误", error: new Error("fetch failed") },
      {
        label: "401 鉴权失败",
        error: new AppError({
          code: "MODEL_UNAVAILABLE",
          message: "模型服务鉴权失败",
          detail: "HTTP 401（模型 qwen-flash）：invalid_api_key",
        }),
      },
      {
        label: "429 限流",
        error: new AppError({
          code: "MODEL_UNAVAILABLE",
          message: "模型服务请求过于频繁",
          detail: "HTTP 429（模型 qwen-flash）：rate limit exceeded",
        }),
      },
      {
        label: "超时",
        error: new AppError({
          code: "MODEL_TIMEOUT",
          message: "模型响应超时",
          detail: "超过 90000ms 未返回",
        }),
      },
    ];

    for (const item of cases) {
      const failing = createAlwaysFailingProvider(item.error);
      const result = await run(COMMENT, { provider: failing.provider });
      expect(result.ok, `${item.label}应失败`).toBe(false);
      expect(failing.calls(), `${item.label}不得重试`).toBe(1);
    }
  });
});

/* ------------------------------------------------------------------ */
/* S6-B §2.2：confidence 与 grounded 解耦                              */
/* ------------------------------------------------------------------ */

describe("直播导演 · confidence 语义（S6-B §2.2）", () => {
  it("事实型意图拿不到依据 → 置信度压到低值（AI 确实没把握）", async () => {
    await indexAllDocuments();

    const result = await run("今晚下单明天能到吗？");
    if (!result.ok) {
      throw new Error("期望成功");
    }
    expect(result.data.result.grounded).toBe(false);
    expect(result.data.result.confidence).toBe(INSUFFICIENT_LIVE_CONFIDENCE);
  });

  it("事实型意图有依据 → 保留模型自评置信度，不被压低", async () => {
    await indexAllDocuments();

    const result = await run("这个鲍鱼怎么保存？能放几天？");
    if (!result.ok) {
      throw new Error("期望成功");
    }
    expect(result.data.result.grounded).toBe(true);
    expect(result.data.result.confidence).toBe(0.8);
  });

  it("营销 / 转化型意图 grounded=false 是正常状态 → 保留模型自评置信度", async () => {
    await indexAllDocuments();

    // Mock 对营销型给 0.75；关键断言是「没有被打成 0.2」
    for (const comment of [
      "感觉有点贵，能便宜点吗",
      "我要两斤，怎么下单",
      "老板讲得很实在，先关注了",
    ]) {
      const result = await run(comment);
      if (!result.ok) {
        throw new Error(`期望成功：${comment}`);
      }
      expect(result.data.result.grounded, comment).toBe(false);
      expect(result.data.result.confidence, comment).toBe(0.75);
    }
  });

  it("用桩 Provider 验证：营销型评论的 0.9 不会被改写成 0.2", async () => {
    await indexAllDocuments();

    const result = await run("感觉有点贵，别家比你们便宜", {
      provider: createStubProvider({
        ...VALID_OBJECTION_PAYLOAD,
        confidence: 0.9,
      }),
    });
    if (!result.ok) {
      throw new Error("期望成功");
    }
    expect(result.data.result.confidence).toBe(0.9);
  });
});
