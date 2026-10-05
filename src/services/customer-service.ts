/**
 * 客服会话业务 Service（S5 · Task 80）
 *
 * 分工界线（任务书第十节）：
 * - `customer-service-agent.service.ts` 回答的是「**一个问题**」——
 *   它不知道会话、消息、状态机，只认识「问题 + 知识库」。
 * - 本文件回答的是「**一次客服业务**」——谁在问、问了什么、答得怎么样、
 *   要不要转人工、缺口记在哪。它把 Agent 当成一次纯函数调用，
 *   自己负责所有的持久化与状态流转。
 *
 * 把两者合成一个文件是很容易的（反正都要调 Agent），但那样会让
 * 「会话状态机」「消息落库」「引用快照」这些**产品决策**混进
 * 「检索 + 生成 + 引用校验」那段纯技术流程里，之后任何一边改动都要重新读另一边。
 *
 * ## 本文件唯一但最重要的约定：用户消息一旦落库，就绝不再删
 *
 * 任务书第十二节把这条写成硬要求，因为它违反直觉 —— 出错时「回滚」看起来更干净。
 * 但消费者发出去的那句话是**真实发生过的事实**：它在对方屏幕上、在他的记忆里。
 * 服务端悄悄删掉它，只会制造「我问了、它没反应、再问一次」的重试与重复消息，
 * 而数据库里却查不到第一次提问为什么没被回答。因此：
 *
 * | 情况 | 消费者消息 | AI 消息 | 会话状态 | 返回 |
 * |---|---|---|---|---|
 * | 正常回答 | 保留 | 写入（含引用快照） | 保持 open | ok |
 * | 依据不足 | 保留 | 写入（转人工话术 + 缺口 id） | needs_human | ok |
 * | 模型超时 / 不可用 | **保留** | **不伪造** | 保持 open | ok + `failure` |
 * | 检索层报错 | **保留** | **不伪造** | 保持 open | ok + `failure` |
 * | 会话不存在 / 已关闭 / 内容为空 | 不写入 | 不写入 | 不变 | **fail** |
 *
 * 这张表里唯一「返回 ok 但其实是失败」的两行，正是本文件的难点，见下。
 *
 * ## 为什么模型失败返回 `ok` 而不是 `fail`
 *
 * 因为**这件事确实成功了一半**：消费者那句话已经进库了。若返回 `fail`，
 * 调用方（Server Action / 界面）只能得到「操作失败」，于是它会重新拉一次页面 ——
 * 而重新拉到的页面里，消费者那句话**在**。界面于是陷入自相矛盾：
 * 它刚说「发送失败」，刷新后消息又出现了。
 *
 * 所以正确表达是：「请求处理完了（ok），消费者消息在里面（`customerMessage`），
 * 但 AI 这次没答上来（`failure` 非空、`assistantMessage` 为 null）」。
 * 界面据此显示「AI 客服暂时无法回答，可稍后重试或转人工」——
 * 它不会误导消费者以为自己的问题没发出去。
 *
 * **`fail` 只留给「什么都没发生」的情况**：会话不存在、会话已关闭、内容为空。
 * 这类情况下库里的状态与调用前完全一致，重试与否由调用方决定。
 *
 * ## 绝不把系统故障写成知识缺口
 *
 * `answerCustomerQuestion` 已经保证了这一点（它只在 `run.ok` 时记缺口），
 * 本文件要做的是**不把它再破坏掉**：模型超时时我们既不能写一条假的
 * 「知识库里没有答案」，也不能给消费者一句伪造的回复。
 * 这两件事在界面上长得一模一样（都是一句道歉话术），
 * 但对商家的意义完全相反 —— 一个是「去补知识」，一个是「去看模型通道」。
 */

