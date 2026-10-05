/**
 * 复用判定（S4-1）
 *
 * 职责：在看模型调用之前，先判断哪些任务**没必要真的执行** ——
 * 已有有效结果时直接复用，既省钱又更快，而且对商家没有任何损失。
 *
 * 为什么必须有这一层，而不是只靠提示词让模型「别重复安排」：
 * 提示词是**建议**，模型完全可能忽略它（尤其是上下文里商品一多就容易漏看状态位）。
 * 一旦忽略，商家就会收到一份「把已分析过的商品再分析一遍」的计划，白花模型调用。
 * 提示词负责让计划**通常**合理，复用判定负责让计划**即使不合理也不浪费钱** ——
 * 两层是互补的，不是冗余。
 *
 * 本模块是纯函数：不查库、不调模型。它读的是一份**状态快照**
 * （由服务层在规划开始时一次性取好）。这样做有两个好处：
 * - 判定逻辑可以脱离数据库单测（构造快照即可覆盖全部分支）；
 * - 快照在规划开始时固定，判定结论与「计划成立的那一刻」一致 ——
 *   若改成判定时逐条实时查库，商家在执行过程中删掉一件商品，
 *   就会让一份本来合法的计划突然读不通，而那不是模型的问题。
 */

import type { BusinessPlanTaskDraft } from "@/ai/schemas/business-plan";
import { toContentSlotKey } from "@/repositories/content-item";
import type { ContentSlot } from "@/types";

/** 规划开始时的经营状态快照 */
export interface BusinessStateSnapshot {
  /** 同一工作流上一轮已经完成的任务；重试时优先复用，覆盖所有 Agent 类型 */
  completedTaskIds?: ReadonlySet<string>;
  /** 已有商品理解（Product DNA）的商品 id */
  productsWithDna: ReadonlySet<string>;
  /** 是否已有品牌档案 */
  hasBrandProfile: boolean;
  /**
   * 已有内容的槽位键集合，键由 `toContentSlotKey` 生成。
   * 刻意用键集合而不是内容数组：判定只关心「这个槽位有没有内容」，
   * 把整条内容传进来会让本模块被迫理解内容的结构，耦合不必要。
   */
  contentSlotKeys: ReadonlySet<string>;
}

/** 一条复用结论 */
export interface ReuseDecision {
  taskId: string;
  /** 面向商家的说明：**复用了什么**（不是「跳过了什么」） */
  reason: string;
}

/** 从一个任务解出内容槽位；非内容任务或缺参数的返回 null */
export function toTaskContentSlot(
  task: BusinessPlanTaskDraft,
): ContentSlot | null {
  if (
    task.agent !== "content_agent" ||
    !task.productId ||
    !task.platform ||
    !task.format
  ) {
    return null;
  }
  return {
    productId: task.productId,
    platform: task.platform,
    format: task.format,
  };
}

/**
 * 逐任务判定能否复用，返回「task id → 复用说明」。
 *
 * 判定规则（按 Agent 分别定，因为它们产出的东西性质不同）：
 * - **商品理解**：该商品已有 Product DNA → 复用。
 *   刻意**不设时间窗口**：Product DNA 是描述性结论，不会因为放了一个月就变错。
 *   它只在商品资料被改写后才需要重算，而那种情况该由商家在商品详情页主动触发重跑 ——
 *   编排层替他「猜」资料有没有变，只会在猜错时把一条新结论覆盖掉。
 * - **品牌档案**：已有档案（全店唯一）→ 复用。
 * - **内容资产**：该「商品 × 平台 × 形态」槽位已有内容 → 复用。
 *   注意这与 S3-2 内容工厂里「重新生成会覆盖同一条」**并不矛盾**：
 *   那边是商家**明确要求重新生成**（点了按钮），这边是编排层自作主张跑一轮，
 *   自然是「已有的不重做」。要刷新内容，商家仍然可以在内容工厂手动重跑。
 *
 * 复用的任务**仍然会在工作流里占一个位置**并记为 `reused`：
 * 它是一条真实发生过的编排决策，藏起来会让商家看不懂「为什么计划 5 步只跑了 2 步」。
 */
export function resolveReusableTasks(
  tasks: readonly BusinessPlanTaskDraft[],
  state: BusinessStateSnapshot,
): Map<string, ReuseDecision> {
  const decisions = new Map<string, ReuseDecision>();

  for (const task of tasks) {
    if (state.completedTaskIds?.has(task.id)) {
      decisions.set(task.id, {
        taskId: task.id,
        reason: "该步骤在本工作流上一轮已经完成，本次重试直接复用结果。",
      });
      continue;
    }

    switch (task.agent) {
      case "product_agent": {
        if (task.productId && state.productsWithDna.has(task.productId)) {
          decisions.set(task.id, {
            taskId: task.id,
            reason:
              "该商品已有商品理解结论，本次不再重复分析（如需更新请在商品详情页手动重新分析）。",
          });
        }
        break;
      }
      case "brand_agent": {
        if (state.hasBrandProfile) {
          decisions.set(task.id, {
            taskId: task.id,
            reason:
              "品牌档案已存在且全店只有一份，本次不再重新生成（如需更新请在品牌中心手动重新生成）。",
          });
        }
        break;
      }
      case "content_agent": {
        const slot = toTaskContentSlot(task);
        if (slot && state.contentSlotKeys.has(toContentSlotKey(slot))) {
          decisions.set(task.id, {
            taskId: task.id,
            reason:
              "该平台与内容形态下已有内容，本次不重复生成（如需刷新请在内容工厂手动重新生成）。",
          });
        }
        break;
      }
      case "customer_service_agent":
      case "live_agent":
      case "analytics_agent":
        // 首次执行必须真实预演/汇总；仅在同一工作流重试时按 completedTaskIds 复用。
        break;
    }
  }

  return decisions;
}
