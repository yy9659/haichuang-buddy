/**
 * 知识缺口的**聚合身份**（S5 · 任务书第十八 / 二十二节）
 *
 * 缺口面板的全部价值在于**聚合**：商家想知道「哪些问题我答不上来、各被问了多少次」，
 * 而不是看 30 行语气略有差别的同一句话。因此「两条缺口是不是同一条」这个判断，
 * 比缺口记录本身的字段更重要 —— 判错了，面板要么被重复行淹没，
 * 要么把两个不相干的问题合成一条（后者更糟：商家看着一条「怎么保存？」的出现次数
 * 涨到 20 次，却不知道说的是鲍鱼还是鱼丸）。
 *
 * 本模块只做两件事，且都是**纯函数**（无 IO、无时间、无随机）：
 *   1. `normalizeKnowledgeGapQuestion` —— 把「同一句话的不同写法」折叠成同一个键；
 *   2. `buildKnowledgeGapKey` —— 把「商家 + 商品 + 规范化问题」压成一个稳定哈希。
 *
 * 为什么必须是纯函数：这个键会被写进数据库唯一索引。只要它带上一点不确定性
 * （时间戳、随机数、进程内自增），唯一索引就挡不住任何东西 ——
 * 重复提问会各插一行，而且**不会有任何报错**，只是面板慢慢变得不可信。
 *
 * 模块放在 `src/rag/` 而不是 `src/lib/`：它服务的是 RAG 的反馈闭环
 * （检索说「没有依据」→ 记录缺口），与检索层同属一条链路的上下游。
 */

import { sha256Hex } from "@/lib/hash";
import { normalizeQuestion } from "@/lib/knowledge-text";
import { AppError } from "@/lib/result";

/**
 * 规范化问题文本，作为缺口的去重键。
 *
 * **不在这里另写一套规则**，而是直接复用 `normalizeQuestion`（`src/lib/knowledge-text.ts`）：
 * 那条规则已经是「服务层算键」与「仓储层兜底算键」共用的同一份实现，
 * 再抄一遍必然出现「两处规则悄悄分叉」——规范化规则一分叉，唯一索引就形同虚设，
 * 因为同一句话会被两个调用点算成两个键。
 *
 * 这里只是给它一个有领域含义的名字：读到 `normalizeKnowledgeGapQuestion` 的人
 * 立刻知道这个值要拿去做什么，而不需要去猜 `normalizeQuestion` 是不是还有别的用途。
 *
 * ⚠️ 规范化后**可能为空串**（用户只发了「？」「。。。」）。空键是灾难性输入：
 * 所有无意义提问会聚合成同一条缺口，把真正的高频问题挤下去。
 * 调用方必须据此**跳过记录**（而不是拿空串当键），仓储层也会再拦一次。
 */
export function normalizeKnowledgeGapQuestion(question: string): string {
  return normalizeQuestion(question);
}

export interface KnowledgeGapKeyInput {
  /** 必填：缺口**至少**按商家隔离，跨商家合并不可接受 */
  businessId: string;
  /** 商品级缺口带上商品 id；物流 / 售后这类全店政策问题传 null */
  productId?: string | null;
  /** 已经过 `normalizeKnowledgeGapQuestion` 的文本 */
  normalizedQuestion: string;
}

/**
 * 键格式版本。
 *
 * 它不参与任何判断逻辑，只是让一个键能自证「我是哪一代规则算出来的」——
 * 规范化规则演进后，老键不会凭空变成错的，但排查时能一眼看出它属于哪一批。
 * 之所以需要这个：`normalized_question` 列与键都会留在库里，
 * 而规则变更**必然**会让同一个问题算出不同的键（见下面「为什么键里没有 intent」的说明），
 * 有了版本号，那次分叉在数据里是可解释的，而不是看起来像一次 bug。
 */
const GAP_KEY_VERSION = "v1";

