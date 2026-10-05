/**
 * AI 经营分析师 Agent（S6-B · 任务书第十二 / 十三 / 二十七 / 三十二节）
 *
 * 执行流程：
 *
 *   AnalyticsSnapshot
 *     → ① 快照结构校验（挡住旧结构 / 手工构造的坏快照）
 *     → ② 组装分析上下文（指标清单 + 分布 + 阈值）
 *     → ③ 结构化生成（**优先 reasoning 档**，不可用时回落 fast）
 *     → ④ Zod 校验（指标键白名单 + 数值守卫）
 *     → ⑤ 归一化（行动按优先级排序、指标键去重）
 *     → AnalyticsReport
 *
 * ## 为什么这里可以用推理档，而直播只能用快速档
 *
 * 两个场景的成本结构完全不同：
 * - 直播评论是**高频**的（一场直播几十上百条），主播在等建议，慢一秒就错过节奏；
 * - 经营日报是**低频**的（一天一次，或手动点一次），比的是判断质量而不是延迟。
 *
 * 但「可以用推理档」不等于「必须用推理档」：真模型若没配 `AI_MODEL_REASONING`
 * 或该 Workspace 下模型名不可用，**不能因此让整个经营分析不可用**。
 * 因此这里做一次显式的档位回落（见 `isTierUnavailable`），
 * 并把回落写进返回值，界面上能看出来「这次是用快速档跑的」。
 *
 * ## Agent 不认识数据库
 *
 * 它的输入是一份已经算好的 `AnalyticsSnapshot` 与一个可选的 `AIProvider`。
 * 谁去查库、谁去算指标，都是调用方（Service）的事。
 */

import { getAIProvider } from "@/ai/provider";
import type { AIProvider, ModelTier } from "@/ai/provider/types";
import {
  ANALYTICS_AGENT_SYSTEM_PROMPT,
  ANALYTICS_WITH_SALES_SYSTEM_PROMPT,
  buildAnalyticsAnalystPrompt,
} from "@/ai/prompts/analytics-agent";
import { generateValidatedObject } from "@/ai/schemas/agent-output";
import {
  ANALYTICS_REPORT_FIELD_LABELS,
  ANALYTICS_REPORT_REQUIRED_KEYS,
  createAnalyticsReportSchema,
} from "@/ai/schemas/analytics-report";
import {
  ANALYTICS_METRIC_KEYS,
  collectAllowedPercents,
} from "@/analytics/metric-keys";
import { findSnapshotProblems } from "@/analytics/snapshot";
import { fail, ok, toAppError, type AppErrorShape, type Result } from "@/lib/result";
import { dedupeStrings } from "@/ai/schemas/field-rules";
import type { AnalyticsReport, AnalyticsSnapshot } from "@/types";

/** Agent 标识（运行时），与写入 `agent_tasks.agent_type` 的 `analytics_agent` 区分开 */
export const ANALYTICS_AGENT_ID = "analytics-agent";
export const ANALYTICS_AGENT_NAME = "经营分析师 Agent";

/** 首选的推理档：经营复盘是低频任务，值得用更好的判断质量 */
const PREFERRED_TIER: ModelTier = "reasoning";
/** 推理档不可用时退到的档位 */
const FALLBACK_TIER: ModelTier = "fast";

export interface AnalyticsAgentOptions {
  /** 注入 Provider（测试用）；默认取 `getAIProvider()` */
  provider?: AIProvider;
  signal?: AbortSignal;
}

