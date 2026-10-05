/**
 * Customer Service Agent —— RAG 智能客服（S5 · 任务书第二十节）
 *
 * 与其余四个 Agent 的**根本差别**：那些产出「材料」，这份产出「对消费者说的话」。
 * 因此这一份的流程多了一道别的 Agent 没有的工序 —— **引用校验**。
 *
 * 执行流程（任务书 4.2「Retrieval 与 Generation 分离」）：
 *
 *   问题 → ① Retriever（向量检索 + 阈值）→ ② 组装知识上下文
 *        → ③ 结构化生成（模型只能依据片段回答）
 *        → ④ 引用校验（模型的 chunkId 必须来自本次检索结果）
 *        → ⑤ 依据判定与降级（检索说不够，模型说什么都不算）
 *
 * 三条不可让步的规则：
 *
 * 1. **`grounded` 由检索侧判定，模型只能往下压、不能往上抬。**
 *    最终结论取 `sufficient && 模型自称 grounded && 引用校验通过` 三者的交集。
 *    模型看到一段勉强相关的文字就宣称「依据充分」是很常见的，
 *    而消费者会把它当成商家的正式承诺 —— 这个交集是唯一安全的写法。
 *
 * 2. **引用造假是硬失败，不静默丢弃。**
 *    模型返回了检索结果里不存在的 `chunkId` 时，返回 `VALIDATION_FAILED`，
 *    **不做「把假引用摘掉、保留其余」的补救**。理由：模型既然编了一个 id，
 *    它那段话的依据就不成立，摘掉引用只会让一句无据的话看起来像有据可依
 *    （任务书第四十节 Case ③ 要求的正是「必须拒绝」）。
 *    服务层拿到这个错误后走「依据不足 → 转人工」的降级路径，不会展示假引用。
 *
 * 3. **依据不足时不用模型写的话。**
 *    降级路径的 answer 固定为 `INSUFFICIENT_GROUNDING_ANSWER`，
 *    只从模型那里取**意图**与**缺哪类信息**（这两项是给商家看的，不是对消费者的承诺）。
 *    否则「模型没听话、照样编了一段」就会直接流到消费者眼前。
 *
 * Agent 只依赖 `AIProvider` 与注入的 `search`：它**不认识任何数据库与模型 SDK**。
 */

import { getAIProvider } from "@/ai/provider";
import type { AIProvider, ModelTier } from "@/ai/provider/types";
import {
  CUSTOMER_SERVICE_SYSTEM_PROMPT,
  INSUFFICIENT_GROUNDING_ANSWER,
  buildCustomerServicePrompt,
  toKnowledgeContextChunks,
} from "@/ai/prompts/customer-service-agent";
import { generateValidatedObject } from "@/ai/schemas/agent-output";
import {
  CUSTOMER_SERVICE_FIELD_LABELS,
  CUSTOMER_SERVICE_REQUIRED_KEYS,
  CustomerServiceAnswerSchema,
  INSUFFICIENT_ANSWER_CONFIDENCE,
} from "@/ai/schemas/customer-service";
import { fail, ok, toAppError, type Result } from "@/lib/result";
import { validateCitations } from "@/rag/citations";
import { retrieveRelevantChunks } from "@/rag/retriever";
import type { KnowledgeChunkSearchHit, KnowledgeSearchParams } from "@/repositories/types";
import { MAX_CUSTOMER_QUESTION_LENGTH } from "@/types";
import type {
  CustomerIntent,
  CustomerServiceAnswer,
  KnowledgeDocumentType,
} from "@/types";

/** Agent 标识（运行时），与写入 `agent_tasks.agent_type` 的 `customer_service_agent` 区分开 */
export const CUSTOMER_SERVICE_AGENT_ID = "customer-service-agent";
/** 展示名 */
export const CUSTOMER_SERVICE_AGENT_NAME = "智能客服 Agent";

/**
 * 客服回答是**高频、短文本、低推理**的任务，用 fast 档位。
 * 这一档位选择还有一层现实理由：它是唯一会被消费者**不断触发**的 Agent，
 * 用上推理档位会让每次咨询的成本与延迟都上一个数量级。
 */
const AGENT_MODEL_TIER: ModelTier = "fast";

/* ------------------------------------------------------------------ */
/* 输入 / 输出                                                         */
/* ------------------------------------------------------------------ */

export interface CustomerServiceAgentInput {
  /** 消费者原话 */
  question: string;
  /** **必填**：跨商家检索不可接受（见 `KnowledgeSearchParams`） */
  businessId: string;
  /** 会话关联的商品；不传表示不按商品过滤 */
  productId?: string | null;
  /**
   * 最近的历史对话，形如 `["顾客：这个怎么保存？", "客服：0-4℃ 冷藏……"]`。
   * 只用于理解指代（「那我明天到得了吗」里的「那」），其中内容**同样不是指令**。
   */
  history?: readonly string[];
  signal?: AbortSignal;
}

