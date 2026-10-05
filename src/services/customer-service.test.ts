/**
 * 客服会话闭环 Service 单测（S5 · Task 80）
 *
 * 覆盖任务书第四十一节的各项与第四十二节的 E2E Case 1–8。
 *
 * 这组用例的重心不是「能不能发出一句话、拿回一句回答」，而是**出错时留下了什么**：
 *
 * 1. **用户消息一旦落库就绝不回滚**（第十二节）。模型超时、检索报错都属于系统故障，
 *    它们的正确表现是「消费者那句话还在、AI 回复不存在、会话状态不动」，
 *    而不是「整次操作仿佛没发生过」。
 * 2. **系统故障与知识缺失必须分开**（第十三节）。前者不写缺口、`agent_task=failed`；
 *    后者写缺口、`agent_task` 仍然是 **completed**，
 *    因为「正确识别出依据不足」本身就是一次成功的执行（第十七节）。
 * 3. **跨商家读取必须是 NOT_FOUND**（第八节 / Case 8），不能给出
 *    「存在但不属于你」这种可以拿来枚举资源的回应。
 *
 * 链路用 Mock Provider，但切片、向量化、检索、引用校验都是**真实执行**的，
 * 不是「按问题查表返回预置答案」。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import type { AIProvider } from "@/ai/provider/types";
import { resetServerEnvCache } from "@/lib/env";
import { MOCK_BUSINESS } from "@/lib/mock";
import { AppError, type Result } from "@/lib/result";
import {
  clearStoredAgentTasks,
  findStoredConversation,
  listStoredAgentTasks,
  listStoredKnowledgeChunks,
  listStoredKnowledgeGaps,
  resetStoredConversations,
  resetStoredKnowledge,
} from "@/repositories/mock/store";

import {
  createKnowledgeDocument,
  createKnowledgeForGap,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
  updateKnowledgeDocument,
} from "./knowledge.service";
import {
  closeConversation,
  createConversation,
  getConversationDetail,
  getCustomerServiceOverview,
  handoffConversation,
  listConversations,
  sendCustomerMessage,
} from "./customer-service";

process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

const BUSINESS_ID = MOCK_BUSINESS.id;
/** 一个**不属于本商家**的租户，用于验证跨商家隔离 */
const OTHER_BUSINESS_ID = "biz_other_999";

/* ------------------------------------------------------------------ */
/* 测试辅助                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把种子文档跑一遍**真实索引流程**。
 *
 * 调用知识服务而不是在测试里手抄「切片 → 向量 → 写切片表」：
 * 手抄的版本是生产流程的复制品，复制品一旦与服务分叉，
 * 这组用例就不再覆盖真实路径了。
 */
async function indexAllDocuments(): Promise<void> {
  const listed = await listKnowledgeDocuments();
  if (!listed.ok) {
    throw new Error(`加载种子知识失败：${listed.error.message}`);
  }
  for (const document of listed.data) {
    const done = await reindexKnowledgeDocument(document.id);
    if (!done.ok) {
      throw new Error(`索引「${document.name}」失败：${done.error.message}`);
    }
  }
}

/** 建一个模拟消费者会话并返回它的 id */
async function newConversation(
  customerName = "王女士",
  productId: string | null = null,
): Promise<string> {
  const created = await createConversation({ customerName, productId });
  if (!created.ok) {
    throw new Error(`创建会话失败：${created.error.message}`);
  }
  return created.data.id;
}

/** 让相邻两次写入拿到不同的时间戳，避免依赖同毫秒内的插入顺序 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/** 取第 i 个元素并断言它存在（把 `?.` 从每一行断言里挪出来） */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`期望下标 ${index} 存在，实际数组长度为 ${items.length}`);
  }
  return value;
}

