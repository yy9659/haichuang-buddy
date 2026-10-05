/**
 * Agent 任务记录的共享规则与 Mock 仓储契约
 *
 * 为什么单独测这一层：
 * `agent_tasks` 的状态流转规则（终态补 completedAt、进度夹取）被 Mock 与数据库
 * **两套实现共用**。规则写歪了，两种数据源就会给出不同结果，而这种差异
 * 通常要等到切到真实数据库才暴露。因此把规则本身当纯函数测透，
 * 再用一份契约测试保证 Mock 实现不走样。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { formatDateTime } from "@/lib/datetime";
import { AppError } from "@/lib/result";

import { applyAgentTaskPatch, clampTaskProgress, nextCompletedAt } from "./agent-task";
import { createMockAgentTaskRepository } from "./mock/agent-tasks";
import { createMockProductRepository } from "./mock/products";
import { clearStoredAgentTasks } from "./mock/store";
import type { AgentTaskRecord } from "./types";

const agentTasks = createMockAgentTaskRepository();
const products = createMockProductRepository();

beforeEach(() => {
  clearStoredAgentTasks();
});

/* ------------------------------------------------------------------ */
/* 纯规则                                                              */
/* ------------------------------------------------------------------ */

describe("clampTaskProgress", () => {
  it("夹取到 0 ~ 100 并取整", () => {
    expect(clampTaskProgress(undefined)).toBe(0);
    expect(clampTaskProgress(Number.NaN)).toBe(0);
    expect(clampTaskProgress(-10)).toBe(0);
    expect(clampTaskProgress(0)).toBe(0);
    expect(clampTaskProgress(42.6)).toBe(43);
    expect(clampTaskProgress(100)).toBe(100);
    expect(clampTaskProgress(999)).toBe(100);
  });
});

describe("nextCompletedAt", () => {
  const now = new Date("2026-09-25T19:20:00.000Z");

  it("非终态一律返回 null（重新跑时清空完成时间）", () => {
    expect(
      nextCompletedAt({ status: "running", currentCompletedAt: now, now }),
    ).toBeNull();
    expect(
      nextCompletedAt({ status: "queued", currentCompletedAt: null, now }),
    ).toBeNull();
  });

  it("首次进入终态用 now，且返回 Date（保住数据库的时间精度）", () => {
    const result = nextCompletedAt({
      status: "completed",
      currentCompletedAt: null,
      now,
    });
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(now.getTime());
  });

  it("已有完成时间时保留首次值，不被后续 patch 覆盖", () => {
    const first = new Date("2026-09-25T19:00:00.000Z");
    const result = nextCompletedAt({
      status: "failed",
      currentCompletedAt: first,
      now,
    });
    expect(result?.getTime()).toBe(first.getTime());
  });

  it("已有完成时间是脏值时回退到 now，而不是抛错", () => {
    const result = nextCompletedAt({
      status: "completed",
      currentCompletedAt: "不是一个时间",
      now,
    });
    expect(result?.getTime()).toBe(now.getTime());
  });
});

describe("applyAgentTaskPatch", () => {
  const now = new Date("2026-09-25T19:20:00.000Z");

  function record(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
    return {
      id: "task_001",
      agentType: "product_agent",
      title: "分析商品：连江鲜活鲍鱼",
      status: "running",
      progress: 10,
      productId: "prod_001",
      workflowId: null,
      input: { productId: "prod_001" },
      output: null,
      errorMessage: null,
      durationMs: null,
      createdAt: "2026-09-25 19:19",
      completedAt: null,
      ...overrides,
    };
  }

  it("只改传入的字段，未传字段保持原值", () => {
    const current = record({
      output: { providerId: "mock" },
      errorMessage: "旧的错误",
    });

    const next = applyAgentTaskPatch(current, { status: "running" }, now);

    expect(next.status).toBe("running");
    expect(next.progress).toBe(10);
    expect(next.output).toEqual({ providerId: "mock" });
    expect(next.errorMessage).toBe("旧的错误");
    // 非终态没有「本次耗时」可言（详见下面专门的重跑用例）
    expect(next.durationMs).toBeNull();
  });

  it("进入终态时补上 completedAt，并写入耗时与输出", () => {
    const next = applyAgentTaskPatch(
      record(),
      { status: "completed", progress: 100, durationMs: 1234, output: { ok: true } },
      now,
    );

    expect(next.status).toBe("completed");
    expect(next.progress).toBe(100);
    expect(next.durationMs).toBe(1234);
    expect(next.output).toEqual({ ok: true });
    expect(next.completedAt).toBe(formatDateTime(now));
  });

  it("失败同样算终态", () => {
    const next = applyAgentTaskPatch(
      record(),
      { status: "failed", errorMessage: "模型服务暂时不可用" },
      now,
    );
    expect(next.completedAt).not.toBeNull();
    expect(next.errorMessage).toBe("模型服务暂时不可用");
  });

  it("从终态回到运行中会清空 completedAt（任务被重跑）", () => {
    const finished = record({
      status: "completed",
      completedAt: "2026-09-25 19:15",
      durationMs: 800,
    });
    const next = applyAgentTaskPatch(finished, { status: "running" }, now);

    expect(next.status).toBe("running");
    expect(next.completedAt).toBeNull();
    // 耗时描述的是「刚结束的那一次运行」，重跑时应当清掉，否则界面会显示一个陈旧数字
    expect(next.durationMs).toBeNull();
  });

  it("终态下未传耗时时保留原值（收口只需要写状态）", () => {
    const finished = record({
      status: "completed",
      completedAt: "2026-09-25 19:15",
      durationMs: 800,
    });
    const next = applyAgentTaskPatch(finished, { progress: 100 }, now);
    expect(next.durationMs).toBe(800);
  });

  it("不修改传入的记录（避免仓储共享对象被就地改坏）", () => {
    const current = record();
    const snapshot = { ...current };
    applyAgentTaskPatch(current, { status: "completed", progress: 100 }, now);
    expect(current).toEqual(snapshot);
  });

  it("进度越界时被夹取", () => {
    const next = applyAgentTaskPatch(record(), { progress: 500 }, now);
    expect(next.progress).toBe(100);
  });
});

