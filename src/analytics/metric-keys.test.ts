/**
 * 经营指标白名单与数值守卫单测（S6-B · 任务书第十 / 三十一节）
 *
 * 这个文件锁的是**防幻觉的地基**：
 *
 * - 白名单是静态的，不随数据变化 ——「这个指标存在但今天没数」与
 *   「这个指标根本不存在」必须可区分；
 * - `null` 必须被渲染成「暂无数据」，而不是 0；
 * - 「销售额 / 订单量 / 转化率」这类本地无数据源的名词与数字同句出现 → 拦下；
 * - 文案里的每个 `xx%` 都必须在快照里找到出处。
 *
 * 最后一组用例是最关键的：它模拟的就是任务书第三十一节的验收场景 ——
 * 「诱导模型分析今天销售额为什么下降」时，系统必须有能力把编造的数字拦下来。
 */

import { describe, expect, it } from "vitest";

import type { AnalyticsSnapshot } from "@/types";

import {
  ANALYTICS_FORBIDDEN_CLAIM_TERMS,
  ANALYTICS_METRIC_DESCRIPTORS,
  ANALYTICS_METRIC_KEYS,
  collectAllowedPercents,
  collectUnsupportedClaims,
  findUnsupportedNumericClaims,
  findUnsupportedPercentages,
  formatMetricValue,
  isAnalyticsMetricKey,
  readMetricValue,
} from "./metric-keys";
import { buildAnalyticsSnapshot } from "./snapshot";

function emptyInput() {
  return {
    now: new Date("2026-09-27T10:00:00"),
    products: [],
    contents: [],
    workflows: [],
    agentTasks: [],
    customerService: {
      answeredCount: 0,
      groundedCount: 0,
      needsHumanCount: 0,
      openKnowledgeGapCount: 0,
      openGaps: [],
    },
    live: { sessions: [], comments: [], suggestions: [] },
  };
}

const EMPTY_SNAPSHOT: AnalyticsSnapshot = buildAnalyticsSnapshot(emptyInput());

const RICH_SNAPSHOT: AnalyticsSnapshot = buildAnalyticsSnapshot({
  ...emptyInput(),
  customerService: {
    answeredCount: 10,
    groundedCount: 7,
    needsHumanCount: 2,
    openKnowledgeGapCount: 1,
    openGaps: [{ intent: "logistics" }],
  },
});

/* ------------------------------------------------------------------ */
/* 白名单                                                              */
/* ------------------------------------------------------------------ */

