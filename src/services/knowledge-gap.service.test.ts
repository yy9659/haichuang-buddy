/**
 * 知识缺口聚合 Service 单测（S5 · Task 78）
 *
 * 这组用例验证的不是「函数能跑」，而是**「聚合边界画在哪里」**：
 * 哪些提问该合成一条、哪些必须分开、什么状态在重复出现时该怎么流转。
 * 任务书第十六节的 Case 1–8 逐条覆盖，另补排序与入参校验。
 *
 * 之所以能用断言钉住这些行为：缺口面板的核心价值是 `occurrenceCount`，
 * 而计数只有在「聚合边界正确」时才有意义。边界错一格，商家看到的就是
 * 一个看起来正常、实际不可信的数字 —— 这种错误不会报错，只能靠测试挡住。
 *
 * 数据源固定为 Mock（进程内 store），不需要数据库；DB 实现的对应行为
 * 由同一份 `resolveKnowledgeGapIdentity` 与同一组 upsert 语义保证，
 * 集成测试见 `src/repositories/db/*.test.ts`（无凭证时整组跳过）。
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetServerEnvCache } from "@/lib/env";
import { MOCK_BUSINESS } from "@/lib/mock";
import { listStoredKnowledgeGaps, resetStoredKnowledge } from "@/repositories/mock/store";
import type { CustomerIntent } from "@/types";

import {
  getKnowledgeGap,
  ignoreKnowledgeGap,
  listKnowledgeGaps,
  recordKnowledgeGap,
  resolveKnowledgeGap,
  type RecordKnowledgeGapInput,
} from "./knowledge-gap.service";

/**
 * 先归一化环境再取仓储：`getRepositories()` 在 DATA_SOURCE=db 且缺少连接串时
 * 会直接抛错，放在模块顶层就会让整个测试文件加载失败。
 */
const originalEnv = {
  DATA_SOURCE: process.env.DATA_SOURCE,
  AI_PROVIDER: process.env.AI_PROVIDER,
};

process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetServerEnvCache();
});

/** 单商家 Demo 的商家 id */
const BUSINESS_ID = MOCK_BUSINESS.id;

beforeEach(() => {
  resetStoredKnowledge();
});

/* ------------------------------------------------------------------ */
/* 测试辅助                                                            */
/* ------------------------------------------------------------------ */

function record(
  question: string,
  overrides: Partial<RecordKnowledgeGapInput> = {},
): ReturnType<typeof recordKnowledgeGap> {
  return recordKnowledgeGap({
    businessId: BUSINESS_ID,
    productId: null,
    question,
    intent: "logistics" satisfies CustomerIntent,
    reason: "缺少物流时效说明（发货时间、配送范围与到货时效）",
    ...overrides,
  });
}

/** 断言「成功且确实记录了一条」，并返回它 —— 让下面的用例只关心语义 */
async function recorded(result: Awaited<ReturnType<typeof record>>) {
  if (!result.ok) {
    throw new Error(`预期记录成功，实际失败：${result.error.message}`);
  }
  if (result.data === null) {
    throw new Error("预期记录一条缺口，实际被跳过了");
  }
  return result.data;
}

/** 直读内存 store，拿到未被格式化过的原始时间戳（分钟粒度的展示值不足以断言时间） */
function rawGap(id: string) {
  const gap = listStoredKnowledgeGaps().find((item) => item.id === id);
  if (!gap) {
    throw new Error(`内存 store 中不存在缺口 ${id}`);
  }
  return gap;
}

/* ------------------------------------------------------------------ */
/* Case 1–4：聚合边界                                                  */
/* ------------------------------------------------------------------ */