/**
 * 由「商家 + 商品 + 规范化问题」生成稳定聚合键（SHA-256 十六进制）。
 *
 * 三条设计取舍：
 *
 * **① 为什么把 businessId 也算进哈希，而唯一索引又是 `(business_id, gap_key)`。**
 * 看似冗余，实为纵深防御：索引前缀负责「按商家过滤」的查询效率，
 * 哈希里带上商家则让键**自身**就是全局唯一的 —— 即使将来某个查询漏写了商家条件，
 * 也不可能跨商家命中同一条缺口。跨商家数据泄漏在这个项目里是不可接受的错误，
 * 值得为它多花几个字节。
 *
 * **② 为什么 `productId` 必须参与。**
 * 「鲍鱼怎么保存？」与「手工鱼丸怎么保存？」规范化后只差两个字，
 * 但它们要补的是两份不同的知识。若键里没有商品维度，这两条会被聚成一条，
 * 商家补了鲍鱼的储存说明后，鱼丸那条也被标记成「已解决」——
 * 而消费者依旧在问、依旧被转人工。这正是任务书第五节划出的聚合边界。
 *
 * **③ 为什么键里刻意**没有** `intent`（与任务书第四节的建议不同，这里是刻意的）。**
 * 任务书第七节写明：命中已有缺口时，要把 `intent` 与 `reason` **更新**为最新一次的判断。
 * 更新语义与「intent 是身份的一部分」直接矛盾 —— 如果 intent 进键，
 * 同一次提问换了意图就会算出新键、插出新行，第 6 步的「更新」永远不会发生。
 * 而且 intent 由模型产出，同义问题在两次调用间被归到不同意图是常见现象；
 * 把它算进身份，等于让**模型的分类抖动**去切碎 occurrenceCount，
 * 而计数正是这个面板最核心的那一列。
 *
 * 用 `JSON.stringify` 而不是自己拼分隔符：问题文本里出现任何字符都不可能与
 * 结构字符混淆（JSON 会转义控制字符），因此不需要论证「分隔符不可能出现在数据里」。
 * `null` 与 `""` 也被 JSON 区分开，不必再约定一个空值占位符。
 *
 * 摘要在 `@/lib/hash` 的 `sha256Hex` 里，与 Agent 任务的 `questionHash` 共用同一份实现。
 */
export function buildKnowledgeGapKey(input: KnowledgeGapKeyInput): string {
  const payload = JSON.stringify([
    GAP_KEY_VERSION,
    input.businessId,
    input.productId ?? null,
    input.normalizedQuestion,
  ]);
  return sha256Hex(payload);
}

/* ------------------------------------------------------------------ */
/* 仓储共用的身份解析                                                   */
/* ------------------------------------------------------------------ */

export interface KnowledgeGapIdentityInput {
  /** 已确定下来的商家 id（Mock 为单商家常量，DB 为当前商家） */
  businessId: string;
  productId?: string | null;
  /** 提问原话，用于在 `normalizedQuestion` 缺失时现算 */
  question: string;
  /** 调用方算好的规范化文本；为空则退回现算 */
  normalizedQuestion?: string;
  /** 调用方算好的聚合键；给了就会与现算结果比对 */
  gapKey?: string;
}

export interface KnowledgeGapIdentity {
  normalizedQuestion: string;
  gapKey: string;
}

/**
 * 推导并校验一次提问的聚合身份 —— **Mock 与 DB 仓储共用这一份**。
 *
 * 放在这里而不是各仓储内部，是因为「同一句话必须算出同一个键」这件事
 * 靠约定是保证不了的：两套实现各写一遍 `normalize → hash`，
 * 任何一次单边改动都会让 Mock 下的演示与 DB 下的真实计数对不上，
 * 而这种不一致不会报错，只会让缺口面板的数字看起来「有点怪」。
 *
 * 两道校验：
 * 1. **空键直接拒绝**。规范化后为空（用户只发了「？」）意味着这个提问没有可聚合的内容；
 *    若拿空串当键，所有无意义提问会聚成同一条缺口，把真正高频的问题挤下去。
 * 2. **调用方给的键与现算结果不一致 → 拒绝**。这是配方变了却没同步的**唯一**报警点：
 *    键一旦对不上，同一句话在库里就会各存一行，两侧计数各自增长 ——
 *    报错总比让商家看到一份安静的错计数好。
 */
export function resolveKnowledgeGapIdentity(
  input: KnowledgeGapIdentityInput,
): KnowledgeGapIdentity {
  const provided = input.normalizedQuestion?.trim() ?? "";
  const normalizedQuestion =
    provided.length > 0 ? provided : normalizeKnowledgeGapQuestion(input.question);

  if (normalizedQuestion.length === 0) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "记录知识缺口失败：问题内容为空",
      detail: `question=${JSON.stringify(
        input.question,
      )}（规范化后为空，无法作为聚合键；这类提问不应被记入缺口）`,
      retryable: false,
    });
  }

  const gapKey = buildKnowledgeGapKey({
    businessId: input.businessId,
    productId: input.productId ?? null,
    normalizedQuestion,
  });

  if (input.gapKey !== undefined && input.gapKey !== gapKey) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "记录知识缺口失败：聚合键与问题内容不一致",
      detail: `调用方传入 gapKey=${input.gapKey}，按 businessId/productId/normalizedQuestion 现算为 ${gapKey}。两者不一致会导致同一问题在库里各存一行，必须暴露而不是静默接受。`,
      retryable: false,
    });
  }

  return { normalizedQuestion, gapKey };
}