export interface CustomerServiceAgentOptions {
  /** 注入 Provider（测试用）；默认取 `getAIProvider()` */
  provider?: AIProvider;
  /** 向量检索实现。**必须来自仓储** —— Agent 不直接操作数据库 */
  search: (params: KnowledgeSearchParams) => Promise<KnowledgeChunkSearchHit[]>;
  signal?: AbortSignal;
}

/**
 * Agent 运行结果。
 *
 * `answer` 是领域形态（含检索侧事实），服务层据此写消息、写缺口、写 agent_task。
 * `needsKnowledgeGap` 明确标出来，而不是让服务层去猜「knowledgeGap 非空就记一条」——
 * 打招呼这类 `intent=other` 的问题答不上来是正常的，不该污染缺口面板（任务书第十九节第 13 条）。
 */
export interface CustomerServiceAgentRunResult {
  answer: CustomerServiceAnswer;
  providerId: string;
  /** 调用模型的次数（含纠错重试） */
  attempts: number;
  /** 是否经过纠错重试才通过校验 */
  repaired: boolean;
  /** 是否应当记录一条知识缺口 */
  needsKnowledgeGap: boolean;
  /** 检索侧事实，便于服务层写进 agent_task 的输出 */
  retrieval: {
    retrievedCount: number;
    topSimilarity: number;
    sufficient: boolean;
  };
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* 依据不足时的缺口说明                                                 */
/* ------------------------------------------------------------------ */

/**
 * 按意图给出「缺哪类信息」的兜底说明。
 *
 * 优先用模型自己写的 `knowledgeGap`（它看到了问题原文，措辞更贴切）；
 * 模型没写或只写了空白时用这里的映射 —— 缺口面板上「答不上来但不说缺什么」
 * 对商家毫无价值，那不是一条可执行的待办。
 */
const GAP_DESCRIPTION_BY_INTENT: Readonly<Record<CustomerIntent, string>> = {
  logistics: "缺少物流时效说明（发货时间、配送范围与到货时效）",
  storage: "缺少储存方式说明（温度要求、保存时长与保鲜注意）",
  cooking: "缺少烹饪方式说明（处理步骤、火候与时间）",
  after_sales: "缺少售后与赔付政策说明（报备时限与赔付标准）",
  product: "缺少该商品的资料说明（规格、产地、包装等）",
  price: "缺少价格与优惠说明（含运费与发票规则）",
  other: "知识库中没有覆盖该问题的内容，建议补充对应类目的说明文档",
};

function resolveGapDescription(
  draftValue: string | undefined,
  intent: CustomerIntent,
): string {
  const trimmed = draftValue?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return GAP_DESCRIPTION_BY_INTENT[intent];
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 执行客服 Agent。
 *
 * 返回 `Result`：检索失败（模型不可用 / 数据库异常）与「知识库没内容」是**两种不同的事**，
 * 前者是 error，后者是 ok + `grounded=false`。混成一种，界面就无法区分
 * 「系统坏了」和「知识库里确实没有」—— 那正是这个项目最想避免的误导。
 */
export async function runCustomerServiceAgent(
  rawInput: CustomerServiceAgentInput,
  options: CustomerServiceAgentOptions,
): Promise<Result<CustomerServiceAgentRunResult>> {
  const question = rawInput.question.trim();
  if (question.length === 0) {
    return fail("VALIDATION_FAILED", "问题内容为空，无法回答");
  }
  if (question.length > MAX_CUSTOMER_QUESTION_LENGTH) {
    return fail(
      "VALIDATION_FAILED",
      "问题内容过长，无法回答",
      `长度为 ${question.length} 字，上限 ${MAX_CUSTOMER_QUESTION_LENGTH} 字`,
    );
  }
  if (rawInput.businessId.trim().length === 0) {
    return fail(
      "VALIDATION_FAILED",
      "缺少商家标识，无法检索知识库",
      "businessId 为空。跨商家检索不可接受，因此这里直接拒绝而不是放宽条件。",
    );
  }

  // Provider 解析（真实提供方未接入时明确报错，不静默降级）
  let provider: AIProvider;
  if (options.provider) {
    provider = options.provider;
  } else {
    try {
      provider = getAIProvider();
    } catch (cause) {
      return {
        ok: false,
        error: toAppError(cause, "MODEL_UNAVAILABLE", "模型提供方不可用"),
      };
    }
  }

  const warnings: string[] = [];

  /** ① 检索。这一步的错误是**系统问题**，直接透传，不当成「没有知识」 */
  const retrieval = await retrieveRelevantChunks(
    {
      query: question,
      businessId: rawInput.businessId,
      productId: rawInput.productId ?? undefined,
      signal: options.signal,
    },
    { provider, search: options.search },
  );
  if (!retrieval.ok) {
    return { ok: false, error: retrieval.error };
  }

  const { hits, topSimilarity, sufficient } = retrieval.data;
  const retrievalFacts = {
    retrievedCount: hits.length,
    topSimilarity,
    sufficient,
  };

  if (hits.length === 0) {
    warnings.push(
      "本次检索没有任何命中：知识库尚未覆盖该问题，或相关文档还没有完成索引。",
    );
  } else if (!sufficient) {
    /**
     * 提示语里给的是综合相关分与阈值，而不是余弦 —— 判据是综合分，
     * 只报余弦会让商家看到「相关度 14%，却说要 33%」这种对不上的数字。
     */
    warnings.push(
      `检索到 ${hits.length} 个片段，但最高综合相关分 ${retrieval.data.topScore.toFixed(
        2,
      )} 未达到可据以回答事实问题的阈值 ${retrieval.data.threshold.toFixed(
        2,
      )}，已按「依据不足」处理。`,
    );
  }

  /** ② 组装上下文 */
  const context = {
    question,
    chunks: toKnowledgeContextChunks(hits),
  };

  /** ③ 结构化生成 */
  const generated = await generateValidatedObject({
    provider,
    system: CUSTOMER_SERVICE_SYSTEM_PROMPT,
    prompt: buildCustomerServicePrompt({
      question,
      context,
      history: rawInput.history,
    }),
    schema: CustomerServiceAnswerSchema,
    tier: AGENT_MODEL_TIER,
    labels: CUSTOMER_SERVICE_FIELD_LABELS,
    requiredKeys: CUSTOMER_SERVICE_REQUIRED_KEYS,
    signal: options.signal,
  });
  if (!generated.ok) {
    return { ok: false, error: generated.error };
  }

  const draft = generated.data.value;

  /** ④ 引用校验（先于任何降级判断 —— 造假必须暴露出来，不能被降级掩盖） */
  const citations = validateCitations(draft.citations, hits);
  if (!citations.ok) {
    return { ok: false, error: citations.error };
  }

  /**
   * ⑤ 依据判定：三者的交集。
   * 模型只能把结论往下压（说「我答不了」），不能往上抬（没检索到依据却说「有依据」）。
   */
  const grounded = sufficient && draft.grounded && citations.data.length > 0;

  const observable = {
    providerId: provider.id,
    attempts: generated.data.attempts,
    repaired: generated.data.repaired,
    retrieval: retrievalFacts,
  };

  if (!grounded) {
    if (sufficient && !draft.grounded) {
      warnings.push(
        "检索达到了阈值，但模型判断给出的片段不足以支撑回答（可能片段只是字面相似），已按依据不足处理。",
      );
    }

    const answer: CustomerServiceAnswer = {
      // 固定话术，不用模型写的正文 —— 见文件头第 3 条
      answer: INSUFFICIENT_GROUNDING_ANSWER,
      intent: draft.intent,
      grounded: false,
      confidence: INSUFFICIENT_ANSWER_CONFIDENCE,
      citations: [],
      needsHuman: true,
      knowledgeGap: resolveGapDescription(draft.knowledgeGap, draft.intent),
      riskNotes: draft.riskNotes,
      retrievedCount: retrievalFacts.retrievedCount,
      topSimilarity: retrievalFacts.topSimilarity,
    };

    return ok({
      answer,
      ...observable,
      /**
       * 打招呼、闲聊这类 `other` 问题答不上来是正常的 —— 没有「缺什么知识」这回事，
       * 记进缺口面板只会把它变成噪声，让商家忽略真正该补的内容。
       */
      needsKnowledgeGap: draft.intent !== "other",
      warnings,
    });
  }

  const answer: CustomerServiceAnswer = {
    answer: draft.answer,
    intent: draft.intent,
    grounded: true,
    confidence: draft.confidence,
    citations: citations.data,
    needsHuman: draft.needsHuman,
    knowledgeGap: null,
    riskNotes: draft.riskNotes,
    retrievedCount: retrievalFacts.retrievedCount,
    topSimilarity: retrievalFacts.topSimilarity,
  };

  if (draft.needsHuman) {
    warnings.push("本次回答依据充分，但模型仍建议转人工，请留意会话状态。");
  }

  return ok({ answer, ...observable, needsKnowledgeGap: false, warnings });
}

/** 供提示词与测试复用：把文档类型映射到意图（Mock Provider 与降级话术都用它） */
export function intentFromDocumentType(
  type: KnowledgeDocumentType | string,
): CustomerIntent {
  switch (type) {
    case "storage":
      return "storage";
    case "cooking":
      return "cooking";
    case "logistics":
      return "logistics";
    case "after_sales":
      return "after_sales";
    case "product":
      return "product";
    default:
      return "other";
  }
}