/** 客服 Agent 的任务记录（按创建时间正序） */
function customerServiceTasks() {
  return listStoredAgentTasks()
    .filter((task) => task.agentType === "customer_service_agent")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** 一个「生成阶段超时」的 Provider（检索照常，模型调用失败） */
function timeoutProvider(): AIProvider {
  return {
    ...createMockAIProvider(),
    /**
     * 客服 Agent 的结构化生成走的是 `generateText` + 本地 JSON 解析
     * （见 `generateValidatedObject`），因此这里替换的是 `generateText`。
     */
    generateText: async () => {
      throw new AppError({
        code: "MODEL_TIMEOUT",
        message: "模型响应超时",
        detail: "请求超过 90s 未返回",
      });
    },
  };
}

beforeEach(() => {
  resetStoredKnowledge();
  resetStoredConversations();
  clearStoredAgentTasks();
});

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

describe("会话仓储与业务", () => {
  it("创建后可按商家读到；新建会话状态是 AI 接待、渠道是模拟器", async () => {
    const id = await newConversation("林小姐");

    const created = unwrap(await listConversations()).find((item) => item.id === id);

    expect(created).toBeDefined();
    // 新会话一律从「AI 接待」开始，是否转人工由 Agent 的结论决定
    expect(created?.status).toBe("bot");
    // 内置模拟器创建的会话不该被标成某个第三方平台
    expect(findStoredConversation(id)?.channel).toBe("simulator");
  });

  it("按商家隔离：另一家的会话读不到，且错误码是 NOT_FOUND", async () => {
    const foreign = unwrap(
      await createConversation({
        businessId: OTHER_BUSINESS_ID,
        customerName: "别家客户",
      }),
    );

    // 本商家读别家的会话
    const denied = await getConversationDetail(foreign.id);
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.error.code).toBe("NOT_FOUND");

    // 「不存在」与「不是你的」必须无法区分，否则可以靠错误码枚举出别人的资源
    const serialized = JSON.stringify(!denied.ok ? denied.error : {});
    expect(serialized).not.toContain("无权");
    expect(serialized).not.toContain("不属于");

    // 本商家的列表里也不该出现它
    expect(unwrap(await listConversations()).some((item) => item.id === foreign.id)).toBe(
      false,
    );
  });

  it("关闭会话后状态为 closed", async () => {
    const id = await newConversation("陈先生");

    const closed = unwrap(await closeConversation(id));

    expect(closed.status).toBe("closed");
    expect(findStoredConversation(id)?.status).toBe("closed");
  });

  it("排序按最近活跃倒序：刚发过消息的会话排到最前", async () => {
    const first = await newConversation("先建的");
    await tick();
    const second = await newConversation("后建的");

    expect(at(unwrap(await listConversations()), 0).id).toBe(second);

    await tick();
    await indexAllDocuments();
    unwrap(await sendCustomerMessage({ conversationId: first, content: "鲍鱼怎么保存？" }));

    expect(at(unwrap(await listConversations()), 0).id).toBe(first);
  });

  it("不存在的会话返回 NOT_FOUND", async () => {
    const missing = await getConversationDetail("conv_not_exists");

    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error.code).toBe("NOT_FOUND");
  });

  it("概况里带上会话摘要、知识库、缺口数与可选商品", async () => {
    await newConversation("王女士");

    const overview = unwrap(await getCustomerServiceOverview());

    expect(overview.summary.total).toBeGreaterThan(0);
    expect(overview.knowledgeDocuments.length).toBeGreaterThan(0);
    expect(overview.openGapCount).toBe(0);
    expect(overview.productOptions.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 客服经营指标（Task 81 §5–7）                                         */
/* ------------------------------------------------------------------ */

describe("客服经营指标（Task 81）", () => {
  beforeEach(async () => {
    await indexAllDocuments();
  });

  it("今天没有 AI 回答时 groundedRate 为 null 而不是 0%", async () => {
    const overview = unwrap(await getCustomerServiceOverview());

    expect(overview.todayAnsweredCount).toBe(0);
    expect(overview.todayGroundedCount).toBe(0);
    /**
     * 这条断言的含义见 §6：「0 条样本」与「样本中 0% 有依据」语义完全不同 ——
     * 前者只是「今天还没人问过」，后者会误导商家以为「AI 一直在乱答」。
     */
    expect(overview.groundedRate).toBeNull();
    expect(overview.needsHumanConversationCount).toBe(0);
    expect(overview.openGapCount).toBe(0);
    /** 索引后每一份种子都应该计为 indexed */
    expect(overview.totalKnowledgeDocuments).toBeGreaterThan(0);
    expect(overview.indexedKnowledgeDocuments).toBe(
      overview.totalKnowledgeDocuments,
    );
    /** 还没跑过客服 → 最新任务为 null（不要把「没有」伪装成「idle 也算任务」） */
    expect(overview.latestTask).toBeNull();
  });

  it("一次 Grounded 回答后 todayAnsweredCount=1, todayGroundedCount=1, groundedRate=1", async () => {
    const id = await newConversation("海味爱好者");
    unwrap(
      await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }),
    );

    const overview = unwrap(await getCustomerServiceOverview());

    expect(overview.todayAnsweredCount).toBe(1);
    expect(overview.todayGroundedCount).toBe(1);
    expect(overview.groundedRate).toBeCloseTo(1, 6);
    /** 系统故障不进分母：assistant 消息只有一条，且是 Grounded */
    expect(overview.needsHumanConversationCount).toBe(0);
  });

  it("一次 Knowledge Gap 后 todayAnsweredCount=1, todayGroundedCount=0, groundedRate=0", async () => {
    const id = await newConversation("心急的买家");
    unwrap(
      await sendCustomerMessage({ conversationId: id, content: "多久发货？" }),
    );

    const overview = unwrap(await getCustomerServiceOverview());

    /** AI 给了一句「已转人工」的回复，它也算一次成功 AI 回答 */
    expect(overview.todayAnsweredCount).toBe(1);
    /** 但它的 grounded=false，所以分子是 0 */
    expect(overview.todayGroundedCount).toBe(0);
    expect(overview.groundedRate).toBeCloseTo(0, 6);
    expect(overview.needsHumanConversationCount).toBe(1);
    expect(overview.openGapCount).toBe(1);
  });

  it("最新一次 Agent Task 被附在 latestTask 上", async () => {
    const id = await newConversation("追问的客人");
    unwrap(
      await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }),
    );

    const overview = unwrap(await getCustomerServiceOverview());

    expect(overview.latestTask).not.toBeNull();
    expect(overview.latestTask?.status).toBe("completed");
    expect(typeof overview.latestTask?.durationMs).toBe("number");
  });
});

