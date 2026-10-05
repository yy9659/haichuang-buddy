/**
 * AI 经营分析师的结构化契约（S6-B · 任务书第九 / 十 / 三十一节）
 *
 * ## 为什么这份 Schema 是个「工厂」而不是一个常量
 *
 * 别的 Agent 的 Schema 都是模块级常量 —— 它们的契约只由**类型**决定。
 * 经营分析不一样：它的合法输出取决于**这一次快照里有哪些指标**。
 * 模型引用 `product.totalProducts` 合法，引用 `revenue` 不合法，
 * 而「合法清单」只有拿到快照才知道。因此 `createAnalyticsReportSchema(snapshot 上下文)`
 * 按次构造，把白名单与允许的百分比一起闭包进去。
 *
 * ### 这样做的收益
 *
 * 编造指标键 → Zod 直接报错 → 触发一次**纠错重喂**（把错误原因连同上一版输出
 * 一起还给模型）。模型通常第二次就改对了。这比「事后在服务层静默删掉非法键」
 * 好得多：静默删除会让一段自相矛盾的文案继续留在日报里
 * （「销售额增长 37%」+ 被抹掉的引用），而纠错是让模型**自己**把话改对。
 *
 * ### 三层防护（全部是程序侧，不依赖模型自觉）
 *
 * 1. **引用白名单**：`metricKeys` 只能取快照里真实存在的键。
 * 2. **禁用名词 + 数字**：本地没有真实订单 / 播放量，任何「销售额 20%」式断言
 *    都会被拦下（同句同时出现名词与数字即判违规）。
 * 3. **百分比对账**：文案里的每个 `xx%` 都必须能在快照里找到出处。
 *
 * 一致性约束（`superRefine`）：
 * - `health="risk"` 必须至少给出一条问题 —— 「有风险但没毛病」是自相矛盾的；
 * - `actions` 的 `priority` 必须互不相同 —— 两件「第一优先」的事等于没有优先级。
 */

import { z } from "zod";

import {
  ANALYTICS_ACTION_TYPES,
  ANALYTICS_HEALTHS,
  ANALYTICS_ISSUE_SEVERITIES,
} from "@/types";

import { collectUnsupportedClaims } from "@/analytics/metric-keys";
import { createSalesReviewSchema } from "./sales-review";
import type { SalesReviewSnapshot } from "@/types";

import {
  confidenceSchema,
  normalizeRawList,
  textField,
  textListField,
} from "./field-rules";

/** 经营摘要上限 */
export const MAX_EXECUTIVE_SUMMARY_LENGTH = 400;
/** 亮点 / 问题标题上限 */
export const MAX_ANALYTICS_TITLE_LENGTH = 40;
/** 依据文案上限 */
export const MAX_ANALYTICS_EVIDENCE_LENGTH = 220;
/** 可能原因单条上限 */
export const MAX_POSSIBLE_CAUSE_LENGTH = 160;
/** 行动建议标题上限 */
export const MAX_ACTION_TITLE_LENGTH = 60;
/** 行动建议理由上限 */
export const MAX_ACTION_REASON_LENGTH = 200;
/** 行动建议做法上限 */
export const MAX_RECOMMENDED_ACTION_LENGTH = 300;
/** 明日重点单条上限 */
export const MAX_TOMORROW_FOCUS_LENGTH = 120;

export const MAX_ANALYTICS_HIGHLIGHTS = 5;
export const MAX_ANALYTICS_ISSUES = 5;
export const MAX_ANALYTICS_ACTIONS = 6;
export const MAX_TOMORROW_FOCUS_ITEMS = 5;
/** 单条亮点 / 问题最多引用几个指标键 */
export const MAX_METRIC_KEYS_PER_ITEM = 4;
/** 单条问题最多给几条可能原因 */
export const MAX_POSSIBLE_CAUSES_PER_ISSUE = 3;

/**
 * 指标键数组。
 *
 * 走 `normalizeRawList` 是为了容忍模型把它写成 `"a、b"` 这种分隔符字符串 ——
 * 这是它在别处被验证过的坏习惯（见 `field-rules` 文件头）。
 *
 * ## 为什么是「纯白名单」而不是「至少引用一个」
 *
 * 任务书第十节的原文是「模型**只能引用** Snapshot 中真实存在的 Metric Key」——
 * 它约束的是**引用的合法性**，没有要求条数。我们一开始把它实现成了两处都
 * `.min(1, "必须至少引用一个指标键")`，三次真实模型验收（`scripts/verify-analytics.ts`）
 * 证明这条**偏好**被写成了**硬约束**，代价过高：
 *
 *   - 提示词第 17 条要求「数据稀少时写一条数据状态说明」，那条说明本来就没有
 *     可对应的正面指标 —— 逼它挂键只会制造「拿商品总数解释销售额」这类**假关联**；
 *   - 模型偶发少挂一个键（尤其在对抗场景的高压下），整份日报就被判无效、
 *     一条都落不了库。用一个**风格性**的疏漏去换「用户今天没有日报」，不划算。
 *
 * 所以这里只保留白名单校验：**引用了不存在的键 → 整份无效**；键数是模型的自由度。
 * 提示词仍强烈建议每条都引用（见 `analytics-agent.ts` 第 9 条），
 * 但那是引导，不是判死的条件。
 *
 * 真正的防幻觉底线在 `collectUnsupportedClaims` 的数值守卫：它拦的是
 * 「禁用名词 + 数字」和「对不上的百分比」，与引用几个键无关。
 */
