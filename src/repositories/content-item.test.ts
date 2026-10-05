/**
 * 内容条目共享纯规则单测（S3-2 Task 7）
 *
 * 为什么这些规则值得单独测：Mock 与数据库两套仓储都调用它们，
 * 一旦算法漂移，就会出现「切到 db 后内容字段串位」这类最难查的问题 ——
 * 尤其是 `applyContentPatch` 里那两条不变量（槽位与 createdAt 不可改写），
 * 它们是「重新生成只覆盖内容、不会把一条内容变成另一条」的唯一保障。
 */

import { describe, expect, it } from "vitest";

import type { ContentItem } from "@/types";

import {
  EMPTY_CONTENT_METRICS,
  applyContentPatch,
  matchesContentSlot,
  toContentItem,
  toContentSlotKey,
} from "./content-item";
import type { NewContentInput } from "./types";

function baseInput(overrides: Partial<NewContentInput> = {}): NewContentInput {
  return {
    productId: "prod_001",
    productName: "连江鲜活鲍鱼",
    platform: "douyin",
    format: "short-video",
    title: "会做饭的人，家里都常备一盒鲍鱼",
    hook: "连江鲍鱼 128 就能买到 500g。",
    body: "刷洗干净上锅蒸 8 分钟就好。",
    cta: "点击下方商品，今晚就能安排。",
    hashtags: ["#连江鲍鱼"],
    visualSuggestions: ["开场用渔港晨雾航拍 2 秒"],
    shotList: ["0-2s 渔港晨景"],
    voiceover: "连江的鲍鱼，当天捞当天发。",
    status: "draft",
    riskNotes: [],
    aiVersion: "v1.0",
    confidence: 0.62,
    ...overrides,
  };
}

describe("toContentSlotKey / matchesContentSlot", () => {
  const item = toContentItem(baseInput(), {
    id: "content_001",
    createdAt: "2026-09-25 11:26",
    updatedAt: "2026-09-25 11:26",
  });

  it("槽位键由三列拼成，平台或形态不同即不同槽位", () => {
    expect(toContentSlotKey({ productId: "p", platform: "douyin", format: "article" })).toBe(
      "p::douyin::article",
    );
  });

  it("三列全等才算同一个槽位", () => {
    expect(
      matchesContentSlot(item, {
        productId: "prod_001",
        platform: "douyin",
        format: "short-video",
      }),
    ).toBe(true);
    expect(
      matchesContentSlot(item, {
        productId: "prod_001",
        platform: "xiaohongshu",
        format: "short-video",
      }),
    ).toBe(false);
    expect(
      matchesContentSlot(item, {
        productId: "prod_002",
        platform: "douyin",
        format: "short-video",
      }),
    ).toBe(false);
    expect(
      matchesContentSlot(item, {
        productId: "prod_001",
        platform: "douyin",
        format: "article",
      }),
    ).toBe(false);
  });
});

describe("toContentItem", () => {
  it("新生成的内容经营数据一律为 0（不伪造播放量）", () => {
    const item = toContentItem(baseInput(), {
      id: "content_001",
      createdAt: "2026-09-25 11:26",
      updatedAt: "2026-09-25 11:26",
    });

    expect(item.metrics).toEqual(EMPTY_CONTENT_METRICS);
    expect(item.metrics.views).toBe(0);
    expect(item.metrics.engagementRate).toBe(0);
  });

  it("列表字段是拷贝：后续改动入参不会改到已建好的内容", () => {
    const input = baseInput();
    const item = toContentItem(input, {
      id: "content_001",
      createdAt: "2026-09-25 11:26",
      updatedAt: "2026-09-25 11:26",
    });

    input.hashtags.push("#被追加的");
    input.shotList.push("被追加的镜头");

    expect(item.hashtags).toEqual(["#连江鲍鱼"]);
    expect(item.shotList).toEqual(["0-2s 渔港晨景"]);
  });

  it("createdAt 与 updatedAt 都由存储层给出（首次生成时两者相同）", () => {
    const item = toContentItem(baseInput(), {
      id: "content_001",
      createdAt: "2026-09-25 11:26",
      updatedAt: "2026-09-25 11:26",
    });
    expect(item.createdAt).toBe("2026-09-25 11:26");
    expect(item.updatedAt).toBe("2026-09-25 11:26");
  });
});