export interface AnalyticsAgentRunResult {
  report: AnalyticsReport;
  providerId: string;
  /** 实际使用的档位（可能与首选不同，见 `tierFallback`） */
  tier: ModelTier;
  /** 是否因为推理档不可用而回落 */
  tierFallback: boolean;
  /** 调用模型的次数（含纠错重试与档位回落的那一次） */
  attempts: number;
  repaired: boolean;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* 档位回落判定                                                        */
/* ------------------------------------------------------------------ */

/**
 * 判断一次失败是否属于「模型档位不可用」。
 *
 * 为什么要同时看错误码与详情文案：
 * 百炼在模型名在当前账号不可用时返回 400 / 404，被 `mapHttpError` 归一化成
 * `VALIDATION_FAILED`（与「我们自己的输入校验失败」同码）。只按错误码判断，
 * 要么漏掉模型名问题（不回落），要么把输入问题也当成档位问题（白打一次）。
 * 因此对 `VALIDATION_FAILED` 额外要求详情里出现 `AI_MODEL_` ——
 * 那是**我们自己**写在错误详情里的配置提示，是可靠的判别依据。
 *
 * 反过来，下列错误**绝不**触发回落：它们与档位无关，换档只是换个方式再失败一次，
 * 还会多烧一次配额。
 */
export function isTierUnavailable(error: AppErrorShape): boolean {
  if (
    error.code === "MODEL_UNAVAILABLE" ||
    error.code === "MODEL_TIMEOUT" ||
    error.code === "NOT_IMPLEMENTED"
  ) {
    return true;
  }
  if (error.code === "VALIDATION_FAILED") {
    return (error.detail ?? "").includes("AI_MODEL_");
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 业务归一化（放在 Schema 之外，与 `field-rules` 的约定一致）：
 * 同一份输出在归一化前后应当得到**相同的校验结论**，否则行为会随调用次数抖动。
 *
 * - 行动建议按 `priority` 升序 —— 模型偶尔会乱序输出，界面不该跟着乱；
 * - 指标键去重 —— 模型有时会把同一个键写两遍凑数。
 */
function normalizeReport(report: AnalyticsReport): AnalyticsReport {
  return {
    ...report,
    highlights: report.highlights.map((item) => ({
      ...item,
      metricKeys: dedupeStrings(item.metricKeys),
    })),
    issues: report.issues.map((item) => ({
      ...item,
      metricKeys: dedupeStrings(item.metricKeys),
    })),
    actions: [...report.actions].sort(
      (left, right) => left.priority - right.priority,
    ),
    ...(report.salesReview ? { salesReview: { ...report.salesReview, actions: [...report.salesReview.actions].sort((left, right) => left.priority - right.priority) } } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export async function runAnalyticsAgent(
  snapshot: AnalyticsSnapshot,
  options: AnalyticsAgentOptions = {},
): Promise<Result<AnalyticsAgentRunResult>> {
  /** ① 快照结构校验：坏快照会变成「看起来很专业的错报告」，必须先挡住 */
  const problems = findSnapshotProblems(snapshot);
  if (problems.length > 0) {
    return fail(
      "VALIDATION_FAILED",
      "经营快照结构不合法，无法分析",
      problems.join("；"),
    );
  }

  // Provider 解析（真实提供方未接入时明确报错，不静默降级）
  let provider: AIProvider;
  if (options.provider) {
    provider = options.provider;
  } else {
    try {
      provider = getAIProvider();
    } catch (cause) {
      return {
        ok: false,
        error: toAppError(cause, "MODEL_UNAVAILABLE", "模型提供方不可用"),
      };
    }
  }

  /** ② 上下文 + 契约（白名单按次闭包进 Schema，见 `createAnalyticsReportSchema`） */
  const prompt = buildAnalyticsAnalystPrompt(snapshot);
  const schema = createAnalyticsReportSchema({
    allowedMetricKeys: ANALYTICS_METRIC_KEYS,
    allowedPercents: collectAllowedPercents(snapshot),
    sales: snapshot.sales,
  });

  const warnings: string[] = [];

  /** ③ 结构化生成（首选推理档） */
  const generate = (tier: ModelTier) =>
    generateValidatedObject({
      provider,
      system: snapshot.sales?.summary.count ? ANALYTICS_WITH_SALES_SYSTEM_PROMPT : ANALYTICS_AGENT_SYSTEM_PROMPT,
      prompt,
      schema,
      tier,
      temperature: 0,
      repairOutputLimit: 16_000,
      labels: ANALYTICS_REPORT_FIELD_LABELS,
      requiredKeys: snapshot.sales?.summary.count ? [...ANALYTICS_REPORT_REQUIRED_KEYS, "salesReview"] : ANALYTICS_REPORT_REQUIRED_KEYS,
      repairGuidance: () => snapshot.sales?.summary.count ? "只修复校验错误涉及的内容，其余已正确的字段保留。必须完整输出salesReview（含summary、opportunities、watchouts、actions）。占比已由系统计算，请原样复制sales.facts.display中的百分比（保留一位小数），禁止自行计算或取整；错误提示中的无依据百分比须替换为对应事实原值，找不到对应事实则改成定性描述，不能再次复述错误数字。不能计算单价、毛利率。站内工作回顾不含销售数字，每条metricKeys最多4个。返回完整报告，不能只返回修正字段。" : null,
      signal: options.signal,
    });

  let tier: ModelTier = PREFERRED_TIER;
  let generated = await generate(tier);
  let tierFallback = false;
  let totalAttempts = generated.ok ? generated.data.attempts : 0;

  /** ④ 档位回落：**只**在推理档不可用时发生，其余失败原样上抛 */
  if (!generated.ok && isTierUnavailable(generated.error)) {
    warnings.push(
      `推理档（${PREFERRED_TIER}）不可用（${generated.error.message}），已回落到快速档（${FALLBACK_TIER}）重试一次。`,
    );
    tier = FALLBACK_TIER;
    tierFallback = true;
    generated = await generate(tier);
    totalAttempts = generated.ok ? generated.data.attempts : totalAttempts;
  }

  if (!generated.ok) {
    return { ok: false, error: generated.error };
  }

  /** ⑤ 归一化 */
  const report = normalizeReport(generated.data.value);

  return ok({
    report,
    providerId: provider.id,
    tier,
    tierFallback,
    attempts: totalAttempts,
    repaired: generated.data.repaired,
    warnings,
  });
}