const MetricKeysField = z.preprocess(
  normalizeRawList,
  z
    .array(z.string().trim().min(1, "指标键不能为空"))
    .max(MAX_METRIC_KEYS_PER_ITEM, `指标键最多 ${MAX_METRIC_KEYS_PER_ITEM} 个`),
);

const HighlightSchema = z.object({
  title: textField("亮点标题", MAX_ANALYTICS_TITLE_LENGTH),
  evidence: textField("亮点依据", MAX_ANALYTICS_EVIDENCE_LENGTH),
  metricKeys: MetricKeysField,
});

const IssueSchema = z.object({
  title: textField("问题标题", MAX_ANALYTICS_TITLE_LENGTH),
  severity: z.enum(ANALYTICS_ISSUE_SEVERITIES),
  evidence: textField("问题依据", MAX_ANALYTICS_EVIDENCE_LENGTH),
  metricKeys: MetricKeysField,
  possibleCauses: textListField("可能原因", {
    maxItemLength: MAX_POSSIBLE_CAUSE_LENGTH,
    minItems: 1,
    maxItems: MAX_POSSIBLE_CAUSES_PER_ISSUE,
  }),
});

const ActionSchema = z.object({
  priority: z
    .number()
    .int("优先级必须是整数")
    .min(1, "优先级从 1 开始")
    .max(MAX_ANALYTICS_ACTIONS, `优先级最大 ${MAX_ANALYTICS_ACTIONS}`),
  title: textField("行动标题", MAX_ACTION_TITLE_LENGTH),
  reason: textField("行动理由", MAX_ACTION_REASON_LENGTH),
  actionType: z.enum(ANALYTICS_ACTION_TYPES),
  recommendedAction: textField("行动做法", MAX_RECOMMENDED_ACTION_LENGTH),
});

/** 构造 Schema 所需的上下文（全部来自**程序**，与模型无关） */
export interface AnalyticsReportSchemaContext {
  /** 允许引用的指标键（`ANALYTICS_METRIC_KEYS`） */
  allowedMetricKeys: readonly string[];
  /** 快照里允许出现的百分比 */
  allowedPercents: readonly number[];
  sales?: SalesReviewSnapshot;
}

/** 从一份日报里抽出**全部面向读者的文案**（数值守卫的扫描范围） */
function collectReportTexts(value: {
  executiveSummary: string;
  highlights: readonly { title: string; evidence: string }[];
  issues: readonly {
    title: string;
    evidence: string;
    possibleCauses: readonly string[];
  }[];
  actions: readonly { title: string; reason: string; recommendedAction: string }[];
  tomorrowFocus: readonly string[];
}): { text: string; path: (string | number)[] }[] {
  return [
    { text: value.executiveSummary, path: ["executiveSummary"] },
    ...value.highlights.flatMap((item, index) => [
      { text: item.title, path: ["highlights", index, "title"] },
      { text: item.evidence, path: ["highlights", index, "evidence"] },
    ]),
    ...value.issues.flatMap((item, index) => [
      { text: item.title, path: ["issues", index, "title"] },
      { text: item.evidence, path: ["issues", index, "evidence"] },
      ...item.possibleCauses.map((text, causeIndex) => ({ text, path: ["issues", index, "possibleCauses", causeIndex] })),
    ]),
    ...value.actions.flatMap((item, index) => [
      { text: item.title, path: ["actions", index, "title"] },
      { text: item.reason, path: ["actions", index, "reason"] },
      { text: item.recommendedAction, path: ["actions", index, "recommendedAction"] },
    ]),
    ...value.tomorrowFocus.map((text, index) => ({ text, path: ["tomorrowFocus", index] })),
  ];
}