describe("applyContentPatch", () => {
  const current = toContentItem(baseInput(), {
    id: "content_001",
    createdAt: "2026-09-25 11:26",
    updatedAt: "2026-09-25 11:26",
  });

  it("只覆盖显式传入的字段，其余保持不变", () => {
    const next = applyContentPatch(
      current,
      { title: "新标题" },
      { updatedAt: "2026-09-25 12:00" },
    );

    expect(next.title).toBe("新标题");
    expect(next.hook).toBe(current.hook);
    expect(next.body).toBe(current.body);
    expect(next.platform).toBe(current.platform);
  });

  it("updatedAt 每次 patch 都会刷新（界面那句「生成于 xxx」才不会永远停在首次生成时间）", () => {
    const next = applyContentPatch(current, {}, { updatedAt: "2026-09-25 12:00" });
    expect(next.updatedAt).toBe("2026-09-25 12:00");
    expect(next.createdAt).toBe("2026-09-25 11:26");
  });

  it("槽位与 createdAt 永不被 patch 改写（槽位是内容的身份）", () => {
    // 即使调用方硬塞了槽位字段，patch 类型也不该放行；这里从运行时再确认一次
    const next = applyContentPatch(
      current,
      { productName: "改了名的商品快照" } as never,
      { updatedAt: "2026-09-25 12:00" },
    );

    expect(next.productId).toBe(current.productId);
    expect(next.platform).toBe(current.platform);
    expect(next.format).toBe(current.format);
    expect(next.createdAt).toBe(current.createdAt);
    // 商品名快照是可改的（商品改名后重新生成，署名应更新）
    expect(next.productName).toBe("改了名的商品快照");
  });

  it("列表字段是拷贝：patch 后再改入参数组不会污染结果", () => {
    const hashtags = ["#新标签"];
    const next = applyContentPatch(
      current,
      { hashtags },
      { updatedAt: "2026-09-25 12:00" },
    );

    hashtags.push("#被追加的");
    expect(next.hashtags).toEqual(["#新标签"]);
  });

  it("metrics 不可 patch（经营数据来自平台回流，不是让人手填的）", () => {
    const next = applyContentPatch(
      current,
      { metrics: { views: 999999 } } as never,
      { updatedAt: "2026-09-25 12:00" },
    );
    expect(next.metrics).toEqual(EMPTY_CONTENT_METRICS);
  });

  it("status 与元信息可 patch（商家确认内容后要落到 approved）", () => {
    const next = applyContentPatch(
      current,
      { status: "approved", confidence: 0.9, aiVersion: "v1.1" },
      { updatedAt: "2026-09-25 12:00" },
    );
    expect(next.status).toBe("approved");
    expect(next.confidence).toBe(0.9);
    expect(next.aiVersion).toBe("v1.1");
  });

  it("riskNotes 为 undefined 时保留原有风险提示（不会被静默清空）", () => {
    const withNotes: ContentItem = {
      ...current,
      riskNotes: ["疑似虚构产地：大连"],
    };
    const next = applyContentPatch(
      withNotes,
      { title: "新标题" },
      { updatedAt: "2026-09-25 12:00" },
    );
    expect(next.riskNotes).toEqual(["疑似虚构产地：大连"]);
  });

  it("riskNotes 显式传空数组时清空（重新生成后旧风险提示不该残留）", () => {
    const withNotes: ContentItem = {
      ...current,
      riskNotes: ["疑似虚构产地：大连"],
    };
    const next = applyContentPatch(
      withNotes,
      { riskNotes: [] },
      { updatedAt: "2026-09-25 12:00" },
    );
    expect(next.riskNotes).toEqual([]);
  });

  it("不修改原对象（纯函数）", () => {
    const snapshot = JSON.stringify(current);
    applyContentPatch(current, { title: "新标题" }, { updatedAt: "2026-09-25 12:00" });
    expect(JSON.stringify(current)).toBe(snapshot);
  });
});
