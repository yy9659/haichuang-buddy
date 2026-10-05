/**
 * 智能客服问答闭环服务（S5 · 任务书第十八 / 二十一节）
 *
 * 这是「RAG 智能客服」从**能被调用**变成**能被使用**的那一层：
 * 消费者提问 → 跑客服 Agent（检索 + 生成 + 引用校验）→ 依据不足时记一条知识缺口 → 返回回答。
 *
 * 三层职责在这里合流，但顺序不能乱：
 *
 *   1. 检索 / 模型失败  → **整体失败**，原样返回错误，**不记缺口**（见下）
 *   2. 检索正常但依据不足 → 安全回答「已转人工」+ 记一条缺口
 *   3. 依据充分        → 正常回答，**不记缺口**（哪怕模型建议转人工）
 *
 * ## 为什么不能「只要没答上来就记缺口」
 *
 * 任务书第十节划了三条界线，本文件全部靠 `runCustomerServiceAgent` 的返回值把关：
 *
 * - **模型超时 / 不可用**（`MODEL_TIMEOUT` / `MODEL_UNAVAILABLE`）：这是系统故障。
 *   把它记成「知识库里没有答案」，商家会去补一份根本不缺的知识，
 *   而真正的问题（模型通道挂了）被埋在缺口列表里。
 * - **检索层报错**（`DB_ERROR`）：同理，这是数据库问题，不是知识问题。
 * - **消费者输入本身非法**（空问题、超长）：不是「缺什么知识」。
 *
 * 这三个分支在 Agent 里都是 `error`，而「知识库里确实没有」是 `ok` + `grounded=false`。
 * 本文件只在**后者**记录缺口 —— 判断依据是 `run.ok && needsKnowledgeGap`，
 * 而不是「answer 里有没有转人工」。
 *
 * 一个容易写错的细节：`needsHuman=true` 但 `grounded=true`（模型依据充分、
 * 只是建议人工跟进）**不记缺口**。Agent 已经用 `needsKnowledgeGap = false` 表达了这一点，
 * 服务层若自己去看 `needsHuman`，就会给一个知识库完全覆盖的问题平白建一条缺口。
 *
 * ## 为什么缺口写失败不能让整个回答失败
 *
 * 缺口是**经营分析的副作用**：它的目的是告诉商家「该补什么知识」，
 * 而消费者此刻要的是「我能不能得到一句安全的答复」。若因为写缺口失败就把
 * 已经生成的、判定为安全的转人工回答变成 500，等于让一个分析需求伤害了用户体验 ——
 * 而且这个失败还发生在**最需要兜底的时刻**（知识库答不上来的时候）。
 * 因此这里降级为告警：回答照常返回，`warningCodes` 里留下
 * `knowledge_gap_record_failed`，服务端日志留一条，供排查。
 *
 * ## `agent_tasks` 从 Task 80 起真正落库
 *
 * 在此之前这里刻意不写任务记录：客服问答属于「会话闭环」，要和消息落库一起设计，
 * 否则会出现「任务记录里有这次问答、会话里却没有这条消息」的半截状态。
 * Task 80 把会话与消息接上之后，记录条件就具备了，于是补上这里：
 *
 * - **input 只放可公开的调用参数**：`conversationId` / `productId` / `questionHash`。
 *   消费者原话已经完整存在 `customer_messages` 里，再往任务表复制一份
 *   等于把同一份可能含个人信息的文本散到第二个地方（任务书第十五节）。
 *   想定位「这条任务对应哪次提问」，用指纹即可。
 * - **`grounded=false` 不等于任务失败。** Agent 正确识别出「依据不足、建议转人工」，
 *   本身就是一次成功的执行 —— 把它记成 failed，监控上就会出现一条永远降不下去的
 *   客服失败率，而它其实每天都在正常工作。只有模型超时、检索层报错这类
 *   **没能跑完的**执行才是 failed（任务书第十七节）。
 * - **任务记录写失败不影响回答。** 理由与知识缺口一样：这是一次观测动作，
 *   消费者此刻要的是一句安全的答复。降级为 `agent_task_record_failed` 告警。
 */

