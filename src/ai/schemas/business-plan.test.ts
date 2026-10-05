/**
 * Business Plan 契约单测
 *
 * 这组测试只回答一个问题：**模型输出成什么样子会被接受、什么样子会被拒绝**。
 * 它刻意不碰任何「计划合不合理」的判断（依赖成环、引用了不存在的商品…）——
 * 那些是语义问题，由 `workflows/plan-validator` 负责，见对应的测试文件。
 * 把两层分开测，是为了让「到底是契约松了还是校验器漏了」一眼可辨。
 */

import { describe, expect, it } from "vitest";

import {
  BUSINESS_PLAN_AI_VERSION,
  BusinessPlanSchema,
  MAX_PLAN_TASKS,
  normalizeBusinessPlanDraft,
  normalizeTaskId,
  parseStoredBusinessPlan,
  toStoredBusinessPlan,
  type BusinessPlanDraft,
} from "./business-plan";

/** 一份最小可用的合法计划（后续用例在此基础上改坏） */
function validPlan(): Record<string, unknown> {
  return {
    goal: "把连江鲜活鲍鱼的内容做起来",
    summary: "先补齐商品理解，再产出抖音与小红书内容。",
    tasks: [
      {
        id: "task-1",
        agent: "product_agent",
        title: "分析「连江鲜活鲍鱼」生成商品理解",
        reason: "该商品尚无商品理解，先补齐卖点与目标人群。",
        dependsOn: [],
        productId: "prod_001",
        platform: null,
        format: null,
      },
      {
        id: "task-2",
        agent: "content_agent",
        title: "为「连江鲜活鲍鱼」生成抖音短视频脚本",
        reason: "先做抖音，用最低成本验证卖点是否讲得通。",
        dependsOn: ["task-1"],
        productId: "prod_001",
        platform: "douyin",
        format: "short-video",
      },
    ],
    confidence: 0.6,
  };
}

