/**
 * 知识缺口业务 Service（S5 · 任务书第十八 / 二十二节）
 *
 * 这一层存在的意义不是「包一层仓储」，而是把三条**业务判断**从两边挡开：
 *
 * 1. **什么算一次「缺口」。** 「只发了「？」」「打招呼」「模型超时」都不是知识缺失，
 *    不该进入面板。判定散落在调用点，早晚会有人在某个新入口漏掉一条。
 * 2. **聚合身份怎么算。** 规范化与哈希都在 `src/rag/knowledge-gap.ts`，
 *    调用方只需给「商家 + 商品 + 问题原文」，不必知道键的存在。
 * 3. **状态语义。** resolved 被再次问到要重开、ignored 只累加计数不重开 ——
 *    这两条是**产品决策**，写在仓储实现里会让两套数据源各自解释一遍。
 *
 * 服务层统一返回 `Result`，不抛异常：缺口的写入是**经营分析的副作用**，
 * 调用方（客服问答）必须能在它失败时继续把安全回答交给消费者。
 */

import { normalizeKnowledgeGapQuestion } from "@/rag/knowledge-gap";
import { attempt, fail, ok, toAppError, type Result } from "@/lib/result";
import { getRepositories } from "@/repositories";
import type { CustomerIntent, KnowledgeGapRecord, KnowledgeGapStatus } from "@/types";

export interface RecordKnowledgeGapInput {
  /** 商家 id。跨商家聚合不可接受，因此必填 */
  businessId: string;
  /**
   * 商品级缺口带上商品 id；物流 / 售后这类**全店政策**问题传 null。
   * 这个字段直接参与聚合身份：「鲍鱼怎么保存」与「鱼丸怎么保存」必须分成两条。
   */
  productId?: string | null;
  /** 消费者原话（最近一次的那句） */
  question: string;
  /** 归一化意图；`other` 调用方应当自行过滤 —— 那类问题「缺知识」不成立 */
  intent: CustomerIntent;
  /** 为什么答不上来（面向商家的说明），不能为空 */
  reason: string;
}

/**
 * 一条缺口的精简形态。
 *
 * 客服回答只需要回显「记下了，这是第几次」，不必把整条记录塞进答案对象 ——
 * 答案是要交给消费者界面的，多带一个 `businessId` 之类的字段只会增加泄漏面。
 */
export interface KnowledgeGapSummary {
  id: string;
  status: KnowledgeGapStatus;
  occurrenceCount: number;
}

export interface ListKnowledgeGapsInput {
  status?: KnowledgeGapStatus;
  limit?: number;
}

function requireNonEmpty(value: string, label: string, detail: string): Result<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fail("VALIDATION_FAILED", `记录知识缺口失败：${label}`, detail);
  }
  return ok(trimmed);
}

/**
 * 记录一次「答不上来」。
 *
 * 返回 `ok(null)` 表示**刻意没有记录**，而不是失败：问题原文规范化后为空
 * （消费者只发了「？」「。。。」）时不构成一条可聚合的缺口。
 * 拿空串当键会把所有无意义提问聚成一条，把真正高频的问题挤下去 ——
 * 所以这里必须显式返回「什么都没发生」，而不是让仓储去撞那个校验。
 *
 * 除此之外的失败都是**真错误**（入参非法、数据库不可用），
 * 调用方应当降级处理（见 `customer-service-agent.service.ts`），
 * 而不是把它当成「这条问题没问题」。
 */
export async function recordKnowledgeGap(
  input: RecordKnowledgeGapInput,
): Promise<Result<KnowledgeGapRecord | null>> {
  const business = requireNonEmpty(
    input.businessId,
    "缺少商家标识",
    "businessId 为空。缺口至少按商家隔离，无法在没有商家的情况下聚合。",
  );
  if (!business.ok) {
    return business;
  }

  const question = requireNonEmpty(
    input.question,
    "问题内容为空",
    `question=${JSON.stringify(input.question)}`,
  );
  if (!question.ok) {
    return question;
  }

  const intent = requireNonEmpty(input.intent, "缺少意图", `intent=${JSON.stringify(input.intent)}`);
  if (!intent.ok) {
    return intent;
  }

  const reason = requireNonEmpty(
    input.reason,
    "缺少缺口说明",
    "reason 为空。缺口面板上「答不上来但不说缺什么」对商家毫无价值，那不是一条可执行的待办。",
  );
  if (!reason.ok) {
    return reason;
  }

  /**
   * 规范化后为空 → 这个提问没有可聚合的内容，**刻意不记录**。
   * 这一步放在服务层而不是让仓储抛错，是因为「不记录」是一个正常结果，
   * 不是异常 —— 把它变成错误会让每一次「？」都污染调用方的错误处理。
   */
  const normalizedQuestion = normalizeKnowledgeGapQuestion(question.data);
  if (normalizedQuestion.length === 0) {
    return ok(null);
  }

  return attempt(
    () =>
      getRepositories().knowledgeGaps.recordOccurrence({
        businessId: business.data,
        productId: input.productId ?? null,
        question: question.data,
        normalizedQuestion,
        intent: intent.data,
        reason: reason.data,
      }),
    (cause) => toAppError(cause, "DB_ERROR", "记录知识缺口失败"),
  );
}

