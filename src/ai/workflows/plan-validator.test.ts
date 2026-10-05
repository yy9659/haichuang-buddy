/**
 * 经营计划校验器单测
 *
 * 校验器是**语义规则**的唯一出口（形状规则归 Zod，见 `schemas/business-plan.test.ts`）。
 * 这组测试按违规码逐条覆盖 —— 因为每一个码都对应提示词里的一条约束，
 * 将来改提示词时，靠这些用例才能确认「约束真的还在生效」。
 *
 * 另外刻意测了「从 jsonb 读回的脏计划」这条路：类型断言进来的对象**不受 Schema 保护**
 * （库里可能留着旧版本写入的计划），所以校验器必须按「运行时值可能不符合类型」来写。
 */

import { describe, expect, it } from "vitest";

import {
  MAX_PLAN_TASKS,
  PLANNER_AGENT_WHITELIST,
  type BusinessPlanDraft,
  type BusinessPlanTaskDraft,
} from "@/ai/schemas/business-plan";

import { formatPlanViolations, validateBusinessPlan } from "./plan-validator";

function task(
  overrides: Partial<BusinessPlanTaskDraft> = {},
): BusinessPlanTaskDraft {
  return {
    id: "task-1",
    agent: "product_agent",
    title: "分析「连江鲜活鲍鱼」",
    reason: "该商品尚无商品理解。",
    dependsOn: [],
    productId: "prod_001",
    platform: null,
    format: null,
    ...overrides,
  };
}

function plan(tasks: BusinessPlanTaskDraft[]): BusinessPlanDraft {
  return { goal: "把鲍鱼的内容做起来", summary: "先分析再产出内容。", tasks, confidence: 0.6 };
}

/** 本次可用的商品（相当于规划开始时的快照） */
const CONTEXT = { availableProductIds: ["prod_001", "prod_002"] };

function codes(tasks: BusinessPlanTaskDraft[]): string[] {
  return validateBusinessPlan(plan(tasks), CONTEXT).violations.map(
    (violation) => violation.code,
  );
}

describe("validateBusinessPlan：合法计划", () => {
  it("三步的线性依赖可以通过", () => {
    const result = validateBusinessPlan(
      plan([
        task({ id: "task-1" }),
        task({
          id: "task-2",
          agent: "content_agent",
          dependsOn: ["task-1"],
          platform: "douyin",
          format: "short-video",
        }),
      ]),
      CONTEXT,
    );
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("品牌任务可以不绑商品（品牌档案是全店一份，不必来自某件商品）", () => {
    const result = validateBusinessPlan(
      plan([task({ agent: "brand_agent", productId: null })]),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateBusinessPlan：逐条违规", () => {
  it("全链路模式缺少岗位时拒绝计划，普通模式不受影响", () => {
    const draft = plan([task()]);
    expect(validateBusinessPlan(draft, CONTEXT).ok).toBe(true);
    const checked = validateBusinessPlan(draft, {
      ...CONTEXT,
      requiredAgents: PLANNER_AGENT_WHITELIST,
    });
    expect(checked.violations.map((item) => item.code)).toContain("MISSING_REQUIRED_AGENT");
    expect(checked.violations.find((item) => item.code === "MISSING_REQUIRED_AGENT")?.message)
      .toContain("经营分析师");
  });

  it("EMPTY_PLAN：计划里一个任务都没有", () => {
    expect(codes([])).toEqual(["EMPTY_PLAN"]);
  });

  it(`TOO_MANY_TASKS：超过 ${MAX_PLAN_TASKS} 个任务`, () => {
    const tasks = Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, index) =>
      task({ id: `task-${index + 1}` }),
    );
    expect(codes(tasks)).toContain("TOO_MANY_TASKS");
  });

  it("DUPLICATE_TASK_ID：同一个 id 出现两次", () => {
    expect(codes([task({ id: "task-1" }), task({ id: "task-1" })])).toContain(
      "DUPLICATE_TASK_ID",
    );
  });

  it("UNKNOWN_AGENT：白名单外的 Agent（只可能来自读回的脏计划）", () => {
    const dirty = { ...task(), agent: "unknown_agent" } as unknown as BusinessPlanTaskDraft;
    const result = validateBusinessPlan(plan([dirty]), CONTEXT);
    expect(result.violations.map((item) => item.code)).toContain("UNKNOWN_AGENT");
  });

  it("SELF_DEPENDENCY：任务依赖自己", () => {
    expect(codes([task({ id: "task-1", dependsOn: ["task-1"] })])).toContain(
      "SELF_DEPENDENCY",
    );
  });

  it("INVALID_DEPENDENCY：依赖了计划里不存在的任务", () => {
    expect(codes([task({ dependsOn: ["task-9"] })])).toContain(
      "INVALID_DEPENDENCY",
    );
  });

  it("DEPENDENCY_NOT_PRIOR：依赖排在后面的任务（展示顺序就是执行顺序）", () => {
    const result = validateBusinessPlan(
      plan([
        task({ id: "task-1", dependsOn: ["task-2"] }),
        task({ id: "task-2", productId: "prod_002" }),
      ]),
      CONTEXT,
    );
    expect(result.violations.map((item) => item.code)).toContain(
      "DEPENDENCY_NOT_PRIOR",
    );
  });

  it("CIRCULAR_DEPENDENCY：两个任务互相依赖，且报出环的路径", () => {
    const result = validateBusinessPlan(
      plan([
        task({ id: "task-1", dependsOn: ["task-2"] }),
        task({ id: "task-2", productId: "prod_002", dependsOn: ["task-1"] }),
      ]),
      CONTEXT,
    );
    const circular = result.violations.find(
      (violation) => violation.code === "CIRCULAR_DEPENDENCY",
    );
    expect(circular).toBeDefined();
    // 环的完整路径是排查与纠错时最有用的信息
    expect(circular?.message).toContain("→");
    expect(result.ok).toBe(false);
  });

  it("UNKNOWN_PRODUCT：引用了清单以外的商品 id", () => {
    expect(codes([task({ productId: "prod_999" })])).toContain("UNKNOWN_PRODUCT");
  });

  it("MISSING_PRODUCT：商品类任务（分析 / 内容）必须指定商品", () => {
    expect(codes([task({ productId: null })])).toContain("MISSING_PRODUCT");
    expect(
      codes([
        task({
          agent: "content_agent",
          productId: null,
          platform: "douyin",
          format: "short-video",
        }),
      ]),
    ).toContain("MISSING_PRODUCT");
  });

  it("MISSING_CONTENT_TARGET：内容任务必须同时给出平台与形态", () => {
    expect(
      codes([
        task({ agent: "content_agent", platform: null, format: null }),
      ]),
    ).toContain("MISSING_CONTENT_TARGET");
    // 只给一半也不行
    expect(
      codes([
        task({ agent: "content_agent", platform: "douyin", format: null }),
      ]),
    ).toContain("MISSING_CONTENT_TARGET");
  });

  it("同一批违规会一起报出来（让模型一次改完，而不是来回好几轮）", () => {
    const result = codes([
      task({ id: "task-1", productId: null, dependsOn: ["task-9"] }),
    ]);
    expect(result).toContain("MISSING_PRODUCT");
    expect(result).toContain("INVALID_DEPENDENCY");
  });
});

describe("formatPlanViolations", () => {
  it("每条都带上违规码，模型照着改时能对上号", () => {
    const lines = formatPlanViolations([
      { code: "MISSING_PRODUCT", taskId: "task-1", message: "缺少商品" },
    ]);
    expect(lines).toEqual(["[MISSING_PRODUCT] 缺少商品"]);
  });
});