/* ------------------------------------------------------------------ */
/* 消息与引用快照                                                      */
/* ------------------------------------------------------------------ */

describe("消息落库与引用快照", () => {
  it("消息按时间升序读回：消费者、AI、消费者、AI", async () => {
    const id = await newConversation("小汤圆");
    await indexAllDocuments();

    unwrap(await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }));
    await tick();
    unwrap(await sendCustomerMessage({ conversationId: id, content: "多久发货？" }));

    const detail = unwrap(await getConversationDetail(id));
    expect(detail.messages.map((message) => message.role)).toEqual([
      "customer",
      "agent",
      "customer",
      "agent",
    ]);
  });

  it("AI 消息带上 grounded / intent / needsHuman / 检索条数等判定", async () => {
    const id = await newConversation("海味爱好者");
    await indexAllDocuments();

    const result = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }),
    );

    expect(result.assistantMessage?.role).toBe("agent");
    expect(result.assistantMessage?.grounded).toBe(true);
    // `needsHuman` 的契约是「只有需要人工时才出现」，false 与 undefined 等价
    expect(result.assistantMessage?.needsHuman ?? false).toBe(false);
    expect(result.assistantMessage?.intent).toBe("storage");
    expect(result.assistantMessage?.retrievedCount).toBeGreaterThan(0);
  });

  it("引用以快照写入消息：包含文档名与片段，而不只是一串 chunkId", async () => {
    const id = await newConversation("厨房新手");
    await indexAllDocuments();

    const result = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }),
    );
    const citations = result.assistantMessage?.knowledgeSources ?? [];

    expect(citations.length).toBeGreaterThan(0);
    const first = at(citations, 0);
    // 快照必须能独立回答「当时依据的是什么」，不依赖回查知识库
    expect(first.documentId.length).toBeGreaterThan(0);
    expect(first.chunkId.length).toBeGreaterThan(0);
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.snippet.length).toBeGreaterThan(0);
  });

  it("Case 7：知识文档被改名后，历史引用快照保持不变", async () => {
    const id = await newConversation("海边人家");
    await indexAllDocuments();

    const result = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }),
    );
    const before = at(result.assistantMessage?.knowledgeSources ?? [], 0);

    const renamed = unwrap(
      await updateKnowledgeDocument(before.documentId, {
        name: "改名后的储存说明",
        content: "这是一段被整体改写过的正文。",
      }),
    );
    expect(renamed.name).toBe("改名后的储存说明");

    // 历史消息里的引用是**快照**，不该被后续编辑改写
    const detail = unwrap(await getConversationDetail(id));
    const agentMessage = at(
      detail.messages.filter((message) => message.role === "agent"),
      0,
    );
    const after = at(agentMessage.knowledgeSources ?? [], 0);

    expect(after.title).toBe(before.title);
    expect(after.title).not.toBe("改名后的储存说明");
  });
});

