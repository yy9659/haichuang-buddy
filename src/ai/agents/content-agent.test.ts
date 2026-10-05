/**
 * Content Agent 单测（S3-2 Task 3 / Task 7）
 *
 * 覆盖的是**流程边界**，不是「函数能跑」：
 *   - 正常路径产出的 draft 必须能通过契约、并带上可观测信息（attempts / repaired / warnings）；
 *   - **没有任何依据时直接拒绝，且一次模型都不调用** —— 这是本 Agent 最重要的一条纪律：
 *     没有 Product DNA 也没有品牌档案，模型只能靠「海产品」这个品类标签编文案；
 *   - **平台与形态以请求为准**：模型复述错不能改写槽位，但也不能静默丢弃这个信号；
 *   - 脏 JSON 能自愈一次，连续脏输出给出明确的 SCHEMA_INVALID（而不是白屏）；
 *   - 模型超时/不可用**直接透传错误码**，不做无意义重试；
 *   - 合规扫描只告警不改写：虚构产地 / 绝对化用语 / 禁用表达都要落到 warnings 与 riskNotes。
 */

import { describe, expect, it } from "vitest";

import {
  createMockAIProvider,
  MOCK_OUTPUT_MARKER,
} from "@/ai/provider/mock";
import type {
  AIProvider,
  GenerateTextInput,
} from "@/ai/provider/types";

import {
  hasContentGrounding,
  runContentAgent,
  scanContentRisks,
  type ContentAgentInput,
} from "./content-agent";
import { ContentAssetSchema } from "@/ai/schemas/content";
import { CONTENT_AGENT_SYSTEM_PROMPT } from "@/ai/prompts/content-agent";

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/** 一份表单上合法的内容产出（各用例在此基础上做变形） */
function draftPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: "douyin",
    type: "short-video",
    title: "会做饭的人，家里都常备一盒鲍鱼",
    hook: "连江鲍鱼 128 就能买到 500g，蒸 8 分钟直接上桌。",
    body: "很多人觉得鲍鱼是餐厅才吃得到的东西，其实在家做比想象中简单。\n\n刷洗干净上锅蒸 8 分钟就好。",
    scenes: ["0-2s 渔港晨景", "2-6s 手部刷洗特写", "6-12s 蒜蓉上锅"],
    tags: ["#连江鲍鱼", "#家庭海鲜"],
    callToAction: "点击下方商品，今晚就能安排。",
    visualSuggestions: ["开场用渔港晨雾航拍 2 秒", "结尾用全家夹菜的实拍画面"],
    voiceover: "连江的鲍鱼，当天捞当天发，回家蒸八分钟就是一道硬菜。",
    riskNotes: [],
    confidence: 0.62,
    ...overrides,
  };
}

/**
 * 固定输出的 Provider：只实现 `generateText`（结构化通道走的就是它），
 * 其余能力抛错，保证「用错了方法」能在测试里立刻暴露。
 */
function fixedProvider(
  payload: Record<string, unknown>,
  options: { id?: string; calls?: { count: number } } = {},
): AIProvider {
  return {
    id: options.id ?? "stub",
    async generateText(_input: GenerateTextInput): Promise<string> {
      if (options.calls) {
        options.calls.count += 1;
      }
      return JSON.stringify(payload);
    },
    async generateObject() {
      throw new Error("Content Agent 不应调用 generateObject");
    },
    async streamText() {
      throw new Error("Content Agent 不应调用 streamText");
    },
    async analyzeImage() {
      throw new Error("Content Agent 不应调用 analyzeImage");
    },
    async embed() {
      throw new Error("Content Agent 不应调用 embed");
    },
  };
}