/* ------------------------------------------------------------------ */
/* Mock 仓储契约                                                       */
/* ------------------------------------------------------------------ */

describe("Mock AgentTask 仓储契约", () => {
  async function createTask(overrides: Partial<{ productId: string }> = {}) {
    return agentTasks.create({
      agentType: "product_agent",
      title: "分析商品：连江鲜活鲍鱼",
      productId: overrides.productId ?? "prod_001",
      input: { hasImage: false },
    });
  }

  it("新建任务的默认值：queued / 进度 0 / 无输出 / 无完成时间", async () => {
    const task = await createTask();

    expect(task.id.startsWith("task_")).toBe(true);
    expect(task.status).toBe("queued");
    expect(task.progress).toBe(0);
    expect(task.output).toBeNull();
    expect(task.completedAt).toBeNull();
    expect(task.durationMs).toBeNull();
    expect(task.errorMessage).toBeNull();
    expect(task.workflowId).toBeNull();
    expect(task.createdAt).not.toBe("");
    expect(task.input).toEqual({ hasImage: false });
  });

  it("更新不存在的任务抛 NOT_FOUND", async () => {
    await expect(
      agentTasks.update("task_missing", { status: "completed" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("完成任务后 completedAt 与 durationMs 落库", async () => {
    const task = await createTask();
    const done = await agentTasks.update(task.id, {
      status: "completed",
      progress: 100,
      durationMs: 980,
      output: { providerId: "mock", attempts: 1 },
    });

    expect(done.status).toBe("completed");
    expect(done.completedAt).not.toBeNull();
    expect(done.durationMs).toBe(980);
    expect(done.output).toEqual({ providerId: "mock", attempts: 1 });
  });

  it("重复 patch 终态时保留首次完成时间", async () => {
    const task = await createTask();
    const first = await agentTasks.update(task.id, { status: "completed" });
    const second = await agentTasks.update(task.id, { progress: 100 });

    expect(second.completedAt).toBe(first.completedAt);
  });

  it("findLatestByProduct 返回最近一条，且按 agentType 过滤", async () => {
    const older = await createTask();
    await agentTasks.update(older.id, { status: "completed" });
    const newer = await createTask();

    const latest = await agentTasks.findLatestByProduct("prod_001", "product_agent");
    expect(latest?.id).toBe(newer.id);

    // 换一个 agent 类型就查不到，避免把别的 Agent 的任务误当成自己的
    expect(await agentTasks.findLatestByProduct("prod_001", "content_agent")).toBeNull();
    // 换一个商品也查不到
    expect(await agentTasks.findLatestByProduct("prod_002", "product_agent")).toBeNull();
  });

  it("listByProduct 按时间倒序并支持 limit", async () => {
    const first = await createTask();
    const second = await createTask();
    const third = await createTask();

    const all = await agentTasks.listByProduct("prod_001", "product_agent");
    expect(all.map((task) => task.id)).toEqual([third.id, second.id, first.id]);

    const limited = await agentTasks.listByProduct("prod_001", "product_agent", 2);
    expect(limited.map((task) => task.id)).toEqual([third.id, second.id]);
  });

  it("商品被删除时任务随之清理（对齐数据库的 ON DELETE CASCADE）", async () => {
    const product = await createMockProductRepository().create({
      name: "连江测试用海带苗",
      category: "海产品",
      price: 12,
    });

    await agentTasks.create({
      agentType: "product_agent",
      title: `分析商品：${product.name}`,
      productId: product.id,
    });
    expect(
      await agentTasks.findLatestByProduct(product.id, "product_agent"),
    ).not.toBeNull();

    await products.delete(product.id);

    expect(
      await agentTasks.findLatestByProduct(product.id, "product_agent"),
    ).toBeNull();
  });
});