export function createAnalyticsReportSchema(context: AnalyticsReportSchemaContext) {
  const allowedKeys = new Set(context.allowedMetricKeys);

  return z
    .object({
      executiveSummary: textField("经营摘要", MAX_EXECUTIVE_SUMMARY_LENGTH),
      health: z.enum(ANALYTICS_HEALTHS),
      highlights: z
        .array(HighlightSchema)
        .min(1, "至少给出一条亮点（没有正面数据时，如实说明当前数据状态）")
        .max(MAX_ANALYTICS_HIGHLIGHTS, `亮点最多 ${MAX_ANALYTICS_HIGHLIGHTS} 条`),
      // 问题可以为空 —— 一切正常的一天本来就没有问题，硬凑是编造
      issues: z.array(IssueSchema).max(MAX_ANALYTICS_ISSUES, `问题最多 ${MAX_ANALYTICS_ISSUES} 条`),
      actions: z
        .array(ActionSchema)
        .min(1, "至少给出一条行动建议")
        .max(MAX_ANALYTICS_ACTIONS, `行动建议最多 ${MAX_ANALYTICS_ACTIONS} 条`),
      tomorrowFocus: textListField("明日重点", {
        maxItemLength: MAX_TOMORROW_FOCUS_LENGTH,
        minItems: 1,
        maxItems: MAX_TOMORROW_FOCUS_ITEMS,
      }),
      confidence: confidenceSchema,
      salesReview: context.sales?.summary.count
        ? createSalesReviewSchema(context.sales)
        : z.undefined().optional(),
    })
    .superRefine((value, ctx) => {
      /* ① 指标键必须来自白名单 */
      const checkKeys = (
        keys: readonly string[],
        path: (string | number)[],
      ): void => {
        for (const key of keys) {
          if (allowedKeys.has(key)) {
            continue;
          }
          ctx.addIssue({
            code: "custom",
            path: [...path, "metricKeys"],
            message: `指标键「${key}」不存在于本次经营快照中，只能引用给定的指标键`,
          });
        }
      };

      value.highlights.forEach((item, index) =>
        checkKeys(item.metricKeys, ["highlights", index]),
      );
      value.issues.forEach((item, index) =>
        checkKeys(item.metricKeys, ["issues", index]),
      );

      /* ② health=risk 必须至少指出一个问题 —— 「有风险但没毛病」自相矛盾 */
      if (value.health === "risk" && value.issues.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["issues"],
          message: "健康度为 risk 时必须至少给出一条问题，否则请下调健康度",
        });
      }

      /* ③ 优先级必须互不相同 */
      const priorities = value.actions.map((action) => action.priority);
      if (new Set(priorities).size !== priorities.length) {
        ctx.addIssue({
          code: "custom",
          path: ["actions"],
          message: "行动建议的 priority 必须互不相同",
        });
      }

      /* ④ 数值守卫：禁用名词 + 数字 / 无出处的百分比 */
      for (const { text, path } of collectReportTexts(value)) {
        const { forbiddenClaims, unsupportedPercents } = collectUnsupportedClaims({
          texts: [text],
          allowedPercents: context.allowedPercents,
        });

        if (forbiddenClaims.length > 0) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `出现了本系统没有的指标数据（${forbiddenClaims
              .map((item) => `「${item}」`)
              .join("、")}）。快照里没有销售额 / 订单量 / 转化率 / 播放量这类数据，请删除相关数字，或明确说明该指标不存在。`,
          });
        }

        if (unsupportedPercents.length > 0) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `字段 ${path.join(".")} 出现了准备工作指标中不存在的百分比（${unsupportedPercents.join(
              "、",
            )}）。请删除该字段中的销售占比，只用metrics说明准备工作；销售占比只保留在salesReview。其他百分比也必须来自给定指标，不能自行计算。`,
          });
        }
      }
    });
}

/** 字段 → 中文标签，让纠错提示可读 */
export const ANALYTICS_REPORT_FIELD_LABELS: Readonly<Record<string, string>> = {
  executiveSummary: "经营摘要",
  health: "健康度",
  highlights: "亮点",
  "highlights.title": "亮点标题",
  "highlights.evidence": "亮点依据",
  "highlights.metricKeys": "亮点引用的指标键",
  issues: "问题",
  "issues.title": "问题标题",
  "issues.severity": "问题严重程度",
  "issues.evidence": "问题依据",
  "issues.metricKeys": "问题引用的指标键",
  "issues.possibleCauses": "可能原因",
  actions: "行动建议",
  "actions.priority": "行动优先级",
  "actions.title": "行动标题",
  "actions.reason": "行动理由",
  "actions.actionType": "行动类型",
  "actions.recommendedAction": "行动做法",
  tomorrowFocus: "明日重点",
  confidence: "置信度",
};

/** 纠错提示里要强调的键名 */
export const ANALYTICS_REPORT_REQUIRED_KEYS: readonly string[] = [
  "executiveSummary",
  "health",
  "highlights",
  "issues",
  "actions",
  "tomorrowFocus",
  "confidence",
];
