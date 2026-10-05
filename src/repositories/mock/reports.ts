/**
 * 经营日报仓储 · Mock 实现（S6-B）
 *
 * 与数据库实现保持同一套语义（「切数据源不改上层」的前提）：
 * - 列表按创建时间倒序（与 DB 的 `ORDER BY created_at DESC` 同一口径）；
 * - `findLatest()` 就是列表首项，语义固定为「最近一次复盘」；
 * - 目标 id 不存在时 `findById` 返回 `null`（沿用其它仓储「找不到就 null」的约定）。
 *
 * 数据只存在于进程内存，重启即清空 —— 因此**没有种子**：
 * 预置一份固定日报会让界面显示一份「看起来是 AI 生成的常量」，
 * 而日报必须真的跑一次模型（任务书第十八节）。
 */

import { formatDateTime } from "@/lib/datetime";
import { createLocalId } from "@/lib/id";
import type { BusinessReport } from "@/types";

import type { AnalyticsReportRepository } from "../types";
import {
  findStoredBusinessReport,
  listStoredBusinessReports,
  putStoredBusinessReport,
} from "./store";

export function createMockAnalyticsReportRepository(): AnalyticsReportRepository {
  return {
    async create(input) {
      const record: BusinessReport = {
        id: createLocalId("report"),
        businessId: input.businessId,
        /**
         * 快照与结论一起深拷贝存下：调用方随后可能继续使用同一份对象，
         * 若共享引用，一次不经意的原地修改会同时篡改「历史记录」。
         */
        snapshot: structuredClone(input.snapshot),
        report: structuredClone(input.report),
        createdAt: formatDateTime(new Date()),
      };
      putStoredBusinessReport(record);
      return record;
    },

    async findLatest() {
      return listStoredBusinessReports()[0] ?? null;
    },

    async listRecent(limit?: number) {
      const all = listStoredBusinessReports();
      if (limit === undefined) {
        return all;
      }
      return all.slice(0, Math.max(0, limit));
    },

    async findById(id: string) {
      return findStoredBusinessReport(id) ?? null;
    },
  };
}