describe("聚合边界", () => {
  it("Case 1：首次出现的答不上来，新建一条 open 缺口，计数为 1", async () => {
    const gap = await recorded(await record("多久发货？"));

    expect(gap.status).toBe("open");
    expect(gap.occurrenceCount).toBe(1);
    expect(gap.normalizedQuestion).toBe("多久发货");
    expect(gap.firstSeenAt).toBe(gap.lastSeenAt);
    expect(listStoredKnowledgeGaps()).toHaveLength(1);
  });

  it("Case 2：完全相同的问题问两次，仍只有一条，计数为 2", async () => {
    await record("多久发货？");
    const second = await recorded(await record("多久发货？"));

    expect(second.occurrenceCount).toBe(2);
    expect(listStoredKnowledgeGaps()).toHaveLength(1);
  });

  it("Case 3：只有格式差异（空格、重复问号）的提问聚合成同一条", async () => {
    await record("多久发货？");
    const second = await recorded(await record("  多久发货??  "));

    expect(second.occurrenceCount).toBe(2);
    expect(listStoredKnowledgeGaps()).toHaveLength(1);
  });

  it("Case 4：语义不同的问题不会被合并（不做同义词归并）", async () => {
    await record("多久发货？");
    await record("怎么保存？");

    expect(listStoredKnowledgeGaps()).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Case 5–6：隔离维度                                                  */
/* ------------------------------------------------------------------ */

describe("隔离维度", () => {
  it("Case 5：同一句问法挂在两个商品下必须分成两条（否则补了 A 会连 B 一起标成已解决）", async () => {
    const first = await recorded(await record("怎么保存？", { productId: "prod_001" }));
    const second = await recorded(await record("怎么保存？", { productId: "prod_005" }));

    expect(first.id).not.toBe(second.id);
    expect(listStoredKnowledgeGaps()).toHaveLength(2);
    expect(first.normalizedQuestion).toBe(second.normalizedQuestion);
  });

  it("Case 5：商品级与全店级（productId 为空）也互不合并", async () => {
    await record("多久发货？", { productId: "prod_001" });
    await record("多久发货？", { productId: null });

    expect(listStoredKnowledgeGaps()).toHaveLength(2);
  });

  it("Case 6：不同商家的同一句提问不能合并（跨商家聚合不可接受）", async () => {
    const mine = await recorded(await record("多久发货？"));
    const other = await recorded(await record("多久发货？", { businessId: "biz_other" }));

    expect(mine.id).not.toBe(other.id);
    expect(listStoredKnowledgeGaps()).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Case 7–8：状态流转                                                  */
/* ------------------------------------------------------------------ */

describe("状态流转", () => {
  it("Case 7：已 resolved 的缺口再次出现且仍无依据 → 重新置为 open，计数 +1", async () => {
    const created = await recorded(await record("多久发货？"));
    const resolved = await resolveKnowledgeGap(created.id, "kdoc_009");
    expect(resolved.ok && resolved.data.status).toBe("resolved");
    expect(resolved.ok && resolved.data.resolvedDocumentId).toBe("kdoc_009");

    const reopened = await recorded(await record("多久发货？"));

    expect(reopened.id).toBe(created.id);
    expect(reopened.status).toBe("open");
    expect(reopened.occurrenceCount).toBe(2);
    // 重开后必须清掉「已由某文档解决」的引用，否则同一行上会同时出现
    // 「未解决」与「已由《…》解决」两种互相矛盾的说法
    expect(reopened.resolvedDocumentId).toBeNull();
  });

  it("Case 8：ignored 的缺口再次出现不重开，但计数 +1、lastSeenAt 前进", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const first = new Date("2026-09-26T10:00:00+08:00");
      vi.setSystemTime(first);
      const created = await recorded(await record("多久发货？"));

      const ignored = await ignoreKnowledgeGap(created.id);
      expect(ignored.ok && ignored.data.status).toBe("ignored");
      expect(rawGap(created.id).lastSeenAt.getTime()).toBe(first.getTime());

      const later = new Date("2026-09-26T10:05:00+08:00");
      vi.setSystemTime(later);
      const again = await recorded(await record("多久发货？"));

      expect(again.id).toBe(created.id);
      // 商家当初判定这个问题不需要专门补知识，重复出现不构成改变主意的理由
      expect(again.status).toBe("ignored");
      // 但计数照涨：「这个问题一直在发生」必须始终可见
      expect(again.occurrenceCount).toBe(2);
      expect(rawGap(created.id).lastSeenAt.getTime()).toBe(later.getTime());
      expect(rawGap(created.id).firstSeenAt.getTime()).toBe(first.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignored 之后被标记 resolved，来源文档会写入；再改回 ignored 时清空", async () => {
    const created = await recorded(await record("多久发货？"));

    const resolved = await resolveKnowledgeGap(created.id, "kdoc_009");
    expect(resolved.ok && resolved.data.resolvedDocumentId).toBe("kdoc_009");

    const ignored = await ignoreKnowledgeGap(created.id);
    expect(ignored.ok && ignored.data.resolvedDocumentId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 排序与查询                                                          */
/* ------------------------------------------------------------------ */

describe("列表排序", () => {
  it("未解决优先 → 出现次数多优先 → 最近出现优先", async () => {
    // 出现 5 次但已解决
    const resolvedMany = await recorded(await record("有优惠吗？", { intent: "price" }));
    for (let i = 0; i < 4; i += 1) {
      await record("有优惠吗？", { intent: "price" });
    }
    await resolveKnowledgeGap(resolvedMany.id, "kdoc_009");

    // 未解决，出现 3 次
    for (let i = 0; i < 3; i += 1) {
      await record("多久发货？");
    }

    // 未解决，出现 1 次
    await record("怎么保存？", { intent: "storage" });

    const listed = await listKnowledgeGaps();
    if (!listed.ok) {
      throw new Error(`列表查询失败：${listed.error.message}`);
    }

    expect(listed.data.map((gap) => gap.normalizedQuestion)).toEqual([
      "多久发货", // open，3 次
      "怎么保存", // open，1 次
      "有优惠", // resolved，5 次 —— 已解决的问题不该压住未解决的（句尾「吗」被规范化剥掉）
    ]);
  });

  it("按状态过滤只返回对应的记录", async () => {
    const open = await recorded(await record("多久发货？"));
    const toIgnore = await recorded(await record("怎么保存？", { intent: "storage" }));
    await ignoreKnowledgeGap(toIgnore.id);

    const listed = await listKnowledgeGaps({ status: "open" });
    if (!listed.ok) {
      throw new Error(`列表查询失败：${listed.error.message}`);
    }
    expect(listed.data.map((gap) => gap.id)).toEqual([open.id]);
  });
});

/* ------------------------------------------------------------------ */
/* 不该被记录 / 入参非法                                               */
/* ------------------------------------------------------------------ */

describe("不该记录与非法入参", () => {
  it("问题规范化后为空（只发了标点）→ 刻意不记录，返回 null 而不是报错", async () => {
    const result = await record("？？？");

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBeNull();
    expect(listStoredKnowledgeGaps()).toHaveLength(0);
  });

  it("规范化后为空时不会污染已有缺口（空键聚合是灾难性的）", async () => {
    await record("多久发货？");
    await record("。。。");

    expect(listStoredKnowledgeGaps()).toHaveLength(1);
  });

  it("问题原文为空 → 明确的 VALIDATION_FAILED，而不是静默跳过", async () => {
    const result = await record("   ");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
  });

  it("缺少商家标识 → VALIDATION_FAILED（缺口至少按商家隔离）", async () => {
    const result = await record("多久发货？", { businessId: "  " });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
  });

  it("缺少缺口说明 → VALIDATION_FAILED（不说「缺什么」的缺口不是可执行的待办）", async () => {
    const result = await record("多久发货？", { reason: "" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
  });

  it("按 id 读取不存在的缺口 → NOT_FOUND", async () => {
    const result = await getKnowledgeGap("gap_不存在");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("NOT_FOUND");
  });

  it("修改不存在的缺口 → NOT_FOUND", async () => {
    const result = await resolveKnowledgeGap("gap_不存在");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("NOT_FOUND");
  });
});
