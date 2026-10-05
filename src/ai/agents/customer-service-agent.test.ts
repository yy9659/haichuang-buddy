/**
 * Customer Service Agent 单测（S5）
 *
 * 覆盖任务书第三十九节的 Grounding / Citation 两组，以及第四十节的四个关键 Case。
 *
 * 这套用例的特点是**真的跑完整条链路**：种子知识 → 切片 → 向量 → 检索 → 依据判定 →
 * 结构化生成 → 引用校验。用的是 Mock Provider，但 `embed` 与检索是真实执行的
 * （不是「按问题查表返回预置答案」—— 那正是任务书第三十三节禁止的做法）。
 * 因此这些断言在换成真实模型后依然有意义：它们验证的是我们自己写的判定与校验逻辑。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { runCustomerServiceAgent } from "@/ai/agents/customer-service-agent";
import { createMockAIProvider } from "@/ai/provider/mock";
import { resetServerEnvCache } from "@/lib/env";
import { MOCK_BUSINESS } from "@/lib/mock";
import type { AppError } from "@/lib/result";
import { createMockKnowledgeChunkRepository } from "@/repositories/mock/knowledge";
import { resetStoredKnowledge } from "@/repositories/mock/store";
import type { KnowledgeChunkSearchHit, KnowledgeSearchParams } from "@/repositories/types";
import {
  createKnowledgeDocument,
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
} from "@/services/knowledge.service";

/**
 * 先归一化环境再取仓储：`getRepositories()`（知识服务内部用它）
 * 在 DATA_SOURCE=db 且缺少连接串时会直接抛错。
 */
process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

/** 单商家 Demo 的商家 id（Mock 数据源的 id 空间） */
const BUSINESS_ID = MOCK_BUSINESS.id;

/**
 * 把种子文档跑一遍真实索引流程（切片 → 向量 → 写切片表 → 标记 indexed）。
 *
 * 这里**调用知识服务**，而不是在测试里手抄一遍那几步。
 * 手抄的版本曾经存在过，问题很实在：它与服务分叉之后，
 * 这组用例验证的就是一份复制品 —— 复制品对，不代表生产路径对。
 * 索引参数、切片规则、向量校验都只有一份实现，测试才有意义。
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

/** 商家补一份知识（服务会同步建好索引），返回它的 id */
async function addKnowledge(input: {
  name: string;
  type: "logistics";
  summary: string;
  content: string;
}): Promise<string> {
  const created = await createKnowledgeDocument({
    businessId: BUSINESS_ID,
    name: input.name,
    type: input.type,
    summary: input.summary,
    content: input.content,
    productId: null,
  });
  if (!created.ok) {
    throw new Error(`补充知识失败：${created.error.code} ${created.error.message}`);
  }
  return created.data.id;
}

/** Agent 需要的检索依赖：直接接 Mock 仓储，Agent 自己不知道数据在哪 */
function buildDeps(provider = createMockAIProvider()) {
  const chunkRepository = createMockKnowledgeChunkRepository();
  const search = (params: KnowledgeSearchParams): Promise<KnowledgeChunkSearchHit[]> =>
    chunkRepository.searchSimilar(params);
  return { provider, search };
}

async function ask(
  question: string,
  overrides: {
    provider?: ReturnType<typeof createMockAIProvider>;
    productId?: string | null;
  } = {},
) {
  const provider = overrides.provider ?? createMockAIProvider();
  return runCustomerServiceAgent(
    {
      question,
      businessId: BUSINESS_ID,
      productId: overrides.productId ?? null,
    },
    buildDeps(provider),
  );
}

beforeEach(() => {
  // 每个用例从种子知识重新索引，避免用例之间互相看到对方补进去的文档
  resetStoredKnowledge();
});

