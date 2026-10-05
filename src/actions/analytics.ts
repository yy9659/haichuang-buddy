"use server";

/**
 * 经营分析师的 Server Actions（S6-B · 任务书第十四 / 三十三节）
 *
 * 为什么日报生成必须走 Server Action：一次经营复盘要**读遍全业务域**
 * （商品 / 内容 / 工作流 / 客服 / 直播 / Agent 任务）算指标，再调 DashScope
 * 做归因。数据源、模型凭证、快照口径没有一件能放到浏览器里。
 *
 * 链路固定为：
 *
 *   Client Component → Server Action → Analytics Service
 *     → 纯函数快照 → Analytics Agent → Report Repository
 *
 * 本文件只做三件事：调服务 → 失效缓存 → 原样返回结果。
 * **不含任何业务规则**（并发保护、失败不删旧日报都在 Service 里）。
 */

import { revalidatePath } from "next/cache";

import type { Result } from "@/lib/result";
import { fail } from "@/lib/result";
import type { SalesReviewMode } from "@/types";
import {
  generateBusinessReport,
  type BusinessReportGenerationResult,
} from "@/services/analytics.service";

/**
 * 日报会影响到的所有页面。
 *
 * 驾驶舱的「AI 经营日报」卡片与经营分析页读的是同一份 `business_reports`，
 * 漏失效一处，用户就会看到「这边生成完了、那边还是旧的」。
 */
function revalidateAnalyticsSurfaces(): void {
  revalidatePath("/analytics");
  revalidatePath("/dashboard");
}

/**
 * 生成今日经营日报。
 *
 * 语义与品牌生成一致：**无论成败都失效缓存**。
 * - 成功：新日报落库，页面要展示它；
 * - 失败：任务记录已写入失败原因，页面要从「分析中」切到「最近一次复盘异常」。
 *
 * `RATE_LIMITED`（上一轮还在跑）同样刷新：界面需要呈现「仍在分析中」的真实状态，
 * 而不是永远停在点击前的那一屏。
 */
export async function generateBusinessReportAction(): Promise<
  Result<BusinessReportGenerationResult>
> {
  const result = await generateBusinessReport();
  revalidateAnalyticsSurfaces();
  return result;
}

export async function generateSalesReviewAction(mode: SalesReviewMode): Promise<Result<BusinessReportGenerationResult>> {
  if (mode !== "real" && mode !== "demo") return fail("VALIDATION_FAILED", "销售记录类型无效");
  const result = await generateBusinessReport({ salesMode: mode });
  revalidateAnalyticsSurfaces();
  return result;
}
