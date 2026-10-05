"use server";

/**
 * Brand Agent 的 Server Actions（S3-1 Task 5）
 *
 * 为什么必须有这一层（任务书 Task 5「页面不能直接调用 Agent」）：
 * - Agent 与 Service 依赖 service_role 级别的凭证、数据库连接和模型 API Key，
 *   这些东西**绝不能**被打进浏览器 bundle；
 * - Server Action 是「客户端可以调、但代码只在服务端执行」的唯一入口，
 *   页面组件因此完全不需要 import `@/services` 或 `@/ai`。
 *
 * 约束：本文件只做「解析入参 → 调服务 → 失效缓存」，不含业务规则。
 */

import { revalidatePath } from "next/cache";

import { fail, type Result } from "@/lib/result";
import { getCurrentAuthUser } from "@/services/auth.service";
import {
  generateBrandProfile as runBrandGeneration,
  type BrandGenerationResult,
} from "@/services/brand-agent.service";

/**
 * 品牌生成会影响到的所有页面。
 *
 * 品牌档案是所有内容类 Agent 的共用约束，因此除了品牌中心本身，
 * 驾驶舱与后续内容页都会引用它；漏失效一处，用户就会看到
 * 「明明生成完了、别处还是旧品牌」这种状态不同步。
 */
function revalidateBrandSurfaces(): void {
  revalidatePath("/brand");
  revalidatePath("/dashboard");
}

/**
 * 触发一次品牌策略生成（首次生成或重新生成）。
 *
 * @param productId 主依据商品 id —— 品牌档案归属于商家，但推导需要从某个
 *                  具体商品（通常是主力商品）出发，因此这里要求显式传入。
 *
 * 注意：**无论成败都要失效缓存**。
 * 失败时任务记录会写入失败原因、界面需要从「生成中」切到「失败」，
 * 不刷新的话用户看不到任何反馈。
 */
export async function generateBrandProfile(
  productId: string,
  replaceExisting = false,
): Promise<Result<BrandGenerationResult>> {
  if (!(await getCurrentAuthUser())) {
    return fail("UNAUTHORIZED", "请先登录后再生成品牌档案");
  }
  if (!productId || typeof productId !== "string") {
    return fail("VALIDATION_FAILED", "缺少品牌生成的依据商品 ID");
  }

  if (typeof replaceExisting !== "boolean") {
    return fail("VALIDATION_FAILED", "覆盖选项无效");
  }
  const result = await runBrandGeneration(productId, { replaceExisting });
  revalidateBrandSurfaces();
  return result;
}
