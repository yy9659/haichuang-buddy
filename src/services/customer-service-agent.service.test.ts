/**
 * 客服问答闭环（含知识缺口接线）单测（S5 · Task 78）
 *
 * 覆盖任务书第十六节的 Case 9 / 10 / 11 与第十七节的**完整业务链路**。
 *
 * 这组用例的重心不是「缺口能不能写进去」，而是**两条界线**：
 *
 * 1. **什么情况不该记缺口。** 模型超时、检索层报错都属于系统故障，
 *    把它们记成「知识库里没有答案」，商家会去补一份根本不缺的知识，
 *    而真正的问题（通道挂了 / 数据库挂了）被埋在缺口列表里。
 * 2. **缺口写失败不许影响回答。** 消费者已经拿到一句安全的「已转人工」，
 *    那句话是对的，不该因为一条分析记录没落库而变成错误页。
 *
 * 链路用的是 Mock Provider，但 `embed` 与检索是**真实执行**的
 * （种子知识 → 切片 → 向量 → 检索 → 依据判定 → 缺口），
 * 不是「按问题查表返回预置答案」（任务书第三十三节禁止的做法）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import type { AIProvider } from "@/ai/provider/types";
import { resetServerEnvCache } from "@/lib/env";
import { MOCK_BUSINESS } from "@/lib/mock";
import { AppError } from "@/lib/result";
import { listStoredKnowledgeGaps, resetStoredKnowledge } from "@/repositories/mock/store";

import {
  createKnowledgeForGap,
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
} from "./knowledge.service";
import { answerCustomerQuestion } from "./customer-service-agent.service";

/**
 * 先归一化环境再取仓储：`getRepositories()` 在 DATA_SOURCE=db 且缺少连接串时
 * 会直接抛错，放在模块顶层就会让整个测试文件加载失败。
 */
process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

/** 单商家 Demo 的商家 id */
const BUSINESS_ID = MOCK_BUSINESS.id;

/**
 * 模拟「缺口表写入失败」。
 *
 * 为什么用模块级替换而不是给服务加一个「注入缺口仓储」的开关：
 * 那个开关只存在于测试里，会让被验证的代码路径与生产路径不是同一条；
 * 而这里被替换的只有仓储的**一个方法**，服务层的降级逻辑照常执行。
 *
 * 开关默认关闭，因此同一个文件里的其余用例走的都是真实实现。
 */
const gapWriteFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("@/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/repositories")>();
  return {
    ...actual,
    getRepositories: () => {
      const repositories = actual.getRepositories();
      if (!gapWriteFailure.enabled) {
        return repositories;
      }
      return {
        ...repositories,
        knowledgeGaps: {
          ...repositories.knowledgeGaps,
          recordOccurrence: async () => {
            throw new Error("模拟：缺口表写入失败");
          },
        },
      };
    },
  };
});

/* ------------------------------------------------------------------ */
/* 测试辅助                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把种子文档跑一遍真实索引流程。
 *
 * 这里调用**知识服务**（`reindexKnowledgeDocument`），而不是在测试里手抄
 * 「切片 → 向量 → 写切片表 → 标 indexed」那几步 —— 手抄的版本是生产流程的复制品，
 * 复制品与服务分叉之后，这组用例就不再覆盖真实路径了。
 */
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

function ask(
  question: string,
  options: Parameters<typeof answerCustomerQuestion>[1] = {},
) {
  return answerCustomerQuestion(
    { question, businessId: BUSINESS_ID, productId: null },
    options,
  );
}

beforeEach(() => {
  resetStoredKnowledge();
  gapWriteFailure.enabled = false;
});

/* ------------------------------------------------------------------ */
/* Case 9–10：系统故障不记缺口                                          */
/* ------------------------------------------------------------------ */

