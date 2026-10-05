/**
 * 经营分析（模拟区块）仓储 · 数据库实现（S7 补齐）
 *
 * 与 Live / 日报不同，这里返回的**不是持久化数据**：`AnalyticsRepository`
 * 的三个方法原本就是模拟演示数据（流量 / 转化 / 销量 / 商品表现）。
 * 商户自行导入的销售记录存于独立的 sales_records 表，不走这里。
 * 因此这些旧模拟指标**没有对应的表**，也不该有。
 *
 * 那为什么不像旧版那样抛 `NOT_IMPLEMENTED`？
 * 「尚未迁移到数据库」暗示「将来会有真实数据」，而流量 / 转化这类数字
 * 只有在接入真实平台后台后才可能有来源 —— 那不属于「把某张表接到本地库」，
 * 而是「接一个外部系统」。把这件事误标成 NOT_IMPLEMENTED，等于给了界面一个
 * 错误信号：它显示「该模块尚未启用」，让人以为补齐某张表就能点亮。
 *
 * 正确的语义是：模拟数据在 db 数据源下**就是空的**（无来源、无种子）。
 * 界面据 `simulatedUnavailable` 显示「暂无模拟数据」，而不是「尚未启用」。
 */

import type { AnalyticsRepository } from "../types";

/** 模拟区块的空值兜底：与 `services/analytics.ts` 的 EMPTY_SIMULATED 同一形状 */
function emptyOverview() {
  return {
    metrics: [],
    trend: [],
    questionCategories: [],
    topQuestions: [],
    contentPerformance: [],
    productPerformance: [],
    agentTaskStats: [],
    interestShifts: [],
  };
}

export function createDbAnalyticsRepository(): AnalyticsRepository {
  return {
    async getOverview() {
      return emptyOverview();
    },

    async getDashboardMetrics() {
      return [];
    },

    async getBusinessGoal() {
      return null;
    },
  };
}
