/**
 * 经营工作流状态机单测（runBusinessWorkflow）
 *
 * 本模块回答「这一轮整体算什么状态」，因此测试核心是**状态流转与落库参数**：
 * markRunning 必须最先发生（界面的「运行中」与防重复启动都靠它）、
 * 三种收尾各走哪个 mark 方法、成环时工作流记录是否被如实标为失败。
 * 仓储能力从参数注入 —— 用一个假仓储即可覆盖，不需要连库。
 */

import { describe, expect, it } from "vitest";

import type { BusinessPlanDraft, BusinessPlanTaskDraft } from "@/ai/schemas/business-plan";
import type { AgentWorkflowRecord, AgentWorkflowSummary } from "@/repositories/types";

import { runBusinessWorkflow } from "./business-workflow";
import type { WorkflowTaskRunner } from "./executor";
import type { BusinessStateSnapshot } from "./reuse-resolver";

function planTask(overrides: Partial<BusinessPlanTaskDraft> = {}): BusinessPlanTaskDraft {
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

const EMPTY_STATE: BusinessStateSnapshot = {
  productsWithDna: new Set<string>(),
  hasBrandProfile: false,
  contentSlotKeys: new Set<string>(),
};

const okRunner: WorkflowTaskRunner = async () => ({ ok: true, outputRef: "ref-1" });

/**
 * 假仓储：只实现状态流转需要的四个方法，把每次调用记进 log，
 * 让测试能断言「调了哪个方法、带着什么参数」。
 */
function createFakeStore() {
  const calls: { method: string; args: unknown[] }[] = [];
  let record: AgentWorkflowRecord = {
    id: "wf_test",
    businessId: "biz_001",
    goal: "把鲍鱼的内容做起来",
    status: "idle",
    plan: null,
    summary: null,
    errorMessage: null,
    createdAt: "2026-09-25 10:00",
    completedAt: null,
  };

  function patch(next: Partial<AgentWorkflowRecord>): AgentWorkflowRecord {
    record = { ...record, ...next };
    return record;
  }

  return {
    calls,
    get record() {
      return record;
    },
    async markRunning(id: string) {
      calls.push({ method: "markRunning", args: [id] });
      return patch({ status: "running", summary: null, errorMessage: null });
    },
    async markCompleted(id: string, summary: AgentWorkflowSummary) {
      calls.push({ method: "markCompleted", args: [id, summary] });
      return patch({ status: "completed", summary, errorMessage: null, completedAt: "2026-09-25 10:05" });
    },
    async markPartiallyCompleted(
      id: string,
      params: { summary: AgentWorkflowSummary; errorMessage?: string | null },
    ) {
      calls.push({ method: "markPartiallyCompleted", args: [id, params] });
      return patch({
        status: "partially_completed",
        summary: params.summary,
        errorMessage: params.errorMessage ?? null,
        completedAt: "2026-09-25 10:05",
      });
    },
    async markFailed(
      id: string,
      params: { errorMessage: string; summary?: AgentWorkflowSummary | null },
    ) {
      calls.push({ method: "markFailed", args: [id, params] });
      return patch({
        status: "failed",
        errorMessage: params.errorMessage,
        ...(params.summary === undefined ? {} : { summary: params.summary }),
        completedAt: "2026-09-25 10:05",
      });
    },
  };
}

async function run(params: {
  plan: BusinessPlanDraft;
  runner?: WorkflowTaskRunner;
  state?: BusinessStateSnapshot;
}) {
  const store = createFakeStore();
  const result = await runBusinessWorkflow({
    workflowId: "wf_test",
    plan: params.plan,
    state: params.state ?? EMPTY_STATE,
    agentWorkflows: store,
    runner: params.runner ?? okRunner,
  });
  return { store, result };
}

describe("runBusinessWorkflow：状态流转顺序", () => {
  it("markRunning 最先发生 —— 界面要立刻看到「这一轮开始了」", async () => {
    const { store, result } = await run({ plan: plan([planTask()]) });
    expect(result.ok).toBe(true);
    expect(store.calls[0]?.method).toBe("markRunning");
    expect(store.calls[0]?.args[0]).toBe("wf_test");
  });
});

describe("runBusinessWorkflow：三种收尾", () => {
  it("全部成功 → markCompleted，summary 带逐步报告", async () => {
    const { store, result } = await run({
      plan: plan([
        planTask({ id: "task-1" }),
        planTask({ id: "task-2", productId: "prod_002" }),
      ]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.status).toBe("completed");
    expect(store.record.status).toBe("completed");

    const completedCall = store.calls.find((call) => call.method === "markCompleted");
    expect(completedCall).toBeDefined();
    const summary = completedCall?.args[1] as AgentWorkflowSummary;
    expect(summary.totalTasks).toBe(2);
    expect(summary.executed).toBe(2);
    // 逐步报告：顺利跑完的一步 note 为 null，但必须有这条记录
    expect(summary.steps).toHaveLength(2);
    expect(summary.steps?.[0]).toMatchObject({ taskId: "task-1", outcome: "executed", note: null });
  });

  it("复用的步骤写进 summary.steps 的 note（它们没有 agent_tasks 记录，全靠这份报告）", async () => {
    const { store, result } = await run({
      plan: plan([planTask({ id: "task-1" })]),
      state: {
        ...EMPTY_STATE,
        productsWithDna: new Set(["prod_001"]),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.summary.reused).toBe(1);
    const summary = (store.calls.find((c) => c.method === "markCompleted")?.args[1] ??
      {}) as AgentWorkflowSummary;
    expect(summary.steps?.[0]?.note).toContain("商品理解");
    expect(summary.steps?.[0]?.outcome).toBe("reused");
  });

  it("有成功也有失败 → markPartiallyCompleted，errorMessage 如实落库", async () => {
    const runner: WorkflowTaskRunner = async (request) =>
      request.task.id === "task-1"
        ? { ok: false, errorMessage: "模型服务暂时不可用" }
        : { ok: true };

    const { store, result } = await run({
      plan: plan([
        planTask({ id: "task-1" }),
        planTask({ id: "task-2", productId: "prod_002" }),
      ]),
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.status).toBe("partially_completed");
    expect(store.record.status).toBe("partially_completed");

    const partialCall = store.calls.find((call) => call.method === "markPartiallyCompleted");
    expect(partialCall).toBeDefined();
    const params = partialCall?.args[1] as { errorMessage?: string | null };
    expect(params.errorMessage).toContain("1 个任务失败");
  });

  it("一个都没成 → markFailed", async () => {
    const runner: WorkflowTaskRunner = async () => ({
      ok: false,
      errorMessage: "模型服务暂时不可用",
    });

    const { store, result } = await run({
      plan: plan([planTask({ id: "task-1" })]),
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.status).toBe("failed");
    expect(store.record.status).toBe("failed");

    const failedCall = store.calls.find((call) => call.method === "markFailed");
    expect(failedCall).toBeDefined();
    const params = failedCall?.args[1] as { errorMessage: string; summary?: AgentWorkflowSummary };
    // 工作流级文案是「概览」：几个任务失败、分别是谁，而不是某一次调用的原始报错
    expect(params.errorMessage).toContain("1 个任务失败");
    // 失败轮也要有 summary：哪几步没成要留在库里
    expect(params.summary?.failed).toBe(1);
    /**
     * runner 给的原始失败原因不能丢 —— 复用/跳过的步骤没有 agent_tasks 记录，
     * 商家要追问「到底为什么失败」只能靠这份逐步报告里的 note。
     */
    expect(params.summary?.steps?.[0]?.note).toContain("模型服务暂时不可用");
  });
});

describe("runBusinessWorkflow：计划本身不能执行", () => {
  it("成环 → 工作流记录被标为 failed，Result 失败（PLAN_INVALID）", async () => {
    const { store, result } = await run({
      plan: plan([
        planTask({ id: "task-1", dependsOn: ["task-2"] }),
        planTask({ id: "task-2", dependsOn: ["task-1"], productId: "prod_002" }),
      ]),
    });

    // 编排层失败：界面上的工作流记录也不会是终态，必须让调用方知道
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("PLAN_INVALID");
    expect(store.record.status).toBe("failed");
    expect(store.record.errorMessage).toContain("循环依赖");
    // 失败原因必须落库，否则历史里只剩一条看不懂的 failed
    const failedCall = store.calls.find((call) => call.method === "markFailed");
    expect(failedCall).toBeDefined();
  });
});
