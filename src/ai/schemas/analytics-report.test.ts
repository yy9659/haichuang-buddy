/**
 * 经营日报契约单测（S6-B · 任务书第九 / 十 / 三十一节）
 *
 * Schema 是「数字不许编」这条纪律的**执行处**：白名单引用、percent 对账、
 * 一致性约束都在这里。因此测试不满足于「合法输入能过」，必须逐条证明
 * **每种违规都被真的拦住了** —— 一份漏拦的 Schema 比没有 Schema 更危险，
 * 因为它会让人以为已经守住了。
 */

import { describe, expect, it } from "vitest";

import { ANALYTICS_METRIC_KEYS, collectAllowedPercents } from "@/analytics/metric-keys";
import { buildAnalyticsSnapshot } from "@/analytics/snapshot";

import {
  ANALYTICS_REPORT_REQUIRED_KEYS,
  createAnalyticsReportSchema,
  MAX_ANALYTICS_ACTIONS,
  MAX_ANALYTICS_HIGHLIGHTS,
  MAX_ANALYTICS_ISSUES,
} from "./analytics-report";

/** 有一份可用数据的快照：Grounded 率 70%，便于测百分比对账 */
const SNAPSHOT = buildAnalyticsSnapshot({
  now: new Date("2026-09-27T10:00:00"),
  products: [],
  contents: [],
  workflows: [],
  agentTasks: [],
  customerService: {
    answeredCount: 10,
    groundedCount: 7,
    needsHumanCount: 0,
    openKnowledgeGapCount: 0,
    openGaps: [],
  },
  live: { sessions: [], comments: [], suggestions: [] },
});

const schema = createAnalyticsReportSchema({
  allowedMetricKeys: ANALYTICS_METRIC_KEYS,
  allowedPercents: collectAllowedPercents(SNAPSHOT),
});

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    executiveSummary: "今天系统记录了 0 件商品，客服有依据回答占比为 70%。",
    health: "good",
    highlights: [
      {
        title: "客服回答有据可依",
        evidence: "客服有依据回答占比 70%，高于阈值。",
        metricKeys: ["customerService.groundedRate"],
      },
    ],
    issues: [],
    actions: [
      {
        priority: 1,
        title: "补齐商品",
        reason: "当前没有商品，经营链路缺少起点。",
        actionType: "product",
        recommendedAction: "在商品中心添加一件主推商品，并生成商品理解。",
      },
    ],
    tomorrowFocus: ["先把第一件商品加进来"],
    confidence: 0.5,
    ...overrides,
  };
}

describe("createAnalyticsReportSchema：合法输出", () => {
  it("行动理由的占比错误指向实际字段，不误报为摘要错误", () => {
    const report = validReport();
    report.actions[0].reason = "实收最多的商品占76.2%，应该准备推广。";
    const result = schema.safeParse(report);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["actions", 0, "reason"]);
      expect(result.error.issues[0].message).toContain("actions.0.reason");
    }
  });
  it("完整合法的日报通过校验", () => {
    expect(schema.safeParse(validReport()).success).toBe(true);
  });

  it("issues 可以为空（一切正常的一天本来就没有问题）", () => {
    const result = schema.safeParse(validReport({ health: "good", issues: [] }));
    expect(result.success).toBe(true);
  });

  it("缺少关键键时逐键报错（confidence 例外，它有兜底）", () => {
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    const paths = parsed.error.issues.map((issue) => String(issue.path[0]));
    for (const key of ANALYTICS_REPORT_REQUIRED_KEYS) {
      if (key === "confidence") {
        // confidence 走 `.catch(0.5)`：写错不该拖垮整份产出（见 field-rules）
        expect(paths).not.toContain(key);
        continue;
      }
      expect(paths).toContain(key);
    }
  });

  it("confidence 支持百分制写法（85 → 0.85），非数值兜底 0.5", () => {
    expect(schema.safeParse(validReport({ confidence: 85 })).data?.confidence).toBe(0.85);
    expect(schema.safeParse(validReport({ confidence: "85%" })).data?.confidence).toBe(
      0.85,
    );
    expect(schema.safeParse(validReport({ confidence: "高" })).data?.confidence).toBe(0.5);
  });
});