/**
 * 缺口列表。排序由仓储负责（未解决优先 → 次数多优先 → 最近出现优先），
 * 服务层只做入参收窄 —— 排序规则必须与数据源实现绑在一起，
 * 否则 Mock 与 DB 会给出两套顺序，演示与真实环境对不上。
 */
export async function listKnowledgeGaps(
  input: ListKnowledgeGapsInput = {},
): Promise<Result<KnowledgeGapRecord[]>> {
  if (input.limit !== undefined && (!Number.isFinite(input.limit) || input.limit <= 0)) {
    return fail(
      "VALIDATION_FAILED",
      "查询条数不合法",
      `limit=${String(input.limit)}（应为正数）`,
    );
  }

  return attempt(
    () =>
      getRepositories().knowledgeGaps.list({
        ...(input.status ? { status: input.status } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
    (cause) => toAppError(cause, "DB_ERROR", "加载知识缺口失败"),
  );
}

/** 按 id 读一条缺口；不存在返回 NOT_FOUND（而不是 null）—— 调用方的 id 通常来自 URL */
export async function getKnowledgeGap(id: string): Promise<Result<KnowledgeGapRecord>> {
  const gapId = requireNonEmpty(id, "缺少缺口标识", "gapId 为空");
  if (!gapId.ok) {
    return gapId;
  }

  const loaded = await attempt(
    () => getRepositories().knowledgeGaps.getById(gapId.data),
    (cause) => toAppError(cause, "DB_ERROR", "加载知识缺口失败"),
  );
  if (!loaded.ok) {
    return loaded;
  }
  if (!loaded.data) {
    return fail("NOT_FOUND", "知识缺口记录不存在", `gapId=${gapId.data}`);
  }
  return ok(loaded.data);
}

/**
 * 标记为已解决。
 *
 * @param documentId 补齐这条缺口的那份知识文档 id。带上它，商家日后回看时
 *   能知道「这个问题当初是靠哪份材料解决的」。不传也允许（例如只是判定误报）。
 *
 * ⚠️ 它**不是终态**：同一个问题再次被问到且检索依旧判依据不足时，
 * 仓储会把它重新置为 open —— 见 `recordKnowledgeGap` 与仓储实现的注释。
 */
export async function resolveKnowledgeGap(
  id: string,
  documentId?: string | null,
): Promise<Result<KnowledgeGapRecord>> {
  const gapId = requireNonEmpty(id, "缺少缺口标识", "gapId 为空");
  if (!gapId.ok) {
    return gapId;
  }

  return attempt(
    () =>
      getRepositories().knowledgeGaps.updateStatus(
        gapId.data,
        "resolved",
        documentId ?? null,
      ),
    (cause) => toAppError(cause, "DB_ERROR", "更新知识缺口失败"),
  );
}

/**
 * 标记为忽略（商家判定这个问题不需要专门补知识）。
 *
 * 与 resolved 的差别在**重复出现时**：resolved 会被重开，ignored 保持 ignored
 * 只累加计数。「忽略」表达的是对这个问题本身的判断，重复出现不构成改变判断的理由；
 * 但计数照涨，商家随时能看到「这个问题一直在发生」，是否重新关注由商家决定。
 */
export async function ignoreKnowledgeGap(
  id: string,
): Promise<Result<KnowledgeGapRecord>> {
  const gapId = requireNonEmpty(id, "缺少缺口标识", "gapId 为空");
  if (!gapId.ok) {
    return gapId;
  }

  return attempt(
    () => getRepositories().knowledgeGaps.updateStatus(gapId.data, "ignored"),
    (cause) => toAppError(cause, "DB_ERROR", "更新知识缺口失败"),
  );
}

/** 领域记录 → 精简形态（供客服回答回显「这是第几次」） */
export function toKnowledgeGapSummary(record: KnowledgeGapRecord): KnowledgeGapSummary {
  return {
    id: record.id,
    status: record.status,
    occurrenceCount: record.occurrenceCount,
  };
}
