"use server";

/**
 * 经营工作流的 Server Actions（S4-2）
 *
 * 为什么必须有这一层（与各领域 Action 同一理由）：
 * Agent 与 Service 依赖数据库连接与模型 API Key，这些东西**绝不能**进浏览器包。
 * Server Action 是「客户端可以调、代码只在服务端执行」的唯一入口，
 * 页面组件因此完全不需要 import `@/services` 或 `@/ai`。
 *
 * 本文件只有三件事：**收参数 → 调服务 → 失效缓存**。
 * 尤其是**不要在这里做并发保护或依据检查** —— 那些是服务层的职责，
 * 放在这一层会让「对话框调用」与「其它调用方」走出两套不同的行为
 * （例如 S4-1 已有的 `planAndRunBusinessGoal` 一键跑完的路径）。
 *
 * 与其它 Action 的一处差别：这里**剥掉了错误的 `detail`**。
 * 理由：编排层的 detail 里装着工作流 id、违规清单、时间戳这类给开发者看的线索，
 * 一旦进了浏览器就等于把内部结构暴露给任何能打开控制台的人。
 * 商家需要的是 `message`（一句中文的处置建议），
 * 开发者需要的是服务端日志 —— 两者不该走同一条通路。
 */

import { revalidatePath } from "next/cache";

import type { Result } from "@/lib/result";
import {
  createBusinessPlan,
  getWorkflowState,
  retryWorkflow,
  startBusinessWorkflow,
  type BusinessPlanResult,
  type BusinessWorkflowState,
  type WorkflowRunView,
} from "@/services/business-brain.service";

/**
 * 一次经营会影响到的所有页面。
 *
 * 编排层跑一轮会写 `agent_tasks` / `agent_workflows`，并经由六个 Agent Service
 * 改动商品理解、品牌、内容、客服、直播与日报。漏失效任意一处，
 * 商家就会看到「驾驶舱说完成了、内容工厂里还是旧数据」这种状态不同步 ——
 * 而这类不一致最伤信任，因为它看起来像是「AI 说做了但其实没做」。
 */
function revalidateWorkflowSurfaces(): void {
  revalidatePath("/dashboard");
  revalidatePath("/content");
  revalidatePath("/brand");
  revalidatePath("/products");
  revalidatePath("/customer-service");
  revalidatePath("/live");
  revalidatePath("/analytics");
}

/**
 * 剥掉 `detail`，只把商家需要的那部分交回浏览器。
 *
 * 注意这里**只是过滤，不是降级**：`code` / `message` / `retryable` 原样保留，
 * 界面该做的分支判断一个都不少（`retryable` 决定要不要显示「重新执行」）。
 */
function toClientResult<T>(result: Result<T>): Result<T> {
  if (result.ok) {
    return result;
  }
  return {
    ok: false,
    error: {
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.retryable,
    },
  };
}

/** 驾驶舱对话框提交的经营目标表单 */
export interface CreateBusinessPlanPayload {
  /** 商家的原话（**不是**组装后的文本 —— 组装由服务端统一完成，见服务层注释） */
  goal: string;
  /** 主推商品 id */
  productId?: string | null;
  /** 目标人群，可选 */
  targetAudience?: string | null;
  /** 勾选的渠道（平台值数组，如 `["douyin", "wechat"]`） */
  channels?: readonly string[];
  /** 由用户在弹窗明确选择，全链路计划必须覆盖六个岗位。 */
  fullChain?: boolean;
}

/**
 * 制定经营计划（**只规划，不执行**）。
 *
 * 返回的计划会先展示给商家确认 —— 这是「人拥有最终决策权」的落点，
 * 因此这里绝不顺手把工作流跑起来（那条近路叫 `planAndRunBusinessGoal`，
 * 只服务于本地验证与集成测试）。
 */
export async function createBusinessPlanAction(
  payload: CreateBusinessPlanPayload,
): Promise<Result<BusinessPlanResult>> {
  const result = await createBusinessPlan(payload.goal, {
    primaryProductId: payload.productId ?? null,
    channels: payload.channels ?? [],
    targetAudience: payload.targetAudience ?? null,
    fullChain: payload.fullChain === true,
  });
  /**
   * 规划成功时也失效缓存：库里多了一条 `idle` 工作流，
   * 驾驶舱的 Business Brain 卡片要从「空闲」切到「待确认计划」。
   */
  if (result.ok) {
    revalidateWorkflowSurfaces();
  }
  return toClientResult(result);
}

/** 启动一份尚未执行过的计划 */
export async function startBusinessWorkflowAction(
  workflowId: string,
): Promise<Result<WorkflowRunView>> {
  const result = await startBusinessWorkflow(workflowId);
  revalidateWorkflowSurfaces();
  return toClientResult(result);
}

/**
 * 重跑没能全部成功的一轮。
 *
 * 「只跑失败任务」不在这里实现，也不该在这里实现：
 * 复用判定会看着当前现状把已经拿到结果的步骤标成 `reused`，
 * 于是真正被执行的只有没成的那几步 —— 只有一条执行路径要维护。
 */
export async function retryBusinessWorkflowAction(
  workflowId: string,
): Promise<Result<WorkflowRunView>> {
  const result = await retryWorkflow(workflowId);
  revalidateWorkflowSurfaces();
  return toClientResult(result);
}

/**
 * 读取某一轮的状态（**轮询用**）。
 *
 * 与其他三个 Action 的关键差别：**不失效任何缓存**。
 * 轮询每 2~3 秒调一次，若每次都 revalidate，整页会跟着反复重渲染，
 * 用户看到的是页面在抖；而轮询要的只是这一条工作流的最新状态。
 *
 * 不传 `workflowId` 时返回「最近一轮」，供对话框在打开时定位当前进度。
 */
export async function getBusinessStateAction(
  workflowId?: string,
): Promise<Result<BusinessWorkflowState | null>> {
  const result = await getWorkflowState(workflowId);
  return toClientResult(result);
}