describe("指标白名单", () => {
  it("键名唯一（重复的键会让「引用是否合法」的判定变得不可靠）", () => {
    const keys = ANALYTICS_METRIC_DESCRIPTORS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("每个描述符都有中文标签", () => {
    for (const descriptor of ANALYTICS_METRIC_DESCRIPTORS) {
      expect(descriptor.label.trim().length).toBeGreaterThan(0);
      expect(descriptor.label).not.toBe(descriptor.key);
    }
  });

  it("ANALYTICS_METRIC_KEYS 与描述符一一对应", () => {
    expect(ANALYTICS_METRIC_KEYS).toEqual(
      ANALYTICS_METRIC_DESCRIPTORS.map((item) => item.key),
    );
  });

  it("isAnalyticsMetricKey 只认白名单内的键", () => {
    expect(isAnalyticsMetricKey("product.totalProducts")).toBe(true);
    expect(isAnalyticsMetricKey("revenue")).toBe(false);
    expect(isAnalyticsMetricKey("orders")).toBe(false);
  });

  it("白名单里没有任何「需要真实订单 / 平台后台」的指标", () => {
    const joined = ANALYTICS_METRIC_KEYS.join(" ").toLowerCase();
    for (const forbidden of ["revenue", "order", "gmv", "conversion", "view", "sale"]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("快照里出现的每个数值字段都能在 readMetricValue 里读到", () => {
    const snapshot = RICH_SNAPSHOT;
    expect(readMetricValue(snapshot, "customerService.groundedRate")).toBe(0.7);
    expect(readMetricValue(snapshot, "customerService.answeredCount")).toBe(10);
    expect(readMetricValue(snapshot, "customerService.openKnowledgeGapCount")).toBe(1);
    // 不在白名单里的键一律读成 null
    expect(readMetricValue(snapshot, "revenue")).toBeNull();
  });

  it("null 指标渲染成「暂无数据」，不是 0", () => {
    const descriptor = ANALYTICS_METRIC_DESCRIPTORS.find(
      (item) => item.key === "customerService.groundedRate",
    );
    expect(descriptor).toBeDefined();
    if (!descriptor) {
      return;
    }

    expect(formatMetricValue(descriptor, null)).toBe("暂无数据（null）");
    expect(formatMetricValue(descriptor, 0.7)).toBe("70.0%");
  });

  it("耗时可读化为毫秒", () => {
    const descriptor = ANALYTICS_METRIC_DESCRIPTORS.find(
      (item) => item.key === "agents.avgDurationMs",
    );
    expect(descriptor).toBeDefined();
    if (!descriptor) {
      return;
    }

    expect(formatMetricValue(descriptor, 1200)).toBe("1200 毫秒");
  });
});

/* ------------------------------------------------------------------ */
/* 允许的百分比集合                                                    */
/* ------------------------------------------------------------------ */

describe("collectAllowedPercents", () => {
  it("含 0 与 100 兜底值", () => {
    const allowed = collectAllowedPercents(EMPTY_SNAPSHOT);

    expect(allowed).toContain(0);
    expect(allowed).toContain(100);
  });

  it("把快照里的比率指标换算成百分数并纳入白名单", () => {
    const allowed = collectAllowedPercents(RICH_SNAPSHOT);

    // 0.7 → 70%
    expect(allowed).toContain(70);
  });

  it("null 的比率不进白名单（不能因为「今天没数据」就放行任意百分比）", () => {
    const allowed = collectAllowedPercents(EMPTY_SNAPSHOT);

    expect(allowed).not.toContain(75);
  });

  it("纳入健康度阈值本身（模型解释「超过阈值」时要能引用）", () => {
    const allowed = collectAllowedPercents(EMPTY_SNAPSHOT);

    // failedTaskRateRisk = 0.3 → 30%
    expect(allowed).toContain(30);
  });

  /**
   * 回归：真实模型验收里，「多任务失败」场景连续 2 次被判为幻觉而失败 ——
   * 定档理由写着「AI 任务失败率 33% 偏高」，模型只是**如实引用**这句程序生成的理由，
   * 但 33% 是派生值（失败数 / 总数），原先不在白名单里，于是一句真话被当成幻觉拦下。
   */
  it("纳入健康度定档理由里程序算出的百分比（派生比率也算有出处）", () => {
    const snapshot = buildAnalyticsSnapshot({
      ...emptyInput(),
      agentTasks: [
        // 10 成功 + 5 失败 → 失败率 33%（没有对应的比率型指标键）
        ...Array.from({ length: 10 }, () => ({
          agentType: "product_agent" as const,
          status: "completed" as const,
          durationMs: 1200,
        })),
        ...Array.from({ length: 5 }, () => ({
          agentType: "product_agent" as const,
          status: "failed" as const,
          durationMs: null,
        })),
      ],
    });

    expect(snapshot.health.reasons.join("")).toContain("33%");
    expect(collectAllowedPercents(snapshot)).toContain(33);
  });
});

/* ------------------------------------------------------------------ */
/* 数值守卫                                                            */
/* ------------------------------------------------------------------ */

describe("findUnsupportedNumericClaims", () => {
  it("禁用名词 + 数字同句 → 拦下", () => {
    expect(findUnsupportedNumericClaims("今天销售额下降了 20%。")).toHaveLength(1);
    expect(findUnsupportedNumericClaims("订单量达到 120 单。")).toHaveLength(1);
    expect(findUnsupportedNumericClaims("转化率提升到 8%。")).toHaveLength(1);
  });

  it("只提到名词、不给数字 → 放行（「快照里没有销售额数据」是允许的）", () => {
    expect(findUnsupportedNumericClaims("快照里没有销售额数据，无法分析。")).toEqual([]);
  });

  it("名词与数字分处两句 → 放行", () => {
    expect(
      findUnsupportedNumericClaims("快照里没有销售额数据。今日新增 3 条内容。"),
    ).toEqual([]);
  });

  it("禁用词表覆盖本地没有数据源的常见指标", () => {
    for (const term of ["销售额", "GMV", "订单量", "转化率", "播放量", "曝光量"]) {
      expect(ANALYTICS_FORBIDDEN_CLAIM_TERMS).toContain(term);
    }
  });
});

describe("findUnsupportedPercentages", () => {
  it("白名单外的百分比被拦下", () => {
    expect(findUnsupportedPercentages("增长 37%。", [30, 50, 70])).toEqual(["37%"]);
  });

  it("白名单内的百分比放行（含小数四舍五入匹配）", () => {
    expect(findUnsupportedPercentages("完成率 66.7%。", [67])).toEqual([]);
    expect(findUnsupportedPercentages("占比 70%。", [70])).toEqual([]);
  });

  it("多个百分比只报出无出处的那些", () => {
    expect(findUnsupportedPercentages("70% 达标，另有 12% 未达标。", [70])).toEqual([
      "12%",
    ]);
  });
});

describe("collectUnsupportedClaims", () => {
  it("汇总禁用断言与无出处百分比，且去重", () => {
    const result = collectUnsupportedClaims({
      // 完全相同的两句：去重后只应报出一条
      texts: ["今天销售额下降 20%。", "今天销售额下降 20%。"],
      allowedPercents: [30],
    });

    expect(result.forbiddenClaims).toHaveLength(1);
    expect(result.unsupportedPercents).toEqual(["20%"]);
  });

  it("不同句子里的禁用断言各自报出（不去重成一条）", () => {
    const result = collectUnsupportedClaims({
      texts: ["今天销售额下降 20%。", "订单量涨到 130 单。"],
      allowedPercents: [30],
    });

    expect(result.forbiddenClaims).toHaveLength(2);
  });

  /* ---------------- §31 防幻觉验收：销售额 ---------------- */

  it("§31：一份「分析今天销售额为什么下降」式日报会被整体拦下", () => {
    const fabricated = [
      "今天销售额下降了 20%，主要原因是流量不足。",
      "建议加大投放，把销售额拉回昨天的水平。",
    ];

    const { forbiddenClaims, unsupportedPercents } = collectUnsupportedClaims({
      texts: fabricated,
      allowedPercents: collectAllowedPercents(EMPTY_SNAPSHOT),
    });

    expect(forbiddenClaims.length).toBeGreaterThan(0);
    expect(unsupportedPercents).toContain("20%");
  });

  it("§31：如实说明「没有销售额数据」的日报不会被拦", () => {
    const honest = [
      "本系统快照中不含销售额数据，因此无法分析销售额变化。",
      "今天有 3 个未解决知识缺口，建议优先补齐。",
    ];

    const { forbiddenClaims, unsupportedPercents } = collectUnsupportedClaims({
      texts: honest,
      allowedPercents: collectAllowedPercents(EMPTY_SNAPSHOT),
    });

    expect(forbiddenClaims).toEqual([]);
    expect(unsupportedPercents).toEqual([]);
  });
});