import {
  summarizeConversations,
  type ConversationSummary,
} from "@/analytics/metrics";
import type { AIProvider } from "@/ai/provider/types";
import { formatDateTime, startOfDay } from "@/lib/datetime";
import { attempt, fail, ok, toAppError, type AppErrorShape, type Result } from "@/lib/result";
import { getRepositories } from "@/repositories";
import type { KnowledgeChunkSearchHit, KnowledgeSearchParams } from "@/repositories/types";
import type {
  AgentStatus,
  ChatMessage,
  ConversationChannel,
  CustomerConversation,
  KnowledgeDocument,
  KnowledgeGapRecord,
} from "@/types";
import { MAX_CUSTOMER_QUESTION_LENGTH } from "@/types";

import {
  answerCustomerQuestion,
  CUSTOMER_SERVICE_AGENT_TYPE,
  type CustomerServiceWarningCode,
} from "./customer-service-agent.service";

/* ------------------------------------------------------------------ */
/* 视图 / 入参类型                                                     */
/* ------------------------------------------------------------------ */

/**
 * 客服 Agent 的「最近一次执行」（来自 `agent_tasks`）。
 *
 * 刻意只带驾驶舱与客服页要展示的几样东西，而不是整条 `AgentTaskRecord`：
 * `input` / `output` 里是任务调用的原始快照，把它塞进页面数据等于让
 * 一份内部日志跟着每个请求走，而界面一个字段都用不上。
 */
export interface CustomerServiceTaskSummary {
  id: string;
  status: AgentStatus;
  title: string;
  /** 展示字符串（`formatDateTime`） */
  createdAtText: string;
  /** 端到端耗时；未收尾为 null */
  durationMs: number | null;
  errorMessage: string | null;
}

/**
 * 客服工作台的**商家级**概况：会话列表 + 知识库 + 缺口 + 经营指标。
 *
 * 它不含「当前打开的会话」——那是 `CustomerServiceView` 在它之上加的东西。
 * 拆成两层是因为两者更新的频率不同：发一条消息会改变列表与当前会话，
 * 但概况里那些统计数字与知识库是另一个数量级的读取量。
 *
 * ## 指标口径（Task 81 第六节）
 *
 * - `todayAnsweredCount`：**分母**。今天（`startOfDay()` 起）写入的 assistant
 *   消息数。模型超时 / 检索报错不会写 assistant 消息，因此系统故障天然不在这里。
 * - `todayGroundedCount`：**分子**。其中 `grounded === true` 的数量。
 * - `groundedRate`：分子 / 分母；今天**一条 AI 回答都没有**时是 `null`，
 *   而不是 0。「没有样本」与「样本全是无依据」是完全不同的两件事，
 *   显示成「0%」会把「客服今天还没开工」说成「客服今天全在胡答」。
 * - `needsHumanConversationCount`：状态为待人工的会话数。这是**业务视角**，
 *   与上面几个「AI 执行得好不好」的指标完全独立 —— 见任务书第二十七节。
 */
export interface CustomerServiceOverview {
  conversations: CustomerConversation[];
  summary: ConversationSummary;
  knowledgeDocuments: KnowledgeDocument[];
  knowledgeGaps: KnowledgeGapRecord[];
  /** 未解决的缺口数（面板标题上的角标） */
  openGapCount: number;
  /* ---------------- Task 81：经营指标 ---------------- */
  /** 今日 AI 回答数（Grounded 率的分母） */
  todayAnsweredCount: number;
  /** 今日依据充分的回答数（分子） */
  todayGroundedCount: number;
  /** 今日 Grounded 率；今日没有 AI 回答时为 null（不是 0） */
  groundedRate: number | null;
  /** 状态为「待人工」的会话数 */
  needsHumanConversationCount: number;
  /** 知识文档总数 */
  totalKnowledgeDocuments: number;
  /** 已完成索引的知识文档数（拿它和总数比就知道检索是不是可用） */
  indexedKnowledgeDocuments: number;
  /** 客服 Agent 最近一次执行；从未跑过为 null */
  latestTask: CustomerServiceTaskSummary | null;
  /**
   * 可选的商品（补知识 / 建会话时选择知识挂在哪件商品上）。
   *
   * 只带 id 与名称：对话与知识面板都不需要商品的其它字段，
   * 把整份 `Product`（含图片、DNA 状态、价格…）送进浏览器只是白白增大负载，
   * 而且会让「这个弹窗能不能显示某字段」这种问题在组件里蔓延。
   */
  productOptions: Array<{ id: string; name: string }>;
}

