import {
  MOCK_ANALYTICS_OVERVIEW,
  MOCK_BUSINESS_GOAL,
  MOCK_DASHBOARD_METRICS,
} from "@/lib/mock";

import type { AnalyticsRepository } from "../types";

/**
 * 经营分析仓储的 Mock 实现。
 *
 * ⚠️ 这里返回的全部是**模拟经营数据**（流量 / 转化 / 销量 / 互动率）。
 * 本地 Demo 没有真实订单，这些数字没有任何真实来源 ——
 * 界面上必须明确标注「模拟数据」，绝不可以与 `AnalyticsSnapshot`
 * 的程序计算结果混在同一处展示（任务书第七节）。
 *
 * 注意这里**没有** `getDailyReport()`：AI 经营日报已改为
 * `repositories.reports`（真的跑一次 Analytics Agent 再落库），
 * 不再允许从常量返回一份「看起来是 AI 生成的」日报。
 */
export function createMockAnalyticsRepository(): AnalyticsRepository {
  return {
    async getOverview() {
      return MOCK_ANALYTICS_OVERVIEW;
    },

    async getDashboardMetrics() {
      return [...MOCK_DASHBOARD_METRICS];
    },

    async getBusinessGoal() {
      return MOCK_BUSINESS_GOAL;
    },
  };
}