describe("客服 Agent · 依据判定", () => {
  it("知识库有《鲜活鲍鱼储存说明》时，「鲍鱼怎么保存」给出有依据的回答与引用", async () => {
    await indexAllDocuments();

    const result = await ask("鲍鱼怎么保存比较好？");
    if (!result.ok) {
      throw new Error(`期望成功，实际失败：${result.error.code} ${result.error.message}`);
    }

    expect(result.data.answer.grounded).toBe(true);
    expect(result.data.answer.needsHuman).toBe(false);
    expect(result.data.answer.citations.length).toBeGreaterThan(0);
    expect(result.data.answer.knowledgeGap).toBeNull();
    expect(result.data.needsKnowledgeGap).toBe(false);

    // 引用必须指向真实存在的文档，而不是「有引用」就够
    const citedTitles = result.data.answer.citations.map((item) => item.title);
    expect(citedTitles).toContain("鲜活鲍鱼储存说明");
    // 每条引用都要能追溯到 chunkId 与 documentId（任务书 4.3）
    for (const citation of result.data.answer.citations) {
      expect(citation.chunkId.length).toBeGreaterThan(0);
      expect(citation.documentId.length).toBeGreaterThan(0);
    }

    // 回答要真的用上知识内容（冷藏 / 冷冻），而不是通用话术
    expect(result.data.answer.answer).toMatch(/冷藏|冷冻|0-4/);
  });

  it("知识库没有发货时效时，「多久能到」判为依据不足并要求转人工", async () => {
    await indexAllDocuments();

    const result = await ask("多久能到？我明天要送人。");
    if (!result.ok) {
      throw new Error(`期望成功（依据不足也是成功），实际失败：${result.error.message}`);
    }

    expect(result.data.answer.grounded).toBe(false);
    expect(result.data.answer.needsHuman).toBe(true);
    expect(result.data.answer.citations).toHaveLength(0);
    expect(result.data.answer.knowledgeGap).toBeTruthy();
    // 事实类问题答不上来必须记缺口，商家才知道要补什么
    expect(result.data.needsKnowledgeGap).toBe(true);
    expect(result.data.retrieval.sufficient).toBe(false);
  });

  it("依据不足时不使用模型写的正文，只保留固定话术", async () => {
    await indexAllDocuments();

    const result = await ask("多久能到？");
    if (!result.ok) {
      throw new Error("期望成功");
    }
    expect(result.data.answer.answer).toContain("知识库");
    expect(result.data.answer.answer).toContain("转人工");
    // 置信度必须是低值，避免「依据不足 + 置信度 90%」的自相矛盾展示
    expect(result.data.answer.confidence).toBeLessThanOrEqual(0.5);
  });

  it("商家补充物流说明后，同一个问题变成有依据（任务书第四十节 Case ④）", async () => {
    await indexAllDocuments();

    /**
     * 用「下单后多久发货？」而不是上面那条「多久能到？」——
     * 这正是任务书第四十节 Case ④ 的问法（「多久发货？」），也是内置模拟消费者里的第 5 条。
     *
     * 两条问法问的是同一件事，但只有这一条能在补完政策后被答上来：
     * 词面覆盖度要求「问题里的词出现在材料里」，而《发货与物流说明》里
     * 不会出现「明天要送人」。同义改写在词袋检索下找不回来，
     * 这是 Mock 检索的已知边界（任务书第七节），不是可以靠调阈值绕过的问题 ——
     * 调低阈值只会同时把「多久能到」这类真答不上来的问题也判成有依据。
     */
    const QUESTION = "下单后多久发货？";

    const before = await ask(QUESTION);
    expect(before.ok && before.data.answer.grounded).toBe(false);

    // 商家补一份物流说明（任务书第四十节 Case ④ 的动作）。
    // 建完即可检索 —— 不需要重启、不需要手工重新索引
    await addKnowledge({
      name: "发货与物流说明",
      type: "logistics",
      summary: "每日 16:00 前下单当日发出，省内次日达。",
      content: `发货与物流说明

发货时间

每日 16:00 前下单，当天安排发出。16:00 之后下单，顺延到第二天发出。

配送时效

福建省内通常次日送达，华东与华南地区次日到隔日送达。偏远地区顺延一到两天。

到货时间以物流公司实际派送为准，节假日可能延长。`,
    });

    const after = await ask(QUESTION);
    if (!after.ok) {
      throw new Error(`补充知识后应能回答，实际失败：${after.error.message}`);
    }
    expect(after.data.retrieval.sufficient).toBe(true);
    expect(after.data.answer.grounded).toBe(true);
    expect(after.data.answer.needsHuman).toBe(false);
    expect(after.data.answer.citations.map((item) => item.title)).toContain(
      "发货与物流说明",
    );
  });

  it("打招呼这类非业务问题答不上来时不记知识缺口", async () => {
    await indexAllDocuments();

    // Mock 候选在零片段时给出 intent=other，正对应「不需要缺口」的路径
    const result = await ask("在吗？");
    if (!result.ok) {
      throw new Error("期望成功");
    }
    if (result.data.answer.intent === "other") {
      expect(result.data.needsKnowledgeGap).toBe(false);
    }
  });
});

describe("客服 Agent · 引用校验（任务书第四十节 Case ③）", () => {
  it("模型编造检索结果里不存在的 chunkId 时，整条回答被拒绝", async () => {
    await indexAllDocuments();

    const result = await ask("鲍鱼怎么保存？", {
      provider: createMockAIProvider({ scenario: "fabricated-citation" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("伪造引用必须导致失败");
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.message).toContain("引用");
    // 错误详情要能指出是哪一个 id 编的，否则排查时只能靠猜
    expect(result.error.detail).toContain("kchunk_fabricated");
  });

  it("被拒绝的回答不会产出任何引用（不存在「假引用被展示」的中间态）", async () => {
    await indexAllDocuments();

    const result = await ask("鲍鱼怎么保存？", {
      provider: createMockAIProvider({ scenario: "fabricated-citation" }),
    });
    // 失败时没有 data，因此调用方只能走降级路径，不可能拿到 answer.citations
    expect(result.ok).toBe(false);
    expect("data" in result).toBe(false);
  })
});

describe("客服 Agent · 输入与失败路径", () => {
  it("空问题 / 超长问题直接拒绝，不浪费一次模型调用", async () => {
    const empty = await ask("   ");
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe("VALIDATION_FAILED");
    }

    const tooLong = await ask("鲍".repeat(301));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("缺少商家标识时拒绝而不是放宽检索条件", async () => {
    await indexAllDocuments();

    const result = await runCustomerServiceAgent(
      { question: "鲍鱼怎么保存？", businessId: "  " },
      buildDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("检索层抛错时返回 DB_ERROR，而不是伪装成「知识库没有内容」", async () => {
    const result = await runCustomerServiceAgent(
      { question: "鲍鱼怎么保存？", businessId: BUSINESS_ID },
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

  it("向量化失败时返回 MODEL_UNAVAILABLE，与「没有知识」区分开", async () => {
    await indexAllDocuments();

    const result = await ask("鲍鱼怎么保存？", {
      provider: createMockAIProvider({ scenario: "unavailable" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as AppError;
      expect(["MODEL_UNAVAILABLE", "MODEL_TIMEOUT"]).toContain(error.code);
    }
  });
});
