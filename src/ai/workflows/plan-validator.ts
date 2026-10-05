/**
 * 经营计划校验器（S4-1）
 *
 * 职责单一：判断一份计划**能不能被执行**，不能则说清为什么。
 * 它不修计划、不排序、不查库、不调用模型 —— 纯函数，输入输出都是普通数据，
 * 因此可以被三处复用，且三处的结论必然一致：
 *
 *   1. Business Brain 规划后自检 —— 有问题就把违规清单回喂模型纠错一次；
 *   2. 编排服务启动前复核 —— 挡住任何来源的非法规计划（例如从 jsonb 读回的旧计划）；
 *   3. 单元测试 —— 直接构造脏计划断言违规码，不需要起服务。
 *
 * 为什么规则集中在这里、而不写进 Zod Schema：
 * 「content_agent 必须给 platform」这类要求是**跨字段语义**，
 * 写进 Schema 就会与校验器各存一份，两边迟早说不一样的话，
 * 而且 Schema 报的错会被 `generateValidatedObject` 当成格式问题处理，
 * 语义问题的纠错反馈就丢失了。形状归 Schema，语义归这里。
 *
 * 关于「防御性检查」：入参类型已经是 `BusinessPlanDraft`，从模型刚产出的路径进来时，
 * 白名单 / 字数 / id 字符集都已被 Schema 保证。但计划**还会从 `agent_workflows.plan`
 * 的 jsonb 读回来**（重试、界面展示），那条路径上的对象是结构断言而非 Schema 解析产物。
 * 因此这里的检查一律按「运行时值可能不符合类型」来写，代价极小，换的是重试路径不会踩空。
 */

import { CONTENT_FORMATS, CONTENT_PLATFORMS } from "@/lib/content-options";
import {
  MAX_PLAN_TASKS,
  PLANNER_AGENT_LABEL,
  isPlannerAgentId,
  type BusinessPlanDraft,
  type BusinessPlanTaskDraft,
  type PlannerAgentId,
} from "@/ai/schemas/business-plan";

/** 违规码。界面与测试都靠它区分，因此不做合并（合并后就没法精确表达） */
export type PlanViolationCode =
  | "EMPTY_PLAN"
  | "TOO_MANY_TASKS"
  | "DUPLICATE_TASK_ID"
  | "UNKNOWN_AGENT"
  | "SELF_DEPENDENCY"
  | "INVALID_DEPENDENCY"
  | "DEPENDENCY_NOT_PRIOR"
  | "CIRCULAR_DEPENDENCY"
  | "UNKNOWN_PRODUCT"
  | "MISSING_PRODUCT"
  | "MISSING_CONTENT_TARGET"
  | "MISSING_REQUIRED_AGENT";

export interface PlanViolation {
  code: PlanViolationCode;
  /** 面向商家 / 面向模型的一句中文说明（模型纠错时直接读它） */
  message: string;
  /** 违规所属任务；计划级问题（如任务过多）没有这个字段 */
  taskId?: string;
}

export interface PlanValidationContext {
  /**
   * 本次允许引用的商品 id（调用时的快照）。
   * 传**快照**而不是「自己去查库」：计划是在某个时刻针对某批商品制定的，
   * 事后商品被删了，也不该把当时的计划判成非法。
   */
  availableProductIds: readonly string[];
  /** 明确选择全链路时，计划必须包含的执行岗位；已有结果也应列为可复用步骤。 */
  requiredAgents?: readonly PlannerAgentId[];
}

export interface PlanValidationResult {
  ok: boolean;
  violations: PlanViolation[];
}

/** 需要指定目标商品的 Agent（品牌档案与全店经营分析不绑定商品） */
const AGENTS_REQUIRING_PRODUCT = new Set([
  "product_agent",
  "content_agent",
  "customer_service_agent",
  "live_agent",
]);

function agentLabel(agent: string): string {
  return isPlannerAgentId(agent) ? PLANNER_AGENT_LABEL[agent] : agent;
}