import {
  getRepositories,
  type Repositories,
  type UpdateAgentTaskInput,
} from "@/repositories";
import type { KnowledgeChunkSearchHit, KnowledgeSearchParams } from "@/repositories/types";
import {
  runCustomerServiceAgent,
  type CustomerServiceAgentRunResult,
} from "@/ai/agents/customer-service-agent";
import type { AIProvider } from "@/ai/provider/types";
import { sha256Hex } from "@/lib/hash";
import { normalizeKnowledgeGapQuestion } from "@/rag/knowledge-gap";
import { attempt, ok, toAppError, type Result } from "@/lib/result";
import type { AgentId, CustomerServiceAnswer } from "@/types";

import {
  recordKnowledgeGap,
  toKnowledgeGapSummary,
  type KnowledgeGapSummary,
} from "./knowledge-gap.service";

/**
 * 写入 `agent_tasks.agent_type` 的取值。
 * 与 `CUSTOMER_SERVICE_AGENT_ID`（"customer-service-agent"）不是同一个字符串：
 * 前者是数据库枚举值，后者是 Agent 的运行时标识，这里显式声明避免写错。
 */
export const CUSTOMER_SERVICE_AGENT_TYPE: AgentId = "customer_service_agent";

/** Agent 任务标题。**刻意不含问题原文** —— 见文件头关于 input 的说明 */
const AGENT_TASK_TITLE = "客服会话问答";

/**
 * 收口任务记录。
 *
 * **刻意不把写失败上抛**：一次问答的结论已经确定（要么答上了，要么是系统故障），
 * 任务记录写不进去只说明观测数据缺了一条，不该让消费者的问题变成错误页 ——
 * 这与知识缺口记录失败的降级理由是同一个（见文件头）。
 * `taskId` 为 null（创建就没成功）时直接跳过，调用方无需再判一次。
 */
async function closeAgentTask(
  repositories: Repositories,
  taskId: string | null,
  patch: UpdateAgentTaskInput,
): Promise<boolean> {
  if (taskId === null) {
    return false;
  }
  const updated = await attempt(
    () => repositories.agentTasks.update(taskId, patch),
    (cause) => toAppError(cause, "DB_ERROR", "更新客服问答任务失败"),
  );
  if (!updated.ok) {
    console.warn(
      `[customer-service] 任务记录更新失败 taskId=${taskId}：${updated.error.message}`,
    );
    return false;
  }
  return true;
}

/**
 * 一次提问的稳定指纹，写进 `agent_tasks.input.questionHash`。
 *
 * 先规范化再哈希（复用知识缺口那一份 `normalizeQuestion`），而不是直接哈希原话：
 * 同一个问题在两次提问里可能只差一个标点或一个「请问」，原话哈希会得到两个指纹，
 * 「这两条任务是不是同一类问题」就查不出来了 —— 而日志的价值恰恰在这里。
 * 规范化后为空（用户只发了「？」）时退回原话的 trim 结果，
 * 保证任何输入都有指纹，不会产出「一个恒定的空哈希」。
 *
 * 哈希原语来自 `@/lib/hash`：项目里只有这一个 SHA 实现，
 * 免得缺口表与任务表对同一个问题算出两个指纹。
 */
export function buildQuestionHash(question: string): string {
  const normalized = normalizeKnowledgeGapQuestion(question);
  return sha256Hex(normalized.length > 0 ? normalized : question.trim());
}

export interface AnswerCustomerQuestionInput {
  /** 消费者原话 */
  question: string;
  /** **必填**：跨商家检索不可接受 */
  businessId: string;
  /** 会话关联的商品；缺口会按它隔离（不传 = 全店级问题，如物流 / 售后） */
  productId?: string | null;
  /**
   * 本次问答所属的客服会话。
   * 从会话闭环（`sendCustomerMessage`）调用时必传，会写进 `agent_tasks.input`；
   * 独立调用（测试、单点问答）留空 —— 任务记录仍会写，只是没有会话归属。
   */
  conversationId?: string | null;
  /** 最近的历史对话，用于理解指代 */
  history?: readonly string[];
  signal?: AbortSignal;
}

/**
 * 机器可读的告警码。
 *
 * 为什么要有它：`warnings` 是给商家看的中文说明，文案会改、会翻译；
 * 而调用方（Server Action、测试、将来的监控）需要的是一个**稳定标识**。
 * 用「解析中文字符串」来判断发生了什么，是这类代码最经典的脆弱点。
 */
export type CustomerServiceWarningCode =
  | "knowledge_gap_record_failed"
  | "knowledge_gap_skipped_empty_question"
  | "agent_task_record_failed";