/** 一份「依据充分」的输入：有商品 DNA + 品牌档案 + 老板分身 */
function groundedInput(
  overrides: Partial<ContentAgentInput> = {},
): ContentAgentInput {
  return {
    product: {
      name: "连江鲜活鲍鱼",
      category: "海产品",
      subCategory: "鲍鱼",
      origin: "福建连江 · 黄岐半岛",
      specification: "8-10 头 / 500g",
      priceText: "128 元 / 500g",
      dna: {
        coreFeatures: ["品类归属：海产品 · 鲍鱼", "产地：福建连江 · 黄岐半岛"],
        sellingPoints: ["当日现捞、肉质弹牙", "产地直发减少中间环节"],
        targetUsers: ["注重食材新鲜度的家庭主厨"],
        consumptionScenarios: ["家庭日常三餐", "节庆聚餐"],
        marketingAngles: ["产地溯源：从连江海域到餐桌"],
        visualFeatures: ["鲜活带壳，壳面洁净"],
      },
    },
    brand: {
      positioning: "连江黄岐半岛直发 · 家庭海鲜餐桌的稳定供应者",
      slogan: "从黄岐半岛，到你的餐桌。",
      brandStory: "陈老板在连江黄岐半岛长大，家里靠海吃海。",
      brandValues: ["产地真实可查"],
      targetAudience: ["年轻家庭"],
      brandKeywords: ["实在", "专业"],
      toneOfVoice: ["口语化", "像邻居介绍一样自然"],
      visualKeywords: ["海雾蓝", "晨光"],
    },
    ownerTwin: {
      displayName: "陈老板",
      avatarLabel: "陈",
      businessPhilosophy: ["真实", "诚信"],
      tone: ["亲切", "自然"],
      salesStyle: "专业介绍，不强迫消费",
      targetCustomers: ["年轻家庭"],
      forbiddenExpressions: ["绝对第一", "全网最低"],
    },
    request: { platform: "douyin", format: "short-video" },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 正常路径                                                         */
/* ------------------------------------------------------------------ */

describe("runContentAgent：正常路径", () => {
  it("图文配图说明超过旧版 60 字时一次通过，提示词明确长度约束", async () => {
    const calls = { count: 0 };
    const scene = "展示商品包装与冷冻保存方式，配上清晰的文字说明，突出家庭收货后能立即照做的步骤。".repeat(2);
    const result = await runContentAgent(
      groundedInput({ request: { platform: "xiaohongshu", format: "article" } }),
      {
        provider: fixedProvider(
          draftPayload({ platform: "xiaohongshu", type: "article", scenes: [scene] }),
          { calls },
        ),
      },
    );

    expect(scene.length).toBeGreaterThan(60);
    expect(result.ok).toBe(true);
    expect(calls.count).toBe(1);
    expect(CONTENT_AGENT_SYSTEM_PROMPT).toContain("scenes 返回 1~8 条");
    expect(CONTENT_AGENT_SYSTEM_PROMPT).toContain("不能超过 160 字");
  });

  it("Mock Provider 产出的 draft 通过契约，并带回可观测信息", async () => {
    const result = await runContentAgent(groundedInput(), {
      provider: createMockAIProvider(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const run = result.data;

    expect(run.providerId).toBe("mock");
    expect(run.platform).toBe("douyin");
    expect(run.format).toBe("short-video");
    expect(run.attempts).toBe(1);
    expect(run.repaired).toBe(false);

    // 契约字段全部有值
    expect(run.draft.title.length).toBeGreaterThan(0);
    expect(run.draft.hook.length).toBeGreaterThan(0);
    expect(run.draft.body.length).toBeGreaterThan(0);
    expect(run.draft.callToAction.length).toBeGreaterThan(0);
    expect(run.draft.scenes.length).toBeGreaterThan(0);
    expect(run.draft.tags.length).toBeGreaterThan(0);

    // Mock 产出必须自带「这是占位数据」的标记，避免被当成真实模型结论
    expect(run.draft.riskNotes.join()).toContain(MOCK_OUTPUT_MARKER);

    // 标签已归一成 # 形式（无论 Mock 原始写法如何）
    for (const tag of run.draft.tags) {
      expect(tag.startsWith("#")).toBe(true);
      expect(tag).not.toContain(" ");
    }
  });

  it("只有品牌档案、没有 Product DNA 时不拒绝，但必须如实告警卖点依据不足", async () => {
    const input = groundedInput();
    input.product.dna = null;

    const result = await runContentAgent(input, { provider: createMockAIProvider() });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.warnings.join()).toContain("尚未完成 AI 分析");
  });

  it("只有 Product DNA、没有品牌档案时不拒绝，但必须如实告警语气退化为通用口吻", async () => {
    const result = await runContentAgent(
      groundedInput({ brand: null }),
      { provider: createMockAIProvider() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.warnings.join()).toContain("尚未生成品牌档案");
  });
});

/* ------------------------------------------------------------------ */
/* 2. 零依据直接拒绝（本 Agent 最重要的一条纪律）                       */
/* ------------------------------------------------------------------ */

describe("runContentAgent：零依据直接拒绝", () => {
  it("既无 DNA 也无品牌档案时返回 VALIDATION_FAILED，且一次模型都不调用", async () => {
    const calls = { count: 0 };
    const emptyInput = groundedInput({ brand: null });
    emptyInput.product.dna = null;

    expect(hasContentGrounding(emptyInput)).toBe(false);

    const result = await runContentAgent(emptyInput, {
      provider: fixedProvider(draftPayload(), { calls }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.message).toContain("缺少可用于生成内容的依据");
    // 关键断言：拒绝发生在调用模型之前，不为一次注定失败的生成付费
    expect(calls.count).toBe(0);
  });

  it("DNA 是一个全空对象时不算依据", () => {
    const input = groundedInput({ brand: null });
    input.product.dna = {};
    expect(hasContentGrounding(input)).toBe(false);
  });

  it("品牌档案只有空字符串时不算依据", () => {
    const input = groundedInput();
    input.product.dna = null;
    input.brand = {
      positioning: "   ",
      slogan: "",
      brandValues: [],
      targetAudience: [],
      brandKeywords: [],
      toneOfVoice: [],
      visualKeywords: [],
    };
    expect(hasContentGrounding(input)).toBe(false);
  });

  it("入参本身不合法（平台写错）时返回 VALIDATION_FAILED，不触达模型", async () => {
    const calls = { count: 0 };
    const input = groundedInput();
    const bad = {
      ...input,
      request: { platform: "kuaishou", format: "short-video" },
    } as unknown as ContentAgentInput;

    const result = await runContentAgent(bad, {
      provider: fixedProvider(draftPayload(), { calls }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(calls.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 平台与形态以请求为准                                             */
/* ------------------------------------------------------------------ */

describe("runContentAgent：槽位以请求为准", () => {
  it("模型回传的平台/形态与请求不一致时按请求落库，并把不一致记进 warnings", async () => {
    const result = await runContentAgent(
      groundedInput({ request: { platform: "xiaohongshu", format: "article" } }),
      {
        provider: fixedProvider(
          draftPayload({ platform: "douyin", type: "short-video" }),
        ),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.draft.platform).toBe("xiaohongshu");
    expect(result.data.draft.type).toBe("article");
    // 不一致不能被静默吞掉
    expect(result.data.warnings.join()).toContain("模型回传的平台是");
    expect(result.data.warnings.join()).toContain("模型回传的内容形态是");
  });
});

/* ------------------------------------------------------------------ */
/* 4. 结构化输出纠错与失败                                             */
/* ------------------------------------------------------------------ */

describe("runContentAgent：结构化输出与故障", () => {
  it("场景超长时第二轮明确要求压缩该字段，而不是盲目重写", async () => {
    const prompts: string[] = [];
    const provider: AIProvider = {
      ...fixedProvider(draftPayload()),
      async generateText(input: GenerateTextInput) {
        prompts.push(input.prompt);
        return JSON.stringify(
          draftPayload({
            scenes: ["画".repeat(prompts.length === 1 ? 161 : 100)],
          }),
        );
      },
    };

    const result = await runContentAgent(groundedInput(), { provider });

    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("请逐条检查 scenes");
    expect(prompts[1]).toContain("绝不超过 160 字");
  });

  it("脏 JSON 能自愈一次，attempts=2 且 repaired=true", async () => {
    const result = await runContentAgent(groundedInput(), {
      provider: createMockAIProvider({ scenario: "messy-then-ok" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.attempts).toBe(2);
    expect(result.data.repaired).toBe(true);
  });

  it("连续脏输出时返回 SCHEMA_INVALID，而不是把半成品当成功", async () => {
    const result = await runContentAgent(groundedInput(), {
      provider: createMockAIProvider({ scenario: "always-invalid" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SCHEMA_INVALID");
  });

  it("模型超时直接透传 MODEL_TIMEOUT，不做无意义重试", async () => {
    const calls = { count: 0 };
    const provider = createMockAIProvider({ scenario: "timeout" });
    const counting: AIProvider = {
      ...provider,
      async generateText(input: GenerateTextInput) {
        calls.count += 1;
        return provider.generateText(input);
      },
    };

    const result = await runContentAgent(groundedInput(), { provider: counting });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MODEL_TIMEOUT");
    expect(calls.count).toBe(1);
  });

  it("模型不可用直接透传 MODEL_UNAVAILABLE", async () => {
    const result = await runContentAgent(groundedInput(), {
      provider: createMockAIProvider({ scenario: "unavailable" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MODEL_UNAVAILABLE");
  });
});

/* ------------------------------------------------------------------ */
/* 5. 合规扫描（只告警，不改写）                                        */
/* ------------------------------------------------------------------ */

describe("scanContentRisks：事实与合规扫描", () => {
  const baseInput = groundedInput();

  function parse(payload: Record<string, unknown>) {
    return ContentAssetSchema.parse(payload);
  }

  it("内容里出现输入资料没有的产地 → 记风险提示与告警", () => {
    const draft = parse(
      draftPayload({ body: "我们家的鲍鱼来自大连海域，当日现捞。" }),
    );
    const scan = scanContentRisks(draft, baseInput);

    expect(scan.notes.join()).toContain("疑似虚构产地");
    expect(scan.notes.join()).toContain("大连");
    expect(scan.warnings.join()).toContain("疑似虚构产地");
  });

  it("品牌档案里本来就有的产地表述不算内容编造", () => {
    // 品牌定位里写了「连江黄岐半岛」，内容跟着写是忠实复述而非编造
    const draft = parse(
      draftPayload({ body: "来自连江黄岐半岛的鲍鱼，当天捞当天发。" }),
    );
    const scan = scanContentRisks(draft, baseInput);
    expect(scan.notes.join()).not.toContain("疑似虚构产地");
  });

  it("绝对化用语 → 合规风险告警（广告法下不可用）", () => {
    const draft = parse(draftPayload({ hook: "全网最好的连江鲍鱼，第一名。" }));
    const scan = scanContentRisks(draft, baseInput);

    expect(scan.notes.join()).toContain("绝对化用语");
    expect(scan.warnings.join()).toContain("广告法");
  });

  it("命中老板数字分身的禁用表达 → 必须改写", () => {
    const draft = parse(draftPayload({ callToAction: "全网最低，绝对第一，快下单。" }));
    const scan = scanContentRisks(draft, baseInput);

    expect(scan.notes.join()).toContain("命中禁用表达");
    expect(scan.warnings.join()).toContain("禁用表达");
  });

  it("风险短词条被裁到 60 字以内，不会撑爆 Schema 的字段上限", () => {
    const draft = parse(
      draftPayload({
        body: "大连、舟山、青岛、挪威、智利、厄瓜多尔、北海道、越南、泰国、缅甸、澳大利亚、新西兰的海货我们都做。",
      }),
    );
    const scan = scanContentRisks(draft, baseInput);
    expect(scan.notes.length).toBeGreaterThan(0);
    for (const note of scan.notes) {
      expect(note.length).toBeLessThanOrEqual(60);
    }
  });

  it("扫描结论会并入 riskNotes 随内容留痕（不只是活在任务记录里）", async () => {
    const result = await runContentAgent(groundedInput(), {
      provider: fixedProvider(
        draftPayload({
          body: "我们家的鲍鱼全部来自大连，今日特价。",
          hook: "全网最好的鲍鱼，第一名。",
        }),
      ),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const notes = result.data.draft.riskNotes.join();
    expect(notes).toContain("疑似虚构产地");
    expect(notes).toContain("绝对化用语");
  });

  it("没发现风险时不硬造词条（空数组是合法结论）", async () => {
    const result = await runContentAgent(groundedInput(), {
      provider: fixedProvider(draftPayload()),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.draft.riskNotes).toEqual([]);
  });
});