/**
 * 找出所有的环，每个环报一条违规。
 *
 * 用三色 DFS（未访问 / 在栈上 / 已完成）而不是 Kahn 拓扑排序：
 * 拓扑排序只能告诉你「有环」，DFS 还能把**环的路径**报出来（如 `task-2 → task-3 → task-2`），
 * 这条路径对模型纠错和人工排查都是最有用的信息。
 *
 * 只遍历指向「已知任务」的边；自引用与指向未知 id 的边已在前面的检查里报过，
 * 在这里再报一次只会让纠错提示充满重复的抱怨。
 */
function findCycles(
  tasks: readonly BusinessPlanTaskDraft[],
  knownIds: ReadonlySet<string>,
): PlanViolation[] {
  const edges = new Map<string, string[]>();
  for (const task of tasks) {
    edges.set(
      task.id,
      task.dependsOn.filter((dep) => dep !== task.id && knownIds.has(dep)),
    );
  }

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const violations: PlanViolation[] = [];
  const reported = new Set<string>();

  const visit = (id: string): void => {
    state.set(id, "visiting");
    stack.push(id);

    for (const next of edges.get(id) ?? []) {
      const nextState = state.get(next);
      if (nextState === "visiting") {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start), next];
        // 同一个环可能从不同入口被发现，用规范化后的键去重
        const key = [...new Set(cycle)].sort().join("|");
        if (!reported.has(key)) {
          reported.add(key);
          violations.push({
            code: "CIRCULAR_DEPENDENCY",
            taskId: next,
            message: `任务之间存在循环依赖（${cycle.join(" → ")}），无法确定执行顺序，请拆掉其中的一环`,
          });
        }
        continue;
      }
      if (nextState !== "done") {
        visit(next);
      }
    }

    stack.pop();
    state.set(id, "done");
  };

  for (const task of tasks) {
    if (!state.has(task.id)) {
      visit(task.id);
    }
  }

  return violations;
}

/**
 * 校验一份计划。
 *
 * 检查项（顺序即报错顺序，越靠前的越根本）：
 * 1. 任务数量：1 ~ MAX_PLAN_TASKS；
 * 2. 任务 id 唯一；
 * 3. agent 必须在白名单内；
 * 4. dependsOn：不得自引用、不得指向不存在的 id、不得指向排在后面的任务；
 * 5. 不得存在循环依赖；
 * 6. productId：商品 / 内容 / 客服 / 直播 Agent 必须指定，且必须来自本次可用商品；
 * 7. content_agent 必须同时给出 platform 与 format。
 *
 * 关于第 4 条「不得指向排在后面的任务」：
 * 功能上执行器按拓扑序跑，数组顺序不影响正确性；但这份计划**是要展示给人看的**
 * （「执行顺序」就是数组顺序），前置任务排在被依赖任务之后会让商家读不懂编排。
 * 对模型来说把前置提到前面是最容易修正的一类问题，因此按违规处理而非仅告警。
 */