/**
 * 客服页面所需的完整数据。
 *
 * 与 S0 版本的关键差别：**只读当前会话的消息**，不再一次性读全部会话的消息。
 *
 * 旧版返回 `messagesByConversation: Record<string, ChatMessage[]>`，页面渲染时
 * 再把整张表塞给客户端组件切换 —— 这在 Demo 的 6 条会话上看不出问题，
 * 但那是「每个会话各查一次」的 N+1，而且会把全部会话的消息一次性送进浏览器。
 * 会话选中改由 URL（`?conv=`）表达，切换即一次服务端渲染，
 * 客户端只保留一个搜索框的本地状态。
 */
export interface CustomerServiceView extends CustomerServiceOverview {
  /** 当前打开的会话；一个会话都没有时为 null */
  activeConversation: CustomerConversation | null;
  /** **当前会话**的消息，按时间升序 */
  messages: ChatMessage[];
}

/** 单个会话的详情（按商家校验过归属） */
export interface ConversationDetail {
  conversation: CustomerConversation;
  messages: ChatMessage[];
}

export interface CreateConversationInput {
  /** 不传则解析当前商家的档案；显式传入时必须是真实存在的商家 */
  businessId?: string;
  customerName: string;
  customerLabel?: string;
  /** 会话围绕哪件商品；全店级咨询（物流 / 售后）留空 */
  productId?: string | null;
  channel?: ConversationChannel;
  tags?: string[];
}

export interface SendCustomerMessageInput {
  businessId?: string;
  conversationId: string;
  /** 消费者原话 */
  content: string;
}

/**
 * 注入点（测试用；生产路径全部取默认值）。
 *
 * 与 `generateBrandProfile` / `answerCustomerQuestion` 的做法一致：
 * 用**真实的服务签名**接注入，而不是给服务加一个「测试模式」开关 ——
 * 后者只活在测试里，会让被验证的代码路径与生产路径不是同一条。
 * 这组用例要覆盖的「模型超时」「检索层报错」两种故障，
 * 用种子数据是造不出来的。
 */
export interface SendCustomerMessageOptions {
  provider?: AIProvider;
  search?: (params: KnowledgeSearchParams) => Promise<KnowledgeChunkSearchHit[]>;
  /** 由经营大脑触发时关联到对应工作流 */
  workflowId?: string | null;
  signal?: AbortSignal;
}

