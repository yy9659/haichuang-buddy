/**
 * 复用判定单测
 *
 * 这一层是「即使模型排出一份不合理的计划也不浪费钱」的兜底，
 * 因此测试重点是把六 Agent 的判定规则钉死：商品看 DNA、品牌看档案、内容看槽位；
 * 客服 / 直播 / 分析首次必须执行，但同一工作流重试时复用上一轮已完成步骤。
 * 本模块是纯函数，构造快照即可覆盖全部分支，不需要起服务或连库。
 */

import { describe, expect, it } from "vitest";

import type { BusinessPlanTaskDraft } from "@/ai/schemas/business-plan";
import { toContentSlotKey } from "@/repositories/content-item";

import {
  resolveReusableTasks,
  toTaskContentSlot,
  type BusinessStateSnapshot,
} from "./reuse-resolver";

function task(overrides: Partial<BusinessPlanTaskDraft> = {}): BusinessPlanTaskDraft {
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

/** 构造一个内容槽位键集合 */
function slotKeys(slots: { productId: string; platform: string; format: string }[]) {
  return new Set(
    slots.map((slot) =>
      toContentSlotKey({
        productId: slot.productId,
        platform: slot.platform as never,
        format: slot.format as never,
      }),
    ),
  );
}

const EMPTY_STATE: BusinessStateSnapshot = {
  productsWithDna: new Set<string>(),
  hasBrandProfile: false,
  contentSlotKeys: new Set<string>(),
};

describe("toTaskContentSlot", () => {
  it("内容任务带全三个槽位参数时解出槽位", () => {
    const slot = toTaskContentSlot(
      task({
        agent: "content_agent",
        platform: "douyin",
        format: "short-video",
      }),
    );
    expect(slot).toEqual({
      productId: "prod_001",
      platform: "douyin",
      format: "short-video",
    });
  });

  it("非内容任务解不出槽位（哪怕带着平台参数）", () => {
    expect(
      toTaskContentSlot(task({ platform: "douyin", format: "short-video" })),
    ).toBeNull();
  });

  it("内容任务缺任一槽位参数解不出槽位", () => {
    expect(
      toTaskContentSlot(task({ agent: "content_agent", platform: null, format: "article" })),
    ).toBeNull();
    expect(
      toTaskContentSlot(
        task({ agent: "content_agent", platform: "douyin", format: null, productId: null }),
      ),
    ).toBeNull();
  });
});

describe("resolveReusableTasks：商品理解", () => {
  it("该商品已有 DNA → 复用，说明文案面向商家", () => {
    const decisions = resolveReusableTasks([task()], {
      ...EMPTY_STATE,
      productsWithDna: new Set(["prod_001"]),
    });
    expect(decisions.get("task-1")).toBeDefined();
    expect(decisions.get("task-1")?.reason).toContain("商品理解");
  });

  it("该商品没有 DNA → 不复用", () => {
    const decisions = resolveReusableTasks(
      [task({ productId: "prod_002" })],
      { ...EMPTY_STATE, productsWithDna: new Set(["prod_001"]) },
    );
    expect(decisions.size).toBe(0);
  });

  it("商品类任务没写 productId → 不复用（无从判定，交给校验器去拦）", () => {
    const decisions = resolveReusableTasks([task({ productId: null })], {
      ...EMPTY_STATE,
      productsWithDna: new Set(["prod_001"]),
    });
    expect(decisions.size).toBe(0);
  });
});

describe("resolveReusableTasks：品牌档案", () => {
  it("已有档案 → 复用（全店唯一，与具体商品无关）", () => {
    const decisions = resolveReusableTasks(
      [task({ agent: "brand_agent", productId: null })],
      { ...EMPTY_STATE, hasBrandProfile: true },
    );
    expect(decisions.get("task-1")?.reason).toContain("品牌档案");
  });

  it("尚无档案 → 不复用", () => {
    const decisions = resolveReusableTasks([task({ agent: "brand_agent" })], EMPTY_STATE);
    expect(decisions.size).toBe(0);
  });
});

describe("resolveReusableTasks：内容资产", () => {
  it("该「商品 × 平台 × 形态」槽位已有内容 → 复用", () => {
    const decisions = resolveReusableTasks(
      [
        task({
          id: "content-douyin",
          agent: "content_agent",
          platform: "douyin",
          format: "short-video",
        }),
      ],
      {
        ...EMPTY_STATE,
        contentSlotKeys: slotKeys([{ productId: "prod_001", platform: "douyin", format: "short-video" }]),
      },
    );
    expect(decisions.get("content-douyin")?.reason).toContain("内容");
  });

  it("同一商品的另一个平台没有内容 → 不复用（槽位级判定，不是商品级）", () => {
    const decisions = resolveReusableTasks(
      [
        task({
          id: "content-xhs",
          agent: "content_agent",
          platform: "xiaohongshu",
          format: "article",
        }),
      ],
      {
        ...EMPTY_STATE,
        contentSlotKeys: slotKeys([{ productId: "prod_001", platform: "douyin", format: "short-video" }]),
      },
    );
    expect(decisions.size).toBe(0);
  });

  it("同一槽位的另一形态没有内容 → 不复用（形态也是槽位的一部分）", () => {
    const decisions = resolveReusableTasks(
      [
        task({
          id: "content-article",
          agent: "content_agent",
          platform: "douyin",
          format: "article",
        }),
      ],
      {
        ...EMPTY_STATE,
        contentSlotKeys: slotKeys([{ productId: "prod_001", platform: "douyin", format: "short-video" }]),
      },
    );
    expect(decisions.size).toBe(0);
  });
});

describe("resolveReusableTasks：混合计划", () => {
  it("客服 / 直播 / 分析首次不复用，重试时按 completedTaskIds 精确复用", () => {
    const tasks = [
      task({ id: "customer", agent: "customer_service_agent" }),
      task({ id: "live", agent: "live_agent" }),
      task({ id: "analytics", agent: "analytics_agent", productId: null }),
    ];

    expect(resolveReusableTasks(tasks, EMPTY_STATE).size).toBe(0);
    const retried = resolveReusableTasks(tasks, {
      ...EMPTY_STATE,
      completedTaskIds: new Set(["customer", "analytics"]),
    });
    expect([...retried.keys()]).toEqual(["customer", "analytics"]);
    expect(retried.get("customer")?.reason).toContain("上一轮已经完成");
  });

  it("只有命中规则的任务进入结论，其余照常执行", () => {
    const decisions = resolveReusableTasks(
      [
        task({ id: "dna-old", productId: "prod_001" }),
        task({ id: "dna-new", productId: "prod_002" }),
        task({ id: "brand", agent: "brand_agent", productId: null }),
        task({
          id: "content",
          agent: "content_agent",
          platform: "douyin",
          format: "short-video",
        }),
      ],
      {
        productsWithDna: new Set(["prod_001"]),
        hasBrandProfile: true,
        contentSlotKeys: slotKeys([{ productId: "prod_001", platform: "douyin", format: "short-video" }]),
      },
    );

    // 4 个任务里 3 个可复用，只有「新商品的分析」真的要跑
    expect([...decisions.keys()].sort()).toEqual(["brand", "content", "dna-old"]);
  });

  it("空状态下一个都不复用", () => {
    const decisions = resolveReusableTasks(
      [
        task({ id: "dna" }),
        task({ id: "brand", agent: "brand_agent", productId: null }),
        task({ id: "content", agent: "content_agent", platform: "douyin", format: "short-video" }),
      ],
      EMPTY_STATE,
    );
    expect(decisions.size).toBe(0);
  });
});