export interface AnswerCustomerQuestionOptions {
  /** 注入 Provider（测试用）；默认取 `getAIProvider()` */
  provider?: AIProvider;
  /**
   * 向量检索实现。默认走仓储（与生产路径一致）；
   * 测试注入它来模拟「检索层报错」这类无法用种子数据造出的场景。
   */
  search?: (params: KnowledgeSearchParams) => Promise<KnowledgeChunkSearchHit[]>;
  /** 由经营大脑触发时关联到对应工作流；独立客服对话保持为空 */
  workflowId?: string | null;
  signal?: AbortSignal;
}

export interface CustomerServiceAnswerResult {
  /** 领域回答（含 grounded / citations / needsHuman / knowledgeGap 说明） */
  answer: CustomerServiceAnswer;
  providerId: string;
  /** 调用模型的次数（含纠错重试） */
  attempts: number;
  /** 是否经过纠错重试才通过校验 */
  repaired: boolean;
  /**
   * 本次记录到的缺口；未记录时为 null。
   * 带上 `occurrenceCount` 是为了让界面能说清「这个问题已经是第 3 次被问到了」——
   * 只给一个 id，商家无法判断该不该优先处理。
   */
  knowledgeGap: KnowledgeGapSummary | null;
  warningCodes: CustomerServiceWarningCode[];
  warnings: string[];
}

/**
 * 默认检索：直接走仓储。
 *
 * Agent 的契约要求「检索实现必须来自仓储」（它不认识数据库），
 * 这里就是把它接上的那一处。
 */
function searchKnowledge(
  params: KnowledgeSearchParams,
): Promise<KnowledgeChunkSearchHit[]> {
  return getRepositories().knowledgeChunks.searchSimilar(params);
}

