/**
 * 中文词元与词面覆盖度单测（S5 · 任务书第七 / 十一 / 十六节）
 *
 * 这两个函数是 RAG 检索的**共享地基**：Mock Provider 用它们构造确定性向量，
 * 检索层用它们算稀疏侧信号。因此它们必须能被穷举验证 ——
 * 一旦分词行为变了，向量与覆盖度会同时变，而两者的阈值是分开标定的，
 * 那种「改了分词、检索质量悄悄下降」是最难发现的一类退化。
 *
 * 用例只断言**性质**（确定、可复现、不跨标点、虚词被剔除、词频饱和），
 * 不断言具体权重数值 —— 权重是可调参数，性质不是。
 */

import { describe, expect, it } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import { cosineSimilarity, EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import {
  COVERAGE_TOKEN_CAP,
  createQueryCoverage,
  lexicalCoverage,
  MIN_COVERAGE_QUERY_TOKENS,
  tokenizeForEmbedding,
} from "@/lib/text-tokens";

/** 取词元名列表，便于「不含某个词」这类断言读起来像人话 */
function tokensOf(text: string): string[] {
  return tokenizeForEmbedding(text).map((item) => item.token);
}

function weightOf(text: string, token: string): number {
  return tokenizeForEmbedding(text).find((item) => item.token === token)?.weight ?? 0;
}

describe("tokenizeForEmbedding · 基本性质", () => {
  it("同一文本两次切分结果完全一致（向量可比的前提）", () => {
    const text = "鲜活鲍鱼储存说明：0-4℃ 冷藏，48 小时内食用。";
    expect(tokenizeForEmbedding(text)).toEqual(tokenizeForEmbedding(text));
  });

  it("空文本与纯标点产出空词元表，不抛错", () => {
    expect(tokenizeForEmbedding("")).toEqual([]);
    expect(tokenizeForEmbedding("，。！？  ")).toEqual([]);
  });

  it("拉丁词与数字各自成词（规格、型号要能原样匹配）", () => {
    const tokens = tokensOf("规格 2.5kg / 8-10 头");
    expect(tokens).toContain("2");
    expect(tokens).toContain("8");
    expect(tokens).toContain("10");
    /**
     * 已知的小瑕疵：`2.5kg` 会被切成 `2` 与 `5kg`（数字与单位粘连），
     * 而写成 `2.5 kg` 时会切成 `2` / `5` / `kg`。两种写法拿到的词元不完全一样。
     * 影响有限（同一份语料里规格写法是一致的，查询与文档能对上），
     * 但它确实是个瑕疵 —— 修它会改变所有向量的取值、连带作废已标定的检索阈值，
     * 因此这里把它**记录下来**而不是悄悄当成正确行为。
     */
    expect(tokens).toContain("5kg");
  });
});

describe("tokenizeForEmbedding · 三条刻意的修剪", () => {
  it("虚词单字被剔除（否则「怎么保存」与「怎么做」会互相靠拢）", () => {
    const tokens = tokensOf("这个怎么保存？");
    for (const stop of ["这", "个", "怎", "么", "的"]) {
      expect(tokens).not.toContain(stop);
    }
    expect(tokens).toContain("保");
    expect(tokens).toContain("存");
    expect(tokens).toContain("保存");
  });

  it("二字组只在连续汉字段内生成，不跨标点与数字", () => {
    /**
     * 早期实现把整段汉字抽成一个序列，于是会造出「盒适」「冷保」这类
     * 根本不存在的词 —— 它们没有语义，却会在 1024 维空间里大量互相碰撞，
     * 把「无关文本的相似度」抬到与真实信号同一量级。
     */
    const tokens = tokensOf("冷冻，密封保存");
    expect(tokens).toContain("冷冻");
    expect(tokens).toContain("密封");
    expect(tokens).not.toContain("冻密");

    const mixed = tokensOf("2.5kg 盒，适合");
    expect(mixed).not.toContain("盒适");
  });

  it("含虚词的二字组被丢弃（「鱼怎」「怎么」不是词）", () => {
    const tokens = tokensOf("鲍鱼怎么保存");
    expect(tokens).not.toContain("鱼怎");
    expect(tokens).not.toContain("怎么");
    expect(tokens).not.toContain("么保");
  });

  it("词频饱和：写三遍不等于三倍权重", () => {
    /**
     * 线性累加会奖励「啰嗦」—— 同一段里把「鲍鱼」写三遍的《礼盒说明》
     * 就能靠堆词压过真正讲储存的《储存说明》。
     */
    const once = weightOf("鲍鱼", "鲍鱼");
    const thrice = weightOf("鲍鱼鲍鱼鲍鱼", "鲍鱼");
    expect(thrice).toBeGreaterThan(once);
    expect(thrice).toBeLessThan(once * 3);
  });
});

describe("createQueryCoverage · 度量", () => {
  it("命中比例按「去重后的查询词元」计算，分母受上限约束", () => {
    const coverage = createQueryCoverage("鲍鱼保存");
    // 单字 4 个 + 二字组 3 个（鲍鱼 / 鱼保 / 保存）= 7，分母取 min(7, 上限 6) = 6
    expect(coverage.tokenCount).toBe(7);
    expect(coverage.measurable).toBe(true);
    expect(coverage.coverageOf("鲍鱼保存")).toBe(1);
    // 只命中「鲍 / 鱼 / 鲍鱼」三个 → 3 / 6
    expect(coverage.coverageOf("鲍鱼")).toBeCloseTo(3 / COVERAGE_TOKEN_CAP, 6);
  });

  it("分母有上限，长问句的铺垫不会把正确材料稀释掉", () => {
    /**
     * 「主播说今天现捞的，鲍鱼怎么保存比较好？」有 19 个内容词元，
     * 而决定答案的只有「鲍鱼 / 保存」。若拿 19 当分母，
     * 一份完全正确的说明也只能拿到 0.16 —— 问得越啰嗦越答不上来。
     */
    const coverage = createQueryCoverage("主播说今天现捞的，鲍鱼怎么保存比较好？");
    expect(coverage.tokenCount).toBeGreaterThan(COVERAGE_TOKEN_CAP);
    // 命中 6 个词元即算完全覆盖
    expect(coverage.coverageOf("鲍鱼保存")).toBe(1);
  });

  it("命中数为 0 时返回 0，不会出现负值或 NaN", () => {
    const coverage = createQueryCoverage("鲍鱼保存");
    expect(coverage.coverageOf("海带紫菜")).toBe(0);
    expect(coverage.coverageOf("")).toBe(0);
  });

  it("查询词元太少时不启用稀疏侧（覆盖度恒为 0）", () => {
    /**
     * 「多久能到？」剥掉虚词后只剩一个「久」字。
     * 若照常算覆盖率，任何偶然含「久」的切片都会拿到 1.0 —— 那是噪声不是信号。
     */
    const coverage = createQueryCoverage("多久能到？");
    expect(coverage.tokenCount).toBeLessThan(MIN_COVERAGE_QUERY_TOKENS);
    expect(coverage.measurable).toBe(false);
    expect(coverage.coverageOf("本文长期有效")).toBe(0);
  });

  it("全是虚词的输入没有任何词元，覆盖度与可测性都为 0", () => {
    const coverage = createQueryCoverage("在吗？");
    expect(coverage.tokenCount).toBe(0);
    expect(coverage.measurable).toBe(false);
    expect(coverage.coverageOf("鲍鱼怎么保存都可以")).toBe(0);
  });

  it("lexicalCoverage 与工厂是同一个度量（前者只是单次调用的便捷包装）", () => {
    const text = "最佳保存温度为 0-4℃ 冷藏。";
    expect(lexicalCoverage("鲍鱼怎么保存比较好？", text)).toBe(
      createQueryCoverage("鲍鱼怎么保存比较好？").coverageOf(text),
    );
  });
});

describe("分词器与向量的一致性", () => {
  it("共享词更多的文本，余弦相似度更高（阈值判定才有意义）", async () => {
    const provider = createMockAIProvider();
    const query = "鲍鱼怎么保存比较好？";
    const related = "鲍鱼的最佳保存温度为 0-4℃ 冷藏。";
    const unrelated = "礼盒的包装规格是 2.5kg。";
    const vectors = await provider.embed({ values: [query, related, unrelated] });

    expect(cosineSimilarity(vectors[0]!, vectors[1]!)).toBeGreaterThan(
      cosineSimilarity(vectors[0]!, vectors[2]!),
    );
  });

  it("Mock 向量长度恒为 1024（与数据库列 vector(1024) 一致）", async () => {
    const provider = createMockAIProvider();
    const vectors = await provider.embed({ values: ["鲍鱼", "「」"] });
    for (const vector of vectors) {
      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    }
  });
});