/** 一次「消费者发言」的完整结果 —— 见文件头那张表 */
export interface SendCustomerMessageResult {
  /** 会话最新状态（AI 判定转人工后这里就是 needs_human，界面无需自己推断） */
  conversation: CustomerConversation;
  /** 刚写入的消费者消息。**它一定存在**，无论 AI 是否答得上来 */
  customerMessage: ChatMessage;
  /** AI 回复；模型 / 检索失败时为 null —— **绝不伪造** */
  assistantMessage: ChatMessage | null;
  /** AI 未能回答的原因；成功时为 null */
  failure: AppErrorShape | null;
  /** 本次触发的知识缺口 id（依据不足时才有） */
  knowledgeGapId: string | null;
  warningCodes: CustomerServiceWarningCode[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 带进提示词的最近历史条数。
 *
 * 只喂最近几轮：客服的问题绝大多数是「自成一句」的，
 * history 的唯一价值是理解指代（「那我明天能收到吗」里的「那」）。
 * 给多了既增加 token，也会让模型把很早之前的另一个话题扯进来。
 */
const HISTORY_LIMIT = 6;

/** 一次聊天记录最多读多少条（防止一条被灌爆的会话把页面拖垮） */
const MAX_THREAD_MESSAGES = 200;

function resolveExplicitBusinessId(explicit?: string): string | null {
  const trimmed = explicit?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * 解析「当前商家」。
 *
 * 优先用调用方显式传入的 id（测试与编排层注入的场景），
 * 否则回退到商家档案。**绝不用常量兜底** —— 那会让所有商家
 * 悄悄共用同一个租户，而这种错误不会报错，只会让数据混在一起。
 *
 * 导出它是因为知识库的写入（`KnowledgeDocumentInput.businessId` 是必填）
 * 需要同一个答案。让 Server Action 自己再解析一遍，早晚会出现
 * 「会话用 A 家、知识用 B 家」这种只在演示数据下看不出来的错位。
 */
export async function resolveActiveBusinessId(explicit?: string): Promise<Result<string>> {
  const direct = resolveExplicitBusinessId(explicit);
  if (direct) {
    return ok(direct);
  }

  const profile = await attempt(
    () => getRepositories().business.getProfile(),
    (cause) => toAppError(cause, "DB_ERROR", "加载商家档案失败"),
  );
  if (!profile.ok) {
    return profile;
  }
  if (!profile.data) {
    return fail(
      "VALIDATION_FAILED",
      "尚未建立商家档案，无法使用客服工作台",
      "客服会话必须归属于一个商家。请先创建商家资料（可执行 pnpm db:seed 初始化演示数据）。",
    );
  }
  return ok(profile.data.id);
}

/**
 * 按商家读取会话，读不到一律返回 `NOT_FOUND`。
 *
 * 「不存在」与「不是你的」合并成同一个错误，是**刻意**的：
 * 分开返回就等于提供了一个探测接口 —— 攻击者可以用错误码的差别
 * 枚举出「哪些 conversationId 在系统里真实存在」。任务书第四十二节
 * Case 8 把这条列成了验收项，而不是「建议」。
 */
async function requireConversation(
  businessId: string,
  conversationId: string,
): Promise<Result<CustomerConversation>> {
  const id = conversationId?.trim() ?? "";
  if (id.length === 0) {
    return fail("VALIDATION_FAILED", "缺少会话标识", "conversationId 为空");
  }

  const loaded = await attempt(
    () => getRepositories().conversations.findConversationForBusiness(businessId, id),
    (cause) => toAppError(cause, "DB_ERROR", "加载客服会话失败"),
  );
  if (!loaded.ok) {
    return loaded;
  }
  if (!loaded.data) {
    return fail("NOT_FOUND", "客服会话不存在", `conversationId=${id}`);
  }
  return ok(loaded.data);
}

/** 领域消息 → Agent 的历史片段（形如「顾客：…」「客服：…」） */
function toHistoryLines(messages: readonly ChatMessage[]): string[] {
  return messages.slice(-HISTORY_LIMIT).map((message) => {
    const speaker = message.role === "customer" ? "顾客" : "客服";
    return `${speaker}：${message.content}`;
  });
}

async function loadOverview(
  businessId: string,
): Promise<Result<CustomerServiceOverview>> {
  const repositories = getRepositories();

  /**
   * 「今日」的边界只在这里算一次（`startOfDay` 所在的 `@/lib/datetime`
   * 是它的唯一定义处）。仓储接收的是一个明确的瞬间，不自己 `new Date()` ——
   * 否则「今日」的定义会散到两个数据源里，各算各的。
   */
  const todayStart = startOfDay();

  const gathered = await attempt(
    async () => {
      const [
        conversations,
        knowledgeDocuments,
        knowledgeGaps,
        products,
        todayAnswers,
        latestTask,
      ] = await Promise.all([
        repositories.conversations.listConversationsForBusiness(businessId),
        repositories.knowledgeDocuments.findDocuments(),
        repositories.knowledgeGaps.list(),
        repositories.products.list(),
        repositories.conversations.countAssistantMessagesSince(businessId, todayStart),
        repositories.agentTasks.findLatestByType(CUSTOMER_SERVICE_AGENT_TYPE),
      ]);
      return {
        conversations,
        knowledgeDocuments,
        knowledgeGaps,
        products,
        todayAnswers,
        latestTask,
      };
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载客服工作台失败"),
  );
  if (!gathered.ok) {
    return gathered;
  }

  const {
    conversations,
    knowledgeDocuments,
    knowledgeGaps,
    products,
    todayAnswers,
    latestTask,
  } = gathered.data;

  const todayAnsweredCount = todayAnswers.answered;
  const todayGroundedCount = todayAnswers.grounded;

  return ok({
    conversations,
    summary: summarizeConversations(conversations),
    knowledgeDocuments,
    knowledgeGaps,
    openGapCount: knowledgeGaps.filter((gap) => gap.status === "open").length,

    todayAnsweredCount,
    todayGroundedCount,
    /**
     * 0 样本 → `null` 而不是 0（任务书第六节）。
     * 除零保护不是「顺手加一个」，而是这个比值的语义要求：
     * 「还没有样本」必须能和「样本全是无依据」区分开。
     */
    groundedRate:
      todayAnsweredCount > 0 ? todayGroundedCount / todayAnsweredCount : null,
    needsHumanConversationCount: conversations.filter(
      (conversation) => conversation.status === "human",
    ).length,
    totalKnowledgeDocuments: knowledgeDocuments.length,
    indexedKnowledgeDocuments: knowledgeDocuments.filter(
      (document) => document.indexStatus === "indexed",
    ).length,
    /**
     * 注意：`agent_tasks` 目前没有 business_id（Demo 为单商家，见
     * `AgentTaskRepository.findLatestByType` 的说明），因此这里是全库最近一条
     * 客服任务。多商家上线时这一处要跟着补商家维度 —— 把它记在返回值旁边，
     * 比藏在仓储实现里更容易被找到。
     */
    latestTask: latestTask
      ? {
          id: latestTask.id,
          status: latestTask.status,
          title: latestTask.title,
          createdAtText: formatDateTime(latestTask.createdAt),
          durationMs: latestTask.durationMs,
          errorMessage: latestTask.errorMessage,
        }
      : null,

    productOptions: products.map((product) => ({ id: product.id, name: product.name })),
  });
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

/** 商家级概况（不含当前会话的消息） */
export async function getCustomerServiceOverview(
  options: { businessId?: string } = {},
): Promise<Result<CustomerServiceOverview>> {
  const businessId = await resolveActiveBusinessId(options.businessId);
  if (!businessId.ok) {
    return businessId;
  }
  return loadOverview(businessId.data);
}

/**
 * 读取客服页数据。
 *
 * @param conversationId 想打开的会话 id（来自 `?conv=`）；不存在或未传时回退到最近活跃的那条。
 *   回退而不是报错，是因为「刚刚那条会话被删除了」时页面不该整页 500 ——
 *   让商家看到列表并自动落到第一条，比看到错误页有用。
 */
export async function getCustomerServiceView(
  conversationId?: string,
  options: { businessId?: string } = {},
): Promise<Result<CustomerServiceView>> {
  const businessId = await resolveActiveBusinessId(options.businessId);
  if (!businessId.ok) {
    return businessId;
  }

  const overview = await loadOverview(businessId.data);
  if (!overview.ok) {
    return overview;
  }

  const requested = conversationId?.trim() ?? "";
  const activeConversation =
    (requested.length > 0
      ? overview.data.conversations.find((item) => item.id === requested)
      : undefined) ??
    overview.data.conversations[0] ??
    null;

  const messages = await attempt(
    async () =>
      activeConversation
        ? (await getRepositories().conversations.listMessages(activeConversation.id)).slice(
            0,
            MAX_THREAD_MESSAGES,
          )
        : [],
    (cause) => toAppError(cause, "DB_ERROR", "加载客服消息失败"),
  );
  if (!messages.ok) {
    return messages;
  }

  return ok({
    ...overview.data,
    activeConversation,
    messages: messages.data,
  });
}

/** 按商家读取一个会话及其消息（切换会话、轮询刷新都走它） */
export async function listConversations(
  options: { businessId?: string; limit?: number } = {},
): Promise<Result<CustomerConversation[]>> {
  const businessId = await resolveActiveBusinessId(options.businessId);
  if (!businessId.ok) {
    return businessId;
  }
  return attempt(
    () =>
      getRepositories().conversations.listConversationsForBusiness(
        businessId.data,
        options.limit,
      ),
    (cause) => toAppError(cause, "DB_ERROR", "加载客服会话失败"),
  );
}

export async function getConversationDetail(
  conversationId: string,
  options: { businessId?: string } = {},
): Promise<Result<ConversationDetail>> {
  const businessId = await resolveActiveBusinessId(options.businessId);
  if (!businessId.ok) {
    return businessId;
  }

  const conversation = await requireConversation(businessId.data, conversationId);
  if (!conversation.ok) {
    return conversation;
  }

  const messages = await attempt(
    () => getRepositories().conversations.listMessages(conversation.data.id),
    (cause) => toAppError(cause, "DB_ERROR", "加载客服消息失败"),
  );
  if (!messages.ok) {
    return messages;
  }

  return ok({ conversation: conversation.data, messages: messages.data });
}

/* ------------------------------------------------------------------ */
/* 写入：会话                                                          */
/* ------------------------------------------------------------------ */

/**
 * 新建一个模拟消费者会话（任务书第十九 / 三十八节）。
 *
 * 刻意**不预置任何 AI 回复**：新建出来的会话是空的，第一句提问必须真的走一遍
 * 检索 + 生成。预置一条「您好，有什么可以帮您」会让「RAG 到底通没通」
 * 变成一个看不出来的问题 —— 页面上反正有字。
 */
export async function createConversation(
  input: CreateConversationInput,
): Promise<Result<CustomerConversation>> {
  const name = input.customerName?.trim() ?? "";
  if (name.length === 0) {
    return fail("VALIDATION_FAILED", "缺少客户名称", "customerName 为空");
  }

  const businessId = await resolveActiveBusinessId(input.businessId);
  if (!businessId.ok) {
    return businessId;
  }

  /**
   * 商品归属校验。
   *
   * 挂错商品不会报错，只会让这个会话的检索悄悄带上另一家的商品维度
   * —— 这类泄漏是最难发现的，因此在写入前就挡掉。
   */
  const productId = input.productId ?? null;
  if (productId) {
    const owns = await attempt(
      () => getRepositories().products.belongsToBusiness(businessId.data, productId),
      (cause) => toAppError(cause, "DB_ERROR", "校验商品归属失败"),
    );
    if (!owns.ok) {
      return owns;
    }
    if (!owns.data) {
      // 与「商品不存在」合并成同一个错误，理由同 `requireConversation`
      return fail("NOT_FOUND", "商品不存在", `productId=${productId}`);
    }
  }

  return attempt(
    () =>
      getRepositories().conversations.createConversation({
        businessId: businessId.data,
        customerName: name,
        ...(input.customerLabel ? { customerLabel: input.customerLabel } : {}),
        ...(input.channel ? { channel: input.channel } : {}),
        productId,
        ...(input.tags ? { tags: input.tags } : {}),
      }),
    (cause) => toAppError(cause, "DB_ERROR", "创建客服会话失败"),
  );
}

/**
 * 标记会话「需要人工介入」。
 *
 * 与「AI 答不上来」不是同一件事：这是商家（或客服本人）看到 AI 的回答后
 * 主动要求人工接手。AI **仍然可以继续回答**该会话（任务书第三十六节），
 * 状态只是给页面一个持续可见的提示。
 */
export async function handoffConversation(
  conversationId: string,
  options: { businessId?: string } = {},
): Promise<Result<CustomerConversation>> {
  return updateConversationStatus(conversationId, "human", options);
}

/** 结束会话。结束后不再允许继续发送（任务书第三十六节） */
export async function closeConversation(
  conversationId: string,
  options: { businessId?: string } = {},
): Promise<Result<CustomerConversation>> {
  return updateConversationStatus(conversationId, "closed", options);
}

async function updateConversationStatus(
  conversationId: string,
  status: CustomerConversation["status"],
  options: { businessId?: string },
): Promise<Result<CustomerConversation>> {
  const businessId = await resolveActiveBusinessId(options.businessId);
  if (!businessId.ok) {
    return businessId;
  }

  /**
   * 先按商家读一次，再改。
   *
   * 为什么不在 `updateConversation` 里带商家条件就完事：Mock 与 DB 两套实现的
   * 状态流转方法**都不接收 businessId**（那是 S0 时代的接口）。
   * 与其在服务层之外的两处实现里各补一次过滤（漏一处就是一次跨商家写入），
   * 不如在这里做一次统一的归属校验 —— 两套数据源的行为因此完全一致。
   */
  const conversation = await requireConversation(businessId.data, conversationId);
  if (!conversation.ok) {
    return conversation;
  }

  return attempt(
    () => getRepositories().conversations.updateConversation(conversation.data.id, { status }),
    (cause) => toAppError(cause, "DB_ERROR", "更新客服会话失败"),
  );
}

/* ------------------------------------------------------------------ */
/* 写入：发送消息（本任务的核心）                                      */
/* ------------------------------------------------------------------ */

/**
 * 消费者发一句话 → 落库 → 跑 RAG → 落库 AI 回复。
 *
 * 十一步的顺序见任务书第十一节，这里有四处「顺序不能换」：
 *
 * 1. **先校验、再落库**。内容为空、会话不存在、会话已关闭这三种情况**一个字节都不写**。
 *    先写再校验会留下一条永远得不到回答的孤儿消息。
 * 2. **消费者消息先落库，再调模型**。反过来的话，模型调用（几秒）期间如果进程重启，
 *    消费者那句话就凭空消失了 —— 而它必须是最先被保住的东西。
 * 3. **AI 回复落库时写「引用快照」而不是引用 id**。知识文档之后可能被编辑或删除，
 *    而「当时这条回答依据的是哪份材料」是历史事实（任务书第七节）。
 * 4. **失败不反悔**。见文件头那张表：模型 / 检索失败时保留消费者消息、
 *    不写 AI 消息、会话状态不动，并把原因作为 `failure` 返回。
 */
export async function sendCustomerMessage(
  input: SendCustomerMessageInput,
  options: SendCustomerMessageOptions = {},
): Promise<Result<SendCustomerMessageResult>> {
  const content = input.content?.trim() ?? "";
  if (content.length === 0) {
    return fail("VALIDATION_FAILED", "消息内容不能为空");
  }
  if (content.length > MAX_CUSTOMER_QUESTION_LENGTH) {
    return fail(
      "VALIDATION_FAILED",
      `消息内容过长，请控制在 ${MAX_CUSTOMER_QUESTION_LENGTH} 字以内`,
      `长度为 ${content.length} 字`,
    );
  }

  const businessId = await resolveActiveBusinessId(input.businessId);
  if (!businessId.ok) {
    return businessId;
  }

  const conversation = await requireConversation(businessId.data, input.conversationId);
  if (!conversation.ok) {
    return conversation;
  }
  if (conversation.data.status === "closed") {
    return fail(
      "VALIDATION_FAILED",
      "会话已结束，无法继续发送",
      "若仍需咨询，请新建一个会话（第一版不支持重新打开已结束的会话）。",
    );
  }

  /** 历史要在写入本次提问**之前**取，否则最近一句会重复出现两次 */
  const thread = await attempt(
    async () => {
      const messages = await getRepositories().conversations.listMessages(
        conversation.data.id,
      );
      return toHistoryLines(messages);
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载客服消息失败"),
  );
  if (!thread.ok) {
    return thread;
  }

  /** ② 写入消费者消息。这一步成功后，无论后面发生什么，它都会留在库里 */
  const savedCustomer = await attempt(
    () =>
      getRepositories().conversations.appendMessage({
        conversationId: conversation.data.id,
        role: "customer",
        content,
      }),
    (cause) => toAppError(cause, "DB_ERROR", "保存客服消息失败"),
  );
  if (!savedCustomer.ok) {
    return savedCustomer;
  }

  /** ③ 跑 RAG 客服 Agent（检索 → 生成 → 引用校验 → 依据判定） */
  const answered = await answerCustomerQuestion(
    {
      question: content,
      businessId: businessId.data,
      productId: conversation.data.productId,
      conversationId: conversation.data.id,
      ...(thread.data.length > 0 ? { history: thread.data } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    {
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.search ? { search: options.search } : {}),
      ...(options.workflowId ? { workflowId: options.workflowId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  /**
   * ④ 失败分支：**不写 AI 消息、不动会话状态**。
   *
   * 返回 ok 是因为「消费者消息已落库」这件事实实在在发生了，
   * 而 `failure` 承载了「AI 这次没答上来」—— 见文件头。
   */
  if (!answered.ok) {
    return ok({
      conversation: conversation.data,
      customerMessage: savedCustomer.data,
      assistantMessage: null,
      failure: answered.error,
      knowledgeGapId: null,
      warningCodes: [],
      warnings: [],
    });
  }

  const { answer, knowledgeGap, warningCodes, warnings } = answered.data;

  /** ⑤ 写入 AI 消息：正文 + 判定 + **引用快照** + 缺口关联 */
  const savedAssistant = await attempt(
    () =>
      getRepositories().conversations.appendMessage({
        conversationId: conversation.data.id,
        role: "agent",
        content: answer.answer,
        grounded: answer.grounded,
        intent: answer.intent,
        confidence: answer.confidence,
        /**
         * 引用快照直接存整份 `KnowledgeSource`（documentId / chunkId / title /
         * type / snippet / score），而不是只存一组 chunkId：
         * 文档被删掉之后，只存 id 的「依据」就变成一串点不开的 uuid。
         */
        citations: answer.citations,
        needsHuman: answer.needsHuman,
        knowledgeGapId: knowledgeGap?.id ?? null,
        retrievedCount: answer.retrievedCount,
      }),
    (cause) => toAppError(cause, "DB_ERROR", "保存客服消息失败"),
  );

  if (!savedAssistant.ok) {
    /**
     * 模型答上来了，但回复没能落库。
     *
     * 这里**不把这段回答显示给消费者**：界面上出现的消息必须来自数据库，
     * 否则用户刷新一次它就消失了 —— 那比「明确说这次失败了」更糟。
     * 消费者消息仍在，重试即可。
     */
    return ok({
      conversation: conversation.data,
      customerMessage: savedCustomer.data,
      assistantMessage: null,
      failure: savedAssistant.error,
      knowledgeGapId: knowledgeGap?.id ?? null,
      warningCodes,
      warnings: [
        ...warnings,
        "AI 的回答已生成，但保存失败，请重试。",
      ],
    });
  }

  /**
   * ⑥ 回读会话最新状态。
   *
   * 状态推进（`needs_human`）由仓储在追加消息时一并完成，因此这里必须回读 ——
   * 沿用调用前那份快照会让界面上的状态点停在 `open`，
   * 与刚显示出来的「建议人工确认」互相矛盾。
   */
  const refreshed = await attempt(
    () =>
      getRepositories().conversations.findConversationForBusiness(
        businessId.data,
        conversation.data.id,
      ),
    (cause) => toAppError(cause, "DB_ERROR", "加载客服会话失败"),
  );

  return ok({
    conversation: refreshed.ok && refreshed.data ? refreshed.data : conversation.data,
    customerMessage: savedCustomer.data,
    assistantMessage: savedAssistant.data,
    failure: null,
    knowledgeGapId: knowledgeGap?.id ?? null,
    warningCodes,
    warnings,
  });
}
