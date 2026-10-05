"use server";

/**
 * Content Agent 的 Server Actions（S3-2 Task 6）
 *
 * 为什么必须有这一层（与品牌中心同一理由）：
 * - Agent 与 Service 依赖数据库连接与模型 API Key，这些东西**绝不能**进浏览器 bundle；
 * - Server Action 是「客户端可以调、代码只在服务端执行」的唯一入口，
 *   页面组件因此完全不需要 import `@/services` 或 `@/ai`。
 *
 * 约束：本文件只做「解析入参 → 调服务 → 失效缓存」，不含任何业务规则。
 * 尤其是**不要在这里做并发保护或依据检查** —— 那些是服务层的职责，
 * 放在这一层会让「页面调用」与「其他调用方」走出两套不同的行为。
 */

import { revalidatePath } from "next/cache";

import { isContentAngle, isContentFormat, isContentPlatform, type ContentAngle } from "@/lib/content-options";
import { fail, type Result } from "@/lib/result";
import {
  generateContent as runContentGeneration,
  type ContentGenerationResult,
} from "@/services/content-agent.service";

/**
 * 内容生成会影响到的所有页面。
 *
 * 内容资产既出现在内容工厂，也参与驾驶舱的「今日任务 / 内容产出」口径；
 * 漏失效一处，用户就会看到「明明生成完了、别处还是旧数据」这种状态不同步。
 */
function revalidateContentSurfaces(): void {
  revalidatePath("/content");
  revalidatePath("/dashboard");
}

/**
 * 触发一次内容 AI 生成（首次生成或按槽位覆盖重新生成）。
 *
 * @param productId 目标商品 id
 * @param platform  发布平台
 * @param format    内容形态
 *
 * 注意：**无论成败都要失效缓存**。
 * 失败时任务记录会写入失败原因、界面需要从「生成中」切到「失败」，
 * 不刷新的话用户看不到任何反馈。
 */
export async function generateContent(
  productId: string,
  platform: string,
  format: string,
  angle: ContentAngle = "selling-point",
): Promise<Result<ContentGenerationResult>> {
  if (!productId || typeof productId !== "string") {
    return fail("VALIDATION_FAILED", "缺少要生成内容的商品 ID");
  }
  if (!isContentPlatform(platform)) {
    return fail("VALIDATION_FAILED", "发布平台不合法");
  }
  if (!isContentFormat(format)) {
    return fail("VALIDATION_FAILED", "内容形态不合法");
  }

  if (!isContentAngle(angle)) {
    return fail("VALIDATION_FAILED", "推广重点不正确");
  }

  const result = await runContentGeneration(productId, platform, format, { angle });
  revalidateContentSurfaces();
  return result;
}
