"use server";

/**
 * Product Agent 的 Server Actions
 *
 * 为什么必须有这一层（任务书 Task 3「页面不能直接调用 Agent」）：
 * - Agent 与 Service 依赖 service_role 级别的凭证、数据库连接和模型 API Key，
 *   这些东西**绝不能**被打进浏览器 bundle；
 * - Server Action 是「客户端可以调、但代码只在服务端执行」的唯一入口，
 *   页面组件因此完全不需要 import `@/services` 或 `@/ai`。
 *
 * 约束：本文件只做「解析入参 → 调服务 → 失效缓存」，不含业务规则。
 */

import { revalidatePath } from "next/cache";

import { fail, type Result } from "@/lib/result";
import {
  analyzeProduct,
  type ProductAnalysisResult,
} from "@/services/product-agent.service";

/**
 * 商品分析会影响到的所有页面。
 * 少失效一个地方，用户就会看到「明明分析完了、列表里还是待分析」这种状态不同步。
 */
function revalidateProductAnalysisSurfaces(productId: string): void {
  revalidatePath("/products");
  revalidatePath(`/products/${productId}`);
  revalidatePath("/dashboard");
  revalidatePath("/analytics");
}

/**
 * 触发一次商品 AI 分析（首次分析或重新分析）。
 *
 * 注意：**无论成败都要失效缓存**。
 * 失败时商品状态会变成 `failed`、任务记录会写入失败原因，
 * 不刷新的话页面会一直停在「待分析」，用户看不到任何反馈。
 */
export async function startProductAnalysis(
  productId: string,
): Promise<Result<ProductAnalysisResult>> {
  if (!productId || typeof productId !== "string") {
    return fail("VALIDATION_FAILED", "缺少要分析的商品 ID");
  }

  const result = await analyzeProduct(productId);
  revalidateProductAnalysisSurfaces(productId);
  return result;
}