describe("系统故障与知识缺失必须分开", () => {
  it("Case 9：模型超时（MODEL_TIMEOUT）不得创建知识缺口", async () => {
    await indexAllDocuments();

    const provider: AIProvider = {
      ...createMockAIProvider(),
      embed: async () => {
        throw new AppError({
          code: "MODEL_TIMEOUT",
          message: "模型响应超时",
          detail: "请求超过 90s 未返回",
        });
      },
    };

    const result = await ask("多久发货？", { provider });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("MODEL_TIMEOUT");
    // 这是系统故障，不是「知识库里没有答案」——商家不需要去补一份并不缺的知识
    expect(listStoredKnowledgeGaps()).toHaveLength(0);
  });

  it("Case 10：检索层报错（数据库异常）不得创建知识缺口", async () => {
    await indexAllDocuments();

    const result = await ask("多久发货？", {
      search: async () => {
        throw new Error("模拟：向量检索时数据库连接中断");
      },
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("DB_ERROR");
    expect(listStoredKnowledgeGaps()).toHaveLength(0);
  });

  it("消费者输入非法（空问题）不得创建知识缺口", async () => {
    await indexAllDocuments();

    const result = await ask("   ");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
    expect(listStoredKnowledgeGaps()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Case 11：缺口写入失败不能拖垮回答                                    */
/* ------------------------------------------------------------------ */

describe("Case 11：缺口写入失败的降级", () => {
  it("客服的安全回答照常返回，失败只降级为告警", async () => {
    await indexAllDocuments();
    gapWriteFailure.enabled = true;

    const result = await ask("多久发货？");

    // ① 整体不能变成失败 —— 那不是消费者的问题
    if (!result.ok) {
      throw new Error(
        `缺口写入失败不应让问答失败，实际返回 ${result.error.code}：${result.error.message}`,
      );
    }

    // ② 消费者拿到的仍然是一句安全的、判定为「依据不足、请转人工」的回答
    expect(result.data.answer.grounded).toBe(false);
    expect(result.data.answer.needsHuman).toBe(true);
    expect(result.data.answer.citations).toHaveLength(0);

    // ③ 缺口没记上，但这件事必须被如实报告出来，而不是静默吞掉
    expect(result.data.knowledgeGap).toBeNull();
    expect(result.data.warningCodes).toContain("knowledge_gap_record_failed");
    expect(result.data.warnings.join("|")).toContain("知识缺口未能记录");
    expect(listStoredKnowledgeGaps()).toHaveLength(0);
  });

  it("缺口写入正常时不出现降级告警码", async () => {
    await indexAllDocuments();

    const result = await ask("多久发货？");

    if (!result.ok) {
      throw new Error(`期望成功，实际失败：${result.error.message}`);
    }
    expect(result.data.warningCodes).toHaveLength(0);
    expect(result.data.knowledgeGap?.occurrenceCount).toBe(1);
  });

  it("依据充分时不记缺口，因此也不会出现缺口相关的告警码", async () => {
    await indexAllDocuments();

    const result = await ask("鲍鱼怎么保存比较好？");

    if (!result.ok) {
      throw new Error(`期望成功，实际失败：${result.error.message}`);
    }
    expect(result.data.answer.grounded).toBe(true);
    expect(result.data.knowledgeGap).toBeNull();
    expect(result.data.warningCodes).toHaveLength(0);
    expect(listStoredKnowledgeGaps()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 缺口的意图与说明必须来自问题本身                                     */
/* ------------------------------------------------------------------ */

describe("缺口的意图分类", () => {
  /**
   * 这组用例钉住的是 Mock Provider 的一个真实缺陷（Task 78 接入缺口时才暴露）：
   * 原先意图取自「排在最前的那个片段的文档类型」，而在**依据不足**场景下，
   * 排第一的片段本身就是一次弱匹配 —— 「多久发货？」被判成 `after_sales`、
   * 「多久能到？」被判成 `storage`，于是缺口面板显示「缺少售后与赔付政策说明」
   * 去对应一个物流问题。商家据此补的知识自然也是错的。
   */
  it("物流问题被归类为 logistics，缺什么说明也指向物流", async () => {
    await indexAllDocuments();

    const result = await ask("多久发货？");

    if (!result.ok) {
      throw new Error(`期望成功，实际失败：${result.error.message}`);
    }
    expect(result.data.answer.grounded).toBe(false);
    expect(result.data.answer.intent).toBe("logistics");
    expect(result.data.answer.knowledgeGap).toContain("物流");
  });

  it("同义但换了说法的物流问题也不会被归到别的类目", async () => {
    await indexAllDocuments();

    const result = await ask("多久能到？我明天要送人。");

    if (!result.ok) {
      throw new Error(`期望成功，实际失败：${result.error.message}`);
    }
    expect(result.data.answer.grounded).toBe(false);
    expect(result.data.answer.intent).toBe("logistics");
  });

  it("知识库完全没有覆盖、但类别明确的问题同样会记缺口", async () => {
    await indexAllDocuments();

    // 零命中且原先硬编码 intent=other ⇒ 整条缺口被静默吞掉，
    // 而「价格与优惠」确实是这个知识库里没有的内容
    const result = await ask("你们有优惠吗？");

    if (!result.ok) {
      throw new Error(`期望成功，实际失败：${result.error.message}`);
    }
    expect(result.data.answer.grounded).toBe(false);
    expect(result.data.answer.intent).toBe("price");
    expect(result.data.knowledgeGap?.occurrenceCount).toBe(1);
    expect(listStoredKnowledgeGaps()).toHaveLength(1);
  });

  it("打招呼这类连类别都判不出来的问题不记缺口（面板不该被噪声填满）", async () => {
    await indexAllDocuments();

    const result = await ask("在吗？");

    if (!result.ok) {
      throw new Error(`期望成功，实际失败：${result.error.message}`);
    }
    expect(result.data.answer.intent).toBe("other");
    expect(result.data.knowledgeGap).toBeNull();
    expect(listStoredKnowledgeGaps()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* §17：完整业务链路                                                    */
/* ------------------------------------------------------------------ */

describe("完整链路：答不上来 → 记缺口 → 补知识 → 不再记缺口", () => {
  /**
   * 用「下单后多久发货？」而不是种子消费者里的「多久能到？我明天要送人。」——
   * 后者在商家补齐物流政策后**依然**判依据不足：政策文档里不会出现「明天要送人」，
   * 而词面覆盖度要求「问题里的词出现在材料里」。同义改写在词袋检索下找不回来，
   * 这是 Mock 检索的已知边界（任务书第七节），不是可以靠调阈值绕过的。
   */
  const QUESTION = "下单后多久发货？";

  const LOGISTICS_DOC = {
    name: "发货与物流说明",
    type: "logistics" as const,
    summary: "每日 16:00 前下单当日发出，省内次日达。",
    content: `发货与物流说明

发货时间

每日 16:00 前下单，当天安排发出。16:00 之后下单，顺延到第二天发出。

配送时效

福建省内通常次日送达，华东与华南地区次日到隔日送达。偏远地区顺延一到两天。

到货时间以物流公司实际派送为准，节假日可能延长。`,
  };

  it("第一次问出缺口 → 第二次计数累加 → 补知识后 resolve → 第三次有依据且不再新增计数", async () => {
    await indexAllDocuments();

    /* ① 知识库没有物流时效：检索正常完成，但依据不足 */
    const first = await ask(QUESTION);
    if (!first.ok) {
      throw new Error(`依据不足也应返回成功，实际失败：${first.error.message}`);
    }
    expect(first.data.answer.grounded).toBe(false);
    expect(first.data.answer.needsHuman).toBe(true);
    expect(first.data.answer.knowledgeGap).toContain("物流");
    expect(first.data.knowledgeGap?.status).toBe("open");
    expect(first.data.knowledgeGap?.occurrenceCount).toBe(1);
    expect(listStoredKnowledgeGaps()).toHaveLength(1);

    const gapId = first.data.knowledgeGap!.id;

    /* ② 同一个问题再问一次：仍然只有一条，计数变成 2 */
    const second = await ask(QUESTION);
    if (!second.ok) {
      throw new Error(`期望成功，实际失败：${second.error.message}`);
    }
    expect(second.data.knowledgeGap?.id).toBe(gapId);
    expect(second.data.knowledgeGap?.occurrenceCount).toBe(2);
    expect(listStoredKnowledgeGaps()).toHaveLength(1);

    /* ③ 商家针对这条缺口补一份物流说明：建文档 → 切片 → 向量 → 索引 → 标记缺口已解决 */
    const supplemented = await createKnowledgeForGap(gapId, {
      businessId: BUSINESS_ID,
      name: LOGISTICS_DOC.name,
      type: LOGISTICS_DOC.type,
      summary: LOGISTICS_DOC.summary,
      content: LOGISTICS_DOC.content,
    });
    if (!supplemented.ok) {
      throw new Error(`补知识失败：${supplemented.error.message}`);
    }
    // 索引成功与缺口解决是同一次调用的结果，二者必须一致
    expect(supplemented.data.document.indexStatus).toBe("indexed");
    expect(supplemented.data.warningCodes).toHaveLength(0);
    expect(supplemented.data.gap?.status).toBe("resolved");
    expect(supplemented.data.gap?.resolvedDocumentId).toBe(supplemented.data.document.id);

    const documentId = supplemented.data.document.id;

    /* ④ 同一个问题再问：现在依据充分，缺口既不被重开、计数也不再增长 */
    const third = await ask(QUESTION);
    if (!third.ok) {
      throw new Error(`补充知识后应能回答，实际失败：${third.error.message}`);
    }
    expect(third.data.answer.grounded).toBe(true);
    expect(third.data.answer.needsHuman).toBe(false);
    expect(third.data.answer.citations.map((item) => item.title)).toContain(
      LOGISTICS_DOC.name,
    );
    expect(third.data.knowledgeGap).toBeNull();

    const stored = listStoredKnowledgeGaps().find((gap) => gap.id === gapId);
    expect(stored?.status).toBe("resolved");
    expect(stored?.resolvedDocumentId).toBe(documentId);
    expect(stored?.occurrenceCount).toBe(2);

    /* ⑤ 反证：把商家补的那份知识去掉，同一问题必须重新被判为答不上来并**重开**缺口 */
    const removed = await deleteKnowledgeDocument(documentId);
    if (!removed.ok) {
      throw new Error(`删除知识失败：${removed.error.message}`);
    }

    const fourth = await ask(QUESTION);
    if (!fourth.ok) {
      throw new Error(`期望成功，实际失败：${fourth.error.message}`);
    }
    expect(fourth.data.answer.grounded).toBe(false);
    expect(fourth.data.knowledgeGap?.id).toBe(gapId);
    expect(fourth.data.knowledgeGap?.status).toBe("open");
    expect(fourth.data.knowledgeGap?.occurrenceCount).toBe(3);
  });
});