describe("createAnalyticsReportSchema：指标键白名单（§10）", () => {
  it("引用白名单外的指标键 → 校验失败", () => {
    const result = schema.safeParse(
      validReport({
        highlights: [
          {
            title: "销售额表现",
            evidence: "今天的销售表现不错。",
            metricKeys: ["revenue"],
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues.map((item) => item.message).join()).toContain("revenue");
  });

  it("亮点与问题里的非法键都会被检查到", () => {
    const result = schema.safeParse(
      validReport({
        issues: [
          {
            title: "订单量走低",
            severity: "medium",
            evidence: "订单量低于预期。",
            metricKeys: ["orders", "customerService.groundedRate"],
            possibleCauses: ["可能是流量不足。"],
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  /**
   * 任务书第十节约束的是「**只能引用**快照中真实存在的键」，而不是「必须引用几个」。
   * 早先两处都 `.min(1)`，真实模型验收里出现了「模型少挂一个键 → 整份日报作废」的
   * 高代价失败（详见 `analytics-report.ts` 里 `MetricKeysField` 的说明）。
   */
  it("metricKeys 为空数组 → 通过（纯白名单语义，键数由模型决定）", () => {
    const result = schema.safeParse(
      validReport({
        highlights: [
          { title: "数据积累中", evidence: "系统刚启用，今天还没有可对比的经营数据。", metricKeys: [] },
        ],
        health: "risk",
        issues: [
          {
            title: "客服有依据回答占比偏低",
            severity: "high",
            evidence: "今天有依据回答占比偏低。",
            metricKeys: [],
            possibleCauses: ["知识库尚未覆盖高频问法"],
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
  });

  it("metricKeys 里出现不存在的键 → 失败（这才是白名单要拦的）", () => {
    const result = schema.safeParse(
      validReport({
        health: "risk",
        issues: [
          {
            title: "客服有依据回答占比偏低",
            severity: "high",
            evidence: "今天有依据回答占比偏低。",
            metricKeys: ["customerService.inventedKey"],
            possibleCauses: ["知识库尚未覆盖高频问法"],
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  it("metricKeys 超过 4 个 → 失败", () => {
    const result = schema.safeParse(
      validReport({
        highlights: [
          {
            title: "多个指标",
            evidence: "综合来看。",
            metricKeys: [
              "product.totalProducts",
              "product.analyzedProducts",
              "content.totalAssets",
              "content.generatedToday",
              "agents.failedTasks",
            ],
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  it("metricKeys 写成顿号分隔字符串也能被归一化", () => {
    const result = schema.safeParse(
      validReport({
        highlights: [
          {
            title: "客服表现",
            evidence: "有依据回答占比 70%。",
            metricKeys: "customerService.groundedRate",
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
  });
});

describe("createAnalyticsReportSchema：一致性约束", () => {
  it("health=risk 但没有问题 → 失败（有风险却没毛病是自相矛盾的）", () => {
    const result = schema.safeParse(
      validReport({ health: "risk", issues: [] }),
    );

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues.map((item) => item.message).join()).toContain("risk");
  });

  it("health=risk 且有问题 → 通过", () => {
    const result = schema.safeParse(
      validReport({
        health: "risk",
        executiveSummary: "今天存在明显的失败信号，需要优先排查。",
        highlights: [
          {
            title: "客服回答有据可依",
            evidence: "客服有依据回答占比 70%。",
            metricKeys: ["customerService.groundedRate"],
          },
        ],
        issues: [
          {
            title: "有 AI 任务失败",
            severity: "high",
            evidence: "失败的任务数为 2 个。",
            metricKeys: ["agents.failedTasks"],
            possibleCauses: ["可能是模型超时，建议查看失败原因。"],
          },
        ],
      }),
    );

    expect(result.success).toBe(true);
  });

  it("action 的 priority 重复 → 失败（两件「第一优先」等于没有优先级）", () => {
    const result = schema.safeParse(
      validReport({
        actions: [
          {
            priority: 1,
            title: "补商品",
            reason: "缺少商品。",
            actionType: "product",
            recommendedAction: "添加一件商品。",
          },
          {
            priority: 1,
            title: "补知识",
            reason: "缺少知识。",
            actionType: "knowledge",
            recommendedAction: "补一份文档。",
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues.map((item) => item.message).join()).toContain("priority");
  });

  it("priority 必须是从 1 开始的整数，且不超过行动数上限", () => {
    expect(schema.safeParse(validReport({ actions: [] })).success).toBe(false);

    const bad = validReport({
      actions: [
        {
          priority: 0,
          title: "补商品",
          reason: "缺少商品。",
          actionType: "product",
          recommendedAction: "添加一件商品。",
        },
      ],
    });
    expect(schema.safeParse(bad).success).toBe(false);

    const tooMany = validReport({
      actions: Array.from({ length: MAX_ANALYTICS_ACTIONS + 1 }, (_, index) => ({
        priority: index + 1,
        title: `行动 ${index + 1}`,
        reason: "理由。",
        actionType: "workflow",
        recommendedAction: "做法。",
      })),
    });
    expect(schema.safeParse(tooMany).success).toBe(false);
  });

  it("highlights / issues 超出条数上限 → 失败", () => {
    const build = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        title: `亮点 ${index + 1}`,
        evidence: "依据。",
        metricKeys: ["product.totalProducts"],
      }));

    expect(schema.safeParse(validReport({ highlights: build(MAX_ANALYTICS_HIGHLIGHTS) })).success).toBe(true);
    expect(schema.safeParse(validReport({ highlights: build(MAX_ANALYTICS_HIGHLIGHTS + 1) })).success).toBe(false);

    const buildIssues = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        title: `问题 ${index + 1}`,
        severity: "low",
        evidence: "依据。",
        metricKeys: ["product.totalProducts"],
        possibleCauses: ["可能是数据还没积累。"],
      }));

    expect(schema.safeParse(validReport({ issues: buildIssues(MAX_ANALYTICS_ISSUES) })).success).toBe(true);
    expect(schema.safeParse(validReport({ issues: buildIssues(MAX_ANALYTICS_ISSUES + 1) })).success).toBe(false);
  });

  it("问题必须给出至少一条可能原因", () => {
    const result = schema.safeParse(
      validReport({
        issues: [
          {
            title: "缺口较多",
            severity: "medium",
            evidence: "有缺口。",
            metricKeys: ["customerService.openKnowledgeGapCount"],
            possibleCauses: [],
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });
});

describe("createAnalyticsReportSchema：数值守卫（§31）", () => {
  it("编造销售额 + 数字 → 失败，并在报错里说明原因", () => {
    const result = schema.safeParse(
      validReport({
        executiveSummary: "今天销售额下降了 20%，需要加大投放。",
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const message = result.error.issues.map((item) => item.message).join();
    expect(message).toContain("销售额");
  });

  it("编造订单量 → 失败", () => {
    const result = schema.safeParse(
      validReport({
        tomorrowFocus: ["把订单量提升到 150 单"],
      }),
    );

    expect(result.success).toBe(false);
  });

  it("快照里对不上的百分比 → 失败", () => {
    const result = schema.safeParse(
      validReport({
        executiveSummary: "整体转化提升了 37%。",
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues.map((item) => item.message).join()).toContain("37%");
  });

  it("快照里对得上的百分比 → 通过", () => {
    const result = schema.safeParse(
      validReport({
        executiveSummary: "客服有依据回答占比为 70%，属于正常水平。",
      }),
    );

    expect(result.success).toBe(true);
  });

  it("行动建议里的编造数字同样被拦下（守卫扫描全部面向读者的文案）", () => {
    const result = schema.safeParse(
      validReport({
        actions: [
          {
            priority: 1,
            title: "挽回成交量",
            reason: "成交量比昨天少了 30 单，需要马上处理。",
            actionType: "workflow",
            recommendedAction: "重新发起一轮经营任务。",
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });
});