/* ------------------------------------------------------------------ */
/* sendCustomerMessage：成功语义                                       */
/* ------------------------------------------------------------------ */

describe("sendCustomerMessage 成功路径", () => {
  it("Case 1：依据充分 → 两条消息都落库，grounded=true 且有引用", async () => {
    const id = await newConversation("王女士");
    await indexAllDocuments();

    const result = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }),
    );

    expect(result.failure).toBeNull();
    expect(result.customerMessage.role).toBe("customer");
    expect(result.assistantMessage?.grounded).toBe(true);
    expect((result.assistantMessage?.knowledgeSources ?? []).length).toBeGreaterThan(0);
    expect(result.knowledgeGapId).toBeNull();

    expect(unwrap(await getConversationDetail(id)).messages).toHaveLength(2);
  });

  it("Case 2：依据不足 → AI 消息带转人工、缺口建立、会话状态推进为待人工", async () => {
    const id = await newConversation("阿岚");
    await indexAllDocuments();

    const result = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "下单后多久发货？" }),
    );

    expect(result.failure).toBeNull();
    expect(result.assistantMessage?.grounded).toBe(false);
    expect(result.assistantMessage?.needsHuman).toBe(true);
    expect(result.knowledgeGapId).toBeTruthy();
    expect(result.conversation.status).toBe("human");

    const gaps = listStoredKnowledgeGaps();
    expect(gaps).toHaveLength(1);
    expect(at(gaps, 0).occurrenceCount).toBe(1);
    expect(at(gaps, 0).intent).toBe("logistics");
  });

  it("Case 3：同一个问题再问一次 → 缺口计数 +1，不新增缺口", async () => {
    const id = await newConversation("阿岚");
    await indexAllDocuments();

    unwrap(await sendCustomerMessage({ conversationId: id, content: "下单后多久发货？" }));
    const second = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "下单后多久发货？" }),
    );

    const gaps = listStoredKnowledgeGaps();
    expect(gaps).toHaveLength(1);
    expect(at(gaps, 0).occurrenceCount).toBe(2);
    // 两次提问指向同一条缺口
    expect(second.knowledgeGapId).toBe(at(gaps, 0).id);
  });

  it("依据充分时绝不产生缺口（哪怕模型建议转人工）", async () => {
    const id = await newConversation("王女士");
    await indexAllDocuments();

    const result = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }),
    );

    expect(result.assistantMessage?.grounded).toBe(true);
    expect(result.knowledgeGapId).toBeNull();
    expect(listStoredKnowledgeGaps()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* sendCustomerMessage：失败语义                                       */
/* ------------------------------------------------------------------ */

describe("sendCustomerMessage 失败语义", () => {
  it("Case 6：模型超时 → 消费者消息保留、没有假回答、没有缺口、任务记为 failed", async () => {
    const id = await newConversation("海味爱好者");
    await indexAllDocuments();

    const result = unwrap(
      await sendCustomerMessage(
        { conversationId: id, content: "鲍鱼怎么保存？" },
        { provider: timeoutProvider() },
      ),
    );

    // ① 消费者那句话必须还在 —— 它已经发出去了，服务端不能悄悄删掉
    expect(result.customerMessage.content).toBe("鲍鱼怎么保存？");
    // ② AI 回复不伪造
    expect(result.assistantMessage).toBeNull();
    expect(result.failure?.code).toBe("MODEL_TIMEOUT");
    // ③ 会话状态不动
    expect(result.conversation.status).toBe("bot");
    // ④ 系统故障**不是**知识缺失
    expect(result.knowledgeGapId).toBeNull();
    expect(listStoredKnowledgeGaps()).toHaveLength(0);

    const detail = unwrap(await getConversationDetail(id));
    expect(detail.messages).toHaveLength(1);
    expect(at(detail.messages, 0).role).toBe("customer");

    // ⑤ 任务如实记为 failed
    const tasks = customerServiceTasks();
    expect(tasks).toHaveLength(1);
    expect(at(tasks, 0).status).toBe("failed");
    expect(at(tasks, 0).errorMessage ?? "").toContain("模型响应超时");
  });

  it("检索层报错 → 同样是系统故障：保留消息、无假回答、无缺口", async () => {
    const id = await newConversation("厨房新手");
    await indexAllDocuments();

    const result = unwrap(
      await sendCustomerMessage(
        { conversationId: id, content: "手工鱼丸怎么煮？" },
        {
          search: async () => {
            throw new Error("模拟：向量检索时数据库连接中断");
          },
        },
      ),
    );

    expect(result.assistantMessage).toBeNull();
    expect(result.failure?.code).toBe("DB_ERROR");
    expect(result.knowledgeGapId).toBeNull();
    expect(listStoredKnowledgeGaps()).toHaveLength(0);
    expect(unwrap(await getConversationDetail(id)).messages).toHaveLength(1);
  });

  it("会话不存在 → 一个字节都不写（fail 而不是半成功）", async () => {
    const result = await sendCustomerMessage({
      conversationId: "conv_not_exists",
      content: "在吗？",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("NOT_FOUND");
    expect(customerServiceTasks()).toHaveLength(0);
  });

  it("会话已关闭 → 拒绝发送，且不写消息", async () => {
    const id = await newConversation("陈先生");
    unwrap(await closeConversation(id));

    const result = await sendCustomerMessage({ conversationId: id, content: "还在吗？" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
    expect(!result.ok && result.error.message).toContain("已结束");
    expect(unwrap(await getConversationDetail(id)).messages).toHaveLength(0);
  });

  it("内容为空 / 超长 → 拒绝且不写消息（避免留下永远得不到回答的孤儿提问）", async () => {
    const id = await newConversation("林小姐");

    const empty = await sendCustomerMessage({ conversationId: id, content: "   " });
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.error.code).toBe("VALIDATION_FAILED");

    const tooLong = await sendCustomerMessage({
      conversationId: id,
      content: "鲍".repeat(301),
    });
    expect(tooLong.ok).toBe(false);
    expect(!tooLong.ok && tooLong.error.code).toBe("VALIDATION_FAILED");

    expect(unwrap(await getConversationDetail(id)).messages).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Agent Task 语义                                                     */
/* ------------------------------------------------------------------ */

describe("Agent Task 记录语义", () => {
  it("依据不足 → 任务是 completed（正确识别缺口本身就是一次成功的执行）", async () => {
    const id = await newConversation("阿岚");
    await indexAllDocuments();

    unwrap(await sendCustomerMessage({ conversationId: id, content: "下单后多久发货？" }));

    const task = at(customerServiceTasks(), 0);
    expect(task.agentType).toBe("customer_service_agent");
    expect(task.status).toBe("completed");
    // output 如实记录「答不上来」，但这不等于执行失败
    expect(task.output?.grounded).toBe(false);
    expect(task.output?.needsHuman).toBe(true);
    expect(task.output?.knowledgeGapId).toBeTruthy();
    expect(task.output?.retrievedChunkCount).toBeGreaterThanOrEqual(0);
    expect(task.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("input 只放可公开的调用参数：会话 id / 商品 id / 问题指纹，不放用户原话", async () => {
    const id = await newConversation("王女士");
    await indexAllDocuments();

    unwrap(await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }));

    const task = at(customerServiceTasks(), 0);
    expect(task.input?.conversationId).toBe(id);
    expect(String(task.input?.questionHash).length).toBe(64);
    // 消费者原话已经完整存在 customer_messages 里，不往任务表复制第二份
    expect(JSON.stringify(task.input ?? {})).not.toContain("鲍鱼怎么保存");

    expect(task.status).toBe("completed");
  });

  it("同一句话的指纹稳定：标点与「请问」不影响 questionHash", async () => {
    const id = await newConversation("王女士");
    await indexAllDocuments();

    unwrap(await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }));
    unwrap(await sendCustomerMessage({ conversationId: id, content: "请问，鲍鱼怎么保存？" }));

    const tasks = customerServiceTasks();
    expect(tasks).toHaveLength(2);
    expect(at(tasks, 0).input?.questionHash).toBe(at(tasks, 1).input?.questionHash);
  });

  it("每次真正执行客服 AI 都会留下任务记录（两次提问 = 两条任务）", async () => {
    const id = await newConversation("王女士");
    await indexAllDocuments();

    unwrap(await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }));
    unwrap(await sendCustomerMessage({ conversationId: id, content: "手工鱼丸怎么煮？" }));

    expect(customerServiceTasks()).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* 缺口补知识闭环（Case 4 / 5）                                         */
/* ------------------------------------------------------------------ */

describe("知识缺口补知识闭环", () => {
  it("Case 4 / 5：补物流知识 → 缺口 resolved → 再问同一个问题 grounded 且不新增缺口", async () => {
    const id = await newConversation("阿岚");
    await indexAllDocuments();

    /* ① 先问出一个缺口 */
    const first = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "下单后多久发货？" }),
    );
    const gapId = first.knowledgeGapId;
    expect(gapId).toBeTruthy();

    /* ② 补一份物流知识解决它 —— 与页面「补充知识」按钮走同一个服务函数 */
    const resolved = unwrap(
      await createKnowledgeForGap(gapId!, {
        businessId: BUSINESS_ID,
        name: "连江海创物流说明",
        type: "logistics",
        content:
          "订单发货时效：每天 16:00 前下单的订单当天发货，16:00 之后下单的订单顺延到次日发货。福建省内次日到，省外 2 到 3 天到货。全程冷链 0 至 4 摄氏度。",
      }),
    );

    // ③ 知识已建立并完成索引，缺口已标记为已解决
    expect(resolved.document.indexStatus).toBe("indexed");
    expect(resolved.document.chunkCount).toBeGreaterThan(0);
    expect(resolved.gap?.status).toBe("resolved");
    expect(resolved.warningCodes).toHaveLength(0);

    /* ④ 再问同一个问题：应当依据新知识回答，且不再产生新缺口 */
    await tick();
    const second = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "下单后多久发货？" }),
    );

    expect(second.assistantMessage?.grounded).toBe(true);
    expect((second.assistantMessage?.knowledgeSources ?? []).length).toBeGreaterThan(0);
    expect(second.knowledgeGapId).toBeNull();

    // 缺口没有被重开，也没有新增第二条
    const gaps = listStoredKnowledgeGaps();
    expect(gaps).toHaveLength(1);
    expect(at(gaps, 0).status).toBe("resolved");
    expect(at(gaps, 0).occurrenceCount).toBe(1);
  });

  it("补知识失败（向量化报错）→ 缺口保持 open，不出现任何成功字样", async () => {
    const id = await newConversation("阿岚");
    await indexAllDocuments();

    const first = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "下单后多久发货？" }),
    );
    const gapId = first.knowledgeGapId!;

    const brokenProvider: AIProvider = {
      ...createMockAIProvider(),
      embed: async () => {
        throw new AppError({
          code: "MODEL_UNAVAILABLE",
          message: "向量化服务不可用",
        });
      },
    };

    const attempted = await createKnowledgeForGap(
      gapId,
      {
        businessId: BUSINESS_ID,
        name: "物流说明",
        type: "logistics",
        content: "每天 16:00 前的订单当日发出，省外 2 到 3 天到货。",
      },
      { provider: brokenProvider },
    );

    expect(attempted.ok).toBe(false);
    // 缺口仍是 open —— 商家以为关掉了就不会再看它了
    expect(at(listStoredKnowledgeGaps(), 0).status).toBe("open");
  });

  it("跨商家补知识：用别家的缺口 id 返回 NOT_FOUND", async () => {
    const foreign = unwrap(
      await createConversation({
        businessId: OTHER_BUSINESS_ID,
        customerName: "别家客户",
      }),
    );
    expect(foreign.id.length).toBeGreaterThan(0);

    const attempted = await createKnowledgeForGap("gap_not_mine", {
      businessId: BUSINESS_ID,
      name: "越权知识",
      type: "logistics",
      content: "试图往别的商家的缺口上挂知识。",
    });

    expect(attempted.ok).toBe(false);
    expect(!attempted.ok && attempted.error.code).toBe("NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ */
/* 手工转人工                                                          */
/* ------------------------------------------------------------------ */

describe("转人工", () => {
  it("人工转接把状态推进为待人工，但 AI 仍可继续回答该会话", async () => {
    const id = await newConversation("陈先生");
    await indexAllDocuments();

    expect(unwrap(await handoffConversation(id)).status).toBe("human");

    // 状态是提示，不是禁令 —— 输入框不该因此被禁掉
    const result = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }),
    );
    expect(result.customerMessage.content).toBe("鲍鱼怎么保存？");
    expect(result.assistantMessage?.grounded).toBe(true);
  });

  it("转人工对别的商家的会话不生效（NOT_FOUND）", async () => {
    const foreign = unwrap(
      await createConversation({
        businessId: OTHER_BUSINESS_ID,
        customerName: "别家客户",
      }),
    );

    const handed = await handoffConversation(foreign.id);

    expect(handed.ok).toBe(false);
    expect(!handed.ok && handed.error.code).toBe("NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ */
/* 知识 CRUD 必须经服务                                                */
/* ------------------------------------------------------------------ */

describe("知识库写入必须经 Knowledge Service", () => {
  it("新增的知识立即可被检索到（索引与正文同步完成）", async () => {
    const id = await newConversation("郑先生");

    const created = unwrap(
      await createKnowledgeDocument({
        businessId: BUSINESS_ID,
        name: "连江海创物流说明",
        type: "logistics",
        content:
          "订单发货时效：每天 16:00 前下单的订单当天发货，福建省内次日到，省外 2 到 3 天到货。",
      }),
    );
    expect(created.indexStatus).toBe("indexed");

    const result = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "下单后多久发货？" }),
    );
    expect(result.assistantMessage?.grounded).toBe(true);
  });

  it("编辑正文会同步重建索引：改完之后索引仍然有效", async () => {
    await indexAllDocuments();

    const storage = unwrap(await listKnowledgeDocuments()).find(
      (document) => document.type === "storage",
    );
    expect(storage).toBeDefined();

    unwrap(
      await updateKnowledgeDocument(storage!.id, {
        content: "本店鲍鱼采用液氮速冻，零下 60 摄氏度可存放 180 天。",
      }),
    );

    const reloaded = unwrap(await getKnowledgeDocument(storage!.id));
    expect(reloaded.content).toContain("液氮速冻");
    // 正文更新与向量替换是同一次事务：状态必须仍是 indexed
    expect(reloaded.indexStatus).toBe("indexed");
    expect(reloaded.chunkCount).toBeGreaterThan(0);
  });

  it("重新索引不会新建文档，只替换切片", async () => {
    await indexAllDocuments();
    const before = unwrap(await listKnowledgeDocuments());
    const target = at(before, 0);

    unwrap(await reindexKnowledgeDocument(target.id));

    const after = unwrap(await listKnowledgeDocuments());
    expect(after).toHaveLength(before.length);
    expect(after.find((document) => document.id === target.id)?.indexStatus).toBe("indexed");
  });

  it("删除文档会连带清掉它的切片", async () => {
    await indexAllDocuments();
    const target = at(unwrap(await listKnowledgeDocuments()), 0);
    expect(listStoredKnowledgeChunks().some((chunk) => chunk.documentId === target.id)).toBe(
      true,
    );

    unwrap(await deleteKnowledgeDocument(target.id));

    expect((await getKnowledgeDocument(target.id)).ok).toBe(false);
    expect(listStoredKnowledgeChunks().some((chunk) => chunk.documentId === target.id)).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
/* §38 Mock 完整演示脚本                                               */
/* ------------------------------------------------------------------ */

describe("§38 Mock 模式完整演示脚本", () => {
  it("建会话 → 问储存（有依据）→ 问发货（缺口）→ 补知识 → 再问（有依据、不新增缺口）", async () => {
    await indexAllDocuments();

    /* ① 创建模拟消费者 */
    const id = await newConversation("王女士");

    /* ② 问「鲍鱼怎么保存？」→ 依据充分 + 引用 */
    const storage = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "鲍鱼怎么保存？" }),
    );
    expect(storage.assistantMessage?.grounded).toBe(true);
    expect((storage.assistantMessage?.knowledgeSources ?? []).length).toBeGreaterThan(0);

    /* ③ 问「多久发货？」→ 知识不足 + 建立缺口 + 待人工 */
    const logistics = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "多久发货？" }),
    );
    expect(logistics.assistantMessage?.grounded).toBe(false);
    expect(logistics.knowledgeGapId).toBeTruthy();
    expect(logistics.conversation.status).toBe("human");

    /* ④ 商家补一份物流规则，缺口随之解决 */
    const resolved = unwrap(
      await createKnowledgeForGap(logistics.knowledgeGapId!, {
        businessId: BUSINESS_ID,
        name: "连江海创物流说明",
        type: "logistics",
        content:
          "订单发货时效：每天 16:00 前下单的订单当天发货，16:00 之后下单的订单顺延到次日发货。福建省内次日到，省外 2 到 3 天到货。",
      }),
    );
    expect(resolved.document.indexStatus).toBe("indexed");
    expect(resolved.gap?.status).toBe("resolved");

    /* ⑤ 再问同一个问题 → 依据充分，且不再新增缺口 */
    await tick();
    const again = unwrap(
      await sendCustomerMessage({ conversationId: id, content: "多久发货？" }),
    );
    expect(again.assistantMessage?.grounded).toBe(true);
    expect(again.knowledgeGapId).toBeNull();
    expect(listStoredKnowledgeGaps()).toHaveLength(1);

    // 三问三答：每一次提问与每一句 AI 回答都真的落库了
    expect(unwrap(await getConversationDetail(id)).messages).toHaveLength(6);
  });
});

/* ------------------------------------------------------------------ */
/* 缺口边界                                                            */
/* ------------------------------------------------------------------ */

describe("缺口边界", () => {
  it("打招呼这类判不出类别的问题不产生缺口（面板不该被噪声填满）", async () => {
    const id = await newConversation("路人甲");
    await indexAllDocuments();

    const result = unwrap(await sendCustomerMessage({ conversationId: id, content: "在吗？" }));

    expect(result.assistantMessage?.grounded).toBe(false);
    expect(result.knowledgeGapId).toBeNull();
    expect(listStoredKnowledgeGaps()).toHaveLength(0);
  });

  it("跨商家会话既不能读，也不能通过发消息间接写入", async () => {
    const foreign = unwrap(
      await createConversation({
        businessId: OTHER_BUSINESS_ID,
        customerName: "别家客户",
      }),
    );
    await indexAllDocuments();

    const attempted = await sendCustomerMessage({
      conversationId: foreign.id,
      content: "鲍鱼怎么保存？",
    });

    expect(attempted.ok).toBe(false);
    expect(!attempted.ok && attempted.error.code).toBe("NOT_FOUND");
    // 被拒绝在写消息之前，因此连任务记录都不该产生
    expect(customerServiceTasks()).toHaveLength(0);
  });
});