export async function answerCustomerQuestion(
  input: AnswerCustomerQuestionInput,
  options: AnswerCustomerQuestionOptions = {},
): Promise<Result<CustomerServiceAnswerResult>> {
  const search = options.search ?? searchKnowledge;
  const repositories = getRepositories();
  const startedAt = Date.now();

  /** 预先记下告警（会话闭环侧的降级提示会从这里开始累积） */
  const warnings: string[] = [];
  const warningCodes: CustomerServiceWarningCode[] = [];

  /**
   * ⓪ 先建任务记录（running）再跑 Agent。
   *
   * 顺序不能反：`durationMs` 要覆盖整段检索 + 生成，先跑完再建任务就只能拍一个假耗时；
   * 而且 Agent 失败时也应当留下一条 failed 记录，先建后跑才拿得到那个 id。
   *
   * 建失败**不影响回答**：与任务更新失败同理，这是一次观测动作。
   */
  const questionHash = buildQuestionHash(input.question);
  const createdTask = await attempt(
    () =>
      repositories.agentTasks.create({
        agentType: CUSTOMER_SERVICE_AGENT_TYPE,
        title: AGENT_TASK_TITLE,
        workflowId: options.workflowId ?? null,
        /**
         * 任务归属商品：会话如果绑定了商品就记，否则为空（全店级问题如物流 / 售后）。
         * 填它是为了让商品被删除时相关任务能被级联清理，顺带能按商品筛客服记录。
         */
        productId: input.productId ?? null,
        status: "running",
        progress: 10,
        input: {
          conversationId: input.conversationId ?? null,
          productId: input.productId ?? null,
          questionHash,
        },
      }),
    (cause) => toAppError(cause, "DB_ERROR", "创建客服问答任务失败"),
  );

  let taskId: string | null = null;
  if (!createdTask.ok) {
    warningCodes.push("agent_task_record_failed");
    warnings.push(`客服问答任务记录未能创建：${createdTask.error.message}`);
    console.warn(
      `[customer-service] 任务记录创建失败 businessId=${input.businessId}：${createdTask.error.message}`,
    );
  } else {
    taskId = createdTask.data.id;
  }

  /** ① 跑 Agent。它的失败是系统故障，直接透传，绝不在这里记缺口 */
  const run = await runCustomerServiceAgent(
    {
      question: input.question,
      businessId: input.businessId,
      productId: input.productId ?? null,
      ...(input.history ? { history: input.history } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    {
      ...(options.provider ? { provider: options.provider } : {}),
      search,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  const durationMs = Date.now() - startedAt;

  /**
   * ①' 模型 / 检索失败 → 任务记 failed。
   *
   * 这里与「知识库答不上来」是**两件不同的事**（任务书第十七节）：
   * 前者是「没能跑完」，后者是「跑完了、并且正确地判断出依据不足」。
   * 把后者也记成 failed，监控上会挂一条永远降不下去的客服失败率，
   * 而它其实每天都在正常工作。
   */
  if (!run.ok) {
    const detail = run.error.detail ? `（${run.error.detail}）` : "";
    const closed = await closeAgentTask(repositories, taskId, {
      status: "failed",
      durationMs,
      errorMessage: `${run.error.message}${detail}`,
    });
    if (!closed && taskId !== null) {
      warnings.push("客服问答任务记录未能标记为失败，请从服务端日志排查。");
    }
    return { ok: false, error: run.error };
  }

  const agent: CustomerServiceAgentRunResult = run.data;
  warnings.push(...agent.warnings);

  /** ② 依据充分（或意图为 other）→ 没有「缺什么知识」这回事，直接返回 */
  if (!agent.needsKnowledgeGap) {
    await closeAgentTask(repositories, taskId, {
      status: "completed",
      progress: 100,
      durationMs,
      output: {
        intent: agent.answer.intent,
        grounded: agent.answer.grounded,
        needsHuman: agent.answer.needsHuman,
        retrievedChunkCount: agent.retrieval.retrievedCount,
        citationCount: agent.answer.citations.length,
        knowledgeGapId: null,
        warningCodes,
      },
    });
    return ok({
      answer: agent.answer,
      providerId: agent.providerId,
      attempts: agent.attempts,
      repaired: agent.repaired,
      knowledgeGap: null,
      warningCodes,
      warnings,
    });
  }

  /**
   * ③ 记录缺口。
   *
   * `answer.knowledgeGap` 是 Agent 给的**面向商家的缺什么说明**（按意图兜底后的文案），
   * 它正是缺口面板要展示的那句话，直接沿用 —— 服务层另写一段只会与回答里的说明不一致。
   *
   * 这里**不再包一层 `attempt`**：`recordKnowledgeGap` 自己已经返回 `Result`，
   * 它内部才是真正需要 try/catch 的那一层（仓储调用）。再包一次只会得到
   * `Result<Result<…>>`，让「哪一层才有 data」变成需要读三遍才能确认的东西。
   */
  const recorded = await recordKnowledgeGap({
    businessId: input.businessId,
    productId: input.productId ?? null,
    question: input.question.trim(),
    intent: agent.answer.intent,
    reason: agent.answer.knowledgeGap ?? "",
  });

  let knowledgeGap: KnowledgeGapSummary | null = null;

  if (!recorded.ok) {
    /**
     * 缺口写失败**不改判**这次问答：消费者已经拿到一句安全的「已转人工」，
     * 那句话是对的，不该因为一条分析记录没落库而变成错误页。
     */
    warningCodes.push("knowledge_gap_record_failed");
    warnings.push(
      `知识缺口未能记录：${recorded.error.message}${
        recorded.error.detail ? `（${recorded.error.detail}）` : ""
      }`,
    );
    console.warn(
      `[customer-service] 知识缺口记录失败 businessId=${input.businessId}：${recorded.error.message}`,
    );
  } else if (recorded.data === null) {
    // 规范化后为空（只发了「？」这类）—— 刻意没有记录，不是错误
    warningCodes.push("knowledge_gap_skipped_empty_question");
    warnings.push(
      "该提问规范化后没有可聚合的内容（例如只发了标点），已跳过知识缺口记录。",
    );
  } else {
    knowledgeGap = toKnowledgeGapSummary(recorded.data);
  }

  /**
   * ④ 收口任务：**依据不足仍记 completed**。
   *
   * Agent 完整跑完了检索与生成，并且正确判断出「知识库里没有覆盖」——
   * 这是一次成功的执行，它的产出（一条缺口）正是系统该有的行为。
   * 缺口的 id 此刻才确定，因此 output 快照放在这里才写。
   */
  await closeAgentTask(repositories, taskId, {
    status: "completed",
    progress: 100,
    durationMs,
    output: {
      intent: agent.answer.intent,
      grounded: agent.answer.grounded,
      needsHuman: agent.answer.needsHuman,
      retrievedChunkCount: agent.retrieval.retrievedCount,
      citationCount: agent.answer.citations.length,
      knowledgeGapId: knowledgeGap?.id ?? null,
      warningCodes,
    },
  });

  return ok({
    answer: agent.answer,
    providerId: agent.providerId,
    attempts: agent.attempts,
    repaired: agent.repaired,
    knowledgeGap,
    warningCodes,
    warnings,
  });
}