describe("BusinessPlanSchema：字段缺失与非法值严格", () => {
  it("合法计划可以通过", () => {
    const parsed = BusinessPlanSchema.safeParse(validPlan());
    expect(parsed.success).toBe(true);
  });

  for (const key of ["goal", "summary", "tasks"] as const) {
    it(`缺少 ${key} 时校验失败`, () => {
      const plan = validPlan();
      delete plan[key];
      expect(BusinessPlanSchema.safeParse(plan).success).toBe(false);
    });
  }

  it("缺少 confidence 时回落 0.5 而不是判失败（置信度是元信息，不该让整份计划作废）", () => {
    const plan = validPlan();
    delete plan.confidence;
    const parsed = BusinessPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.confidence).toBe(0.5);
    }
  });

  it("confidence 写成百分数（60）会被归一成 0.6", () => {
    const parsed = BusinessPlanSchema.safeParse({
      ...validPlan(),
      confidence: 60,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.confidence).toBeCloseTo(0.6, 5);
    }
  });

  it("计划里必须有任务（空计划无意义）", () => {
    const result = BusinessPlanSchema.safeParse({ ...validPlan(), tasks: [] });
    expect(result.success).toBe(false);
  });

  it(`任务数超过 ${MAX_PLAN_TASKS} 时校验失败`, () => {
    const tasks = Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, index) => ({
      id: `task-${index + 1}`,
      agent: "product_agent",
      title: "分析商品",
      reason: "因为需要",
      dependsOn: [],
      productId: "prod_001",
      platform: null,
      format: null,
    }));
    expect(BusinessPlanSchema.safeParse({ ...validPlan(), tasks }).success).toBe(
      false,
    );
  });

  it("白名单外的 Agent 会被契约层拦下（六 Agent 之外仍不允许越界）", () => {
    const plan = validPlan();
    const tasks = plan.tasks as Record<string, unknown>[];
    tasks[0] = { ...tasks[0], agent: "unknown_agent" };
    expect(BusinessPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("business_brain 自己不得写进计划（它是规划者，不是执行步骤）", () => {
    const plan = validPlan();
    const tasks = plan.tasks as Record<string, unknown>[];
    tasks[0] = { ...tasks[0], agent: "business_brain" };
    expect(BusinessPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("任务缺 title / reason 时校验失败", () => {
    for (const key of ["title", "reason"] as const) {
      const plan = validPlan();
      const tasks = plan.tasks as Record<string, unknown>[];
      const task = { ...tasks[0] };
      delete task[key];
      tasks[0] = task;
      expect(BusinessPlanSchema.safeParse(plan).success).toBe(false);
    }
  });

  it("任务 id 只允许 ASCII（它是依赖引用的键，全角/零宽字符会让引用判断不可靠）", () => {
    const plan = validPlan();
    const tasks = plan.tasks as Record<string, unknown>[];
    tasks[0] = { ...tasks[0], id: "任务一" };
    expect(BusinessPlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe("归一化：对格式宽容", () => {
  it("`task 1` 这种写法会被归一成 `task-1`", () => {
    expect(normalizeTaskId("task 1")).toBe("task-1");
    expect(normalizeTaskId('  "task-1" ')).toBe("task-1");
    expect(normalizeTaskId(123)).toBe(123);
  });

  it("dependsOn 省略或写成 null 时当作空数组（「没有前置」是正常语义）", () => {
    for (const value of [undefined, null]) {
      const plan = validPlan();
      const tasks = plan.tasks as Record<string, unknown>[];
      const task = { ...tasks[1] };
      if (value === undefined) {
        delete task.dependsOn;
      } else {
        task.dependsOn = null;
      }
      tasks[1] = task;
      const parsed = BusinessPlanSchema.safeParse(plan);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.tasks[1]?.dependsOn).toEqual([]);
      }
    }
  });

  it("dependsOn 写成顿号分隔的字符串也能读出来", () => {
    const plan = validPlan();
    const tasks = plan.tasks as Record<string, unknown>[];
    tasks[1] = { ...tasks[1], dependsOn: "task-1、task-2" };
    const parsed = BusinessPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tasks[1]?.dependsOn).toEqual(["task-1", "task-2"]);
    }
  });

  it("platform / format 的非法值退化成「未指定」交给校验器判定，而不是让契约失败", () => {
    const plan = validPlan();
    const tasks = plan.tasks as Record<string, unknown>[];
    tasks[1] = { ...tasks[1], platform: "weibo", format: "podcast" };
    const parsed = BusinessPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tasks[1]?.platform).toBeNull();
      expect(parsed.data.tasks[1]?.format).toBeNull();
    }
  });

  it("非内容任务残留的 platform / format 会被清掉（否则计划读起来自相矛盾）", () => {
    const draft = validPlan() as unknown as BusinessPlanDraft;
    const normalized = normalizeBusinessPlanDraft({
      ...draft,
      tasks: [
        {
          ...draft.tasks[0],
          platform: "douyin",
          format: "short-video",
        },
        ...draft.tasks.slice(1),
      ],
    } as BusinessPlanDraft);
    expect(normalized.tasks[0]?.platform).toBeNull();
    expect(normalized.tasks[0]?.format).toBeNull();
  });

  it("经营分析是全店任务，误填的 productId 会被清掉", () => {
    const draft = validPlan() as unknown as BusinessPlanDraft;
    const normalized = normalizeBusinessPlanDraft({
      ...draft,
      tasks: [
        {
          ...draft.tasks[0],
          agent: "analytics_agent",
          productId: "prod_001",
        },
      ],
    } as BusinessPlanDraft);
    expect(normalized.tasks[0]?.productId).toBeNull();
  });

  it("dependsOn 去重，但**保留**自引用与未知 id（那是模型没读懂任务的信号）", () => {
    const draft = validPlan() as unknown as BusinessPlanDraft;
    const normalized = normalizeBusinessPlanDraft({
      ...draft,
      tasks: [
        { ...draft.tasks[0], dependsOn: ["task-2", "task-2", "不存在的任务"] },
        draft.tasks[1],
      ],
    } as BusinessPlanDraft);
    expect(normalized.tasks[0]?.dependsOn).toEqual(["task-2", "不存在的任务"]);
  });

  it("任务顺序原样保留（模型给出的顺序就是它认为的优先级）", () => {
    const draft = validPlan() as unknown as BusinessPlanDraft;
    const reversed = normalizeBusinessPlanDraft({
      ...draft,
      tasks: [...draft.tasks].reverse(),
    } as BusinessPlanDraft);
    expect(reversed.tasks.map((task) => task.id)).toEqual(["task-2", "task-1"]);
  });
});

describe("落库与读回", () => {
  it("落库对象带版本号，且能原样读回", () => {
    const parsed = BusinessPlanSchema.parse(validPlan());
    const stored = toStoredBusinessPlan(parsed);
    expect(stored.version).toBe(BUSINESS_PLAN_AI_VERSION);

    const roundTripped = parseStoredBusinessPlan(
      JSON.parse(JSON.stringify(stored)),
    );
    expect(roundTripped).not.toBeNull();
    expect(roundTripped?.goal).toBe(parsed.goal);
    expect(roundTripped?.tasks).toEqual(parsed.tasks);
  });

  it("读不出来的内容返回 null 而不是抛错（界面要能如实说明，而不是整页 500）", () => {
    expect(parseStoredBusinessPlan(null)).toBeNull();
    expect(parseStoredBusinessPlan(undefined)).toBeNull();
    expect(parseStoredBusinessPlan({ goal: "只有目标" })).toBeNull();
    expect(parseStoredBusinessPlan("不是对象")).toBeNull();
  });
});