export function validateBusinessPlan(
  plan: BusinessPlanDraft,
  context: PlanValidationContext,
): PlanValidationResult {
  const violations: PlanViolation[] = [];
  const tasks = plan.tasks;

  if (tasks.length === 0) {
    violations.push({
      code: "EMPTY_PLAN",
      message: "计划里没有任何任务，至少要安排一步才能真正推进目标",
    });
    return { ok: false, violations };
  }

  if (tasks.length > MAX_PLAN_TASKS) {
    violations.push({
      code: "TOO_MANY_TASKS",
      message: `计划安排了 ${tasks.length} 个任务，超过上限 ${MAX_PLAN_TASKS} 个，请只保留达成目标所必需的步骤`,
    });
  }

  // 任务 id 唯一 + 位置索引（后面判断「依赖是否排在前面」要用）
  const positionById = new Map<string, number>();
  for (const [index, task] of tasks.entries()) {
    const seenAt = positionById.get(task.id);
    if (seenAt !== undefined) {
      violations.push({
        code: "DUPLICATE_TASK_ID",
        taskId: task.id,
        message: `任务 id「${task.id}」重复出现（第 ${seenAt + 1} 个与第 ${index + 1} 个），id 必须唯一`,
      });
      continue;
    }
    positionById.set(task.id, index);
  }

  const availableProducts = new Set(context.availableProductIds);

  for (const [index, task] of tasks.entries()) {
    const order = index + 1;

    if (!isPlannerAgentId(task.agent)) {
      violations.push({
        code: "UNKNOWN_AGENT",
        taskId: task.id,
        message: `第 ${order} 个任务指定了不可用的 Agent「${task.agent}」，可用的只有 ${Object.values(PLANNER_AGENT_LABEL).join(" / ")}`,
      });
      continue;
    }

    // —— 依赖检查 ——
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        violations.push({
          code: "SELF_DEPENDENCY",
          taskId: task.id,
          message: `任务「${task.id}」依赖了自己，请去掉这个依赖`,
        });
        continue;
      }
      const depPosition = positionById.get(dep);
      if (depPosition === undefined) {
        violations.push({
          code: "INVALID_DEPENDENCY",
          taskId: task.id,
          message: `任务「${task.id}」依赖了计划里不存在的任务「${dep}」，请只在 dependsOn 里引用本计划中已定义的任务 id`,
        });
        continue;
      }
      if (depPosition > index) {
        violations.push({
          code: "DEPENDENCY_NOT_PRIOR",
          taskId: task.id,
          message: `任务「${task.id}」依赖了排在它后面的任务「${dep}」，请把前置任务提到前面（计划的展示顺序就是执行顺序）`,
        });
      }
    }

    // —— 商品检查 ——
    if (task.productId === null) {
      if (AGENTS_REQUIRING_PRODUCT.has(task.agent)) {
        violations.push({
          code: "MISSING_PRODUCT",
          taskId: task.id,
          message: `任务「${task.id}」由${agentLabel(task.agent)}执行，必须指定 productId（只能取自给出的可选商品 id）`,
        });
      }
    } else if (!availableProducts.has(task.productId)) {
      violations.push({
        code: "UNKNOWN_PRODUCT",
        taskId: task.id,
        message: `任务「${task.id}」引用了不存在的商品 id「${task.productId}」，productId 只能取自给出的可选商品清单`,
      });
    }

    // —— 内容槽位检查 ——
    if (task.agent === "content_agent") {
      if (!task.platform || !task.format) {
        violations.push({
          code: "MISSING_CONTENT_TARGET",
          taskId: task.id,
          message: `内容任务「${task.id}」缺少平台或形态，必须同时给出 platform（${CONTENT_PLATFORMS.join(" / ")}）与 format（${CONTENT_FORMATS.join(" / ")}）`,
        });
      }
    }
  }

  const presentAgents = new Set(tasks.map((task) => task.agent));
  const missingAgents = (context.requiredAgents ?? []).filter(
    (agent) => !presentAgents.has(agent),
  );
  if (missingAgents.length > 0) {
    violations.push({
      code: "MISSING_REQUIRED_AGENT",
      message: `六岗位全链路缺少：${missingAgents.map((agent) => PLANNER_AGENT_LABEL[agent]).join("、")}。已有成果也要列入计划，执行时再标记为复用。`,
    });
  }

  violations.push(...findCycles(tasks, new Set(positionById.keys())));

  return { ok: violations.length === 0, violations };
}

/** 违规清单 → 给模型看的纠正提示（保持简短，避免把提示词撑爆） */
export function formatPlanViolations(
  violations: readonly PlanViolation[],
): string[] {
  return violations.map((violation) =>
    violation.taskId
      ? `[${violation.code}] ${violation.message}`
      : `[${violation.code}] ${violation.message}`,
  );
}
