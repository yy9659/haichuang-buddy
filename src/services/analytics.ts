/**
 * 经营分析页视图装配（S6-B）
 *
 * 页面只调这一个入口，拿到的数据被**显式分成两组**，界面据此分区块展示：
 *
 * - `real`：**系统真实指标** —— 由 `@/analytics/snapshot` 程序计算，
 *   外加真的跑过一次 Analytics Agent 的 AI 经营日报与历史。
 * - `simulated`：**模拟经营数据** —— 流量 / 转化 / 商品表现这类依赖真实订单与
 *   平台后台的数字，本地 Demo 没有任何真实来源，因此**原样保留但必须标注**
 *   「模拟数据」（任务书第七节）。宁可标着展示，也不要假装它们是真实经营结果。
 *
 * 与 `analytics.service.ts` 的分工，和 `live.ts` 与 `live-agent.service.ts` 一样：
 * 本文件负责「页面要什么」，那个文件负责「经营分析能力本身」。
 */

import type {
  AnalyticsOverview,
  BusinessGoal,
} from "@/types";
import { getRepositories } from "@/repositories";
import { attempt, toAppError, type Result } from "@/lib/result";
import { getAnalyticsOverview, type AnalyticsOverviewView } from "./analytics.service";

/** 经营分析页所需数据 */
export interface AnalyticsView {
  /** 真实：程序计算的经营快照 + AI 经营日报 + 历史 + 生成状态 */
  real: AnalyticsOverviewView;
  /**
   * 模拟经营数据（演示用；界面上必须标注「模拟」）。
   *
   * **永不为 null**：读不到时退化成 `EMPTY_SIMULATED`（全空数组），
   * 由 `simulatedUnavailable` 告诉界面「这不是真的没有数据，而是读不到」。
   * 让类型保持可空会逼着每个使用点写一次 `?? EMPTY` ——
   * 那正是「某处忘了兜底、于是整页白屏」的来源。
   */
  simulated: AnalyticsOverview;
  /** 模拟数据是否不可用（如切到 db 数据源时该仓储尚未迁移） */
  simulatedUnavailable: boolean;
  /**
   * 模拟区块不可用的**原因**；可用时为 `null`。
   *
   * 只在「该领域在当前数据源下尚未实现」（`NOT_IMPLEMENTED`）时给出。
   * 界面据此区分两件对用户含义完全不同的事：
   * - 有原因 → 「这个模块还没接到这个数据源上」：说清楚，别让人反复点；
   * - 无原因（临时读失败）→ 「暂时读不到」：建议稍后刷新，而不是宣判模块已死。
   */
  simulatedUnavailableReason: string | null;
  businessGoal: BusinessGoal | null;
}

/**
 * 模拟区块的空值兜底。
 *
 * 用「空数组」而不是「半个对象」：界面拿到空数组就什么都不画，
 * 不会出现「有标题没有数据」的空壳卡片。
 */
const EMPTY_SIMULATED: AnalyticsOverview = {
  metrics: [],
  trend: [],
  questionCategories: [],
  topQuestions: [],
  contentPerformance: [],
  productPerformance: [],
  agentTaskStats: [],
  interestShifts: [],
};

export async function getAnalyticsView(): Promise<Result<AnalyticsView>> {
  const real = await getAnalyticsOverview();
  if (!real.ok) {
    return real;
  }

  const repositories = getRepositories();

  /**
   * 模拟区块按「可降级」处理：它是演示素材，读不到不该让整页失败。
   * 注意**真实区块不做这种降级** —— 算不出经营指标就没有报告可言，
   * 硬撑出一个空快照比报错更危险（会让日报基于 0 值给出错误的结论）。
   */
  const simulated = await attempt(
    async (): Promise<{ overview: AnalyticsOverview; businessGoal: BusinessGoal | null }> => {
      const [overview, businessGoal] = await Promise.all([
        repositories.analytics.getOverview(),
        repositories.analytics.getBusinessGoal(),
      ]);
      return { overview, businessGoal };
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载模拟经营数据失败"),
  );

  return {
    ok: true,
    data: {
      real: real.data,
      simulated: simulated.ok ? simulated.data.overview : EMPTY_SIMULATED,
      simulatedUnavailable: !simulated.ok,
      // 只把「没实现」当成「尚未启用」；真实读失败不给原因，界面按「稍后重试」处理
      simulatedUnavailableReason:
        !simulated.ok && simulated.error.code === "NOT_IMPLEMENTED"
          ? simulated.error.message
          : null,
      businessGoal: simulated.ok ? simulated.data.businessGoal : null,
    },
  };
}
