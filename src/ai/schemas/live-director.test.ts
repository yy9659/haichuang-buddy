/**
 * AI 直播导演结构化契约单测（S6 · 任务书第七节）
 *
 * 这份 Schema 的价值不在「字段类型对不对」，而在四条**业务一致性**约束：
 * 它们把「模型的偷懒 / 越界」直接变成一次校验失败，从而触发回喂纠错。
 * 因此每个用例都专门盯住一条约束被破坏时的表现。
 */

import { describe, expect, it } from "vitest";

import {
  INSUFFICIENT_LIVE_CONFIDENCE,
  LIVE_DIRECTOR_REQUIRED_KEYS,
  LiveDirectorResultSchema,
  MAX_LIVE_CITATIONS,
} from "@/ai/schemas/live-director";

/** 一份合法草稿：各用例只改动需要观察的那一个字段 */
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: "storage_question",
    priority: "high",
    shouldRespond: true,
    responseMode: "answer_now",
    hostSuggestion: "观众在问储存方式，建议主播结合知识内容正面回应。",
    suggestedReply: "鲜活鲍鱼建议冷藏保存，0-4 摄氏度最佳。",
    grounded: true,
    citations: [{ documentId: "doc_1", chunkId: "chunk_1" }],
    recommendedAction: "explain_storage",
    riskNotes: [],
    confidence: 0.8,
    ...overrides,
  };
}

function firstIssuePaths(input: Record<string, unknown>): string[] {
  const parsed = LiveDirectorResultSchema.safeParse(input);
  if (parsed.success) {
    return [];
  }
  return parsed.error.issues.map((issue) => issue.path.join("."));
}

describe("直播导演契约 · 形状", () => {
  it("合法草稿通过校验", () => {
    expect(LiveDirectorResultSchema.safeParse(draft()).success).toBe(true);
  });

  it("sellingAngle 可选（事实型问题本来就不该有营销切入点）", () => {
    expect(LiveDirectorResultSchema.safeParse(draft()).success).toBe(true);
    expect(
      LiveDirectorResultSchema.safeParse(draft({ sellingAngle: "强调现捞直发" }))
        .success,
    ).toBe(true);
  });

  it("意图 / 优先级 / 动作 / 回应方式都必须在白名单内", () => {
    expect(firstIssuePaths(draft({ intent: "unknown_intent" }))).toContain("intent");
    expect(firstIssuePaths(draft({ priority: "urgent" }))).toContain("priority");
    expect(firstIssuePaths(draft({ recommendedAction: "do_something" }))).toContain(
      "recommendedAction",
    );
    expect(firstIssuePaths(draft({ responseMode: "shout" }))).toContain("responseMode");
  });

  it("引用条数超过上限被拒绝", () => {
    const citations = Array.from({ length: MAX_LIVE_CITATIONS + 1 }, (_, index) => ({
      documentId: `doc_${index}`,
      chunkId: `chunk_${index}`,
    }));
    expect(firstIssuePaths(draft({ citations }))).toContain("citations");
  });

  it("纠错提示要求的键名清单与实际契约一致", () => {
    const shape = LiveDirectorResultSchema.safeParse(draft());
    if (!shape.success) {
      throw new Error("基准草稿应当合法");
    }
    for (const key of LIVE_DIRECTOR_REQUIRED_KEYS) {
      expect(Object.keys(shape.data)).toContain(key);
    }
  });
});

describe("直播导演契约 · 业务一致性", () => {
  it("grounded=true 却没有任何引用 -> 拒绝（有依据却指不出依据在哪）", () => {
    expect(firstIssuePaths(draft({ grounded: true, citations: [] }))).toContain(
      "citations",
    );
  });

  it("grounded=false 却给了引用 -> 拒绝（没有依据就不该有引用）", () => {
    const issues = firstIssuePaths(
      draft({
        grounded: false,
        riskNotes: ["至少一条风险提示"],
      }),
    );
    expect(issues).toContain("citations");
  });

  it("grounded=false 却没有任何风险提示 -> 拒绝（主播看不到「没有依据兜底」）", () => {
    expect(
      firstIssuePaths(draft({ grounded: false, citations: [], riskNotes: [] })),
    ).toContain("riskNotes");
  });

  it("grounded=false + 无引用 + 有风险提示 -> 通过", () => {
    const parsed = LiveDirectorResultSchema.safeParse(
      draft({
        grounded: false,
        citations: [],
        riskNotes: ["本条没有可用知识依据，不要给出具体承诺。"],
        responseMode: "send_to_customer_service",
        recommendedAction: "guide_to_customer_service",
        confidence: INSUFFICIENT_LIVE_CONFIDENCE,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("shouldRespond=false 时推荐动作只能 ignore", () => {
    expect(
      firstIssuePaths(draft({ shouldRespond: false, recommendedAction: "handle_objection" })),
    ).toContain("recommendedAction");
    expect(
      LiveDirectorResultSchema.safeParse(
        draft({ shouldRespond: false, recommendedAction: "ignore", responseMode: "ignore" }),
      ).success,
    ).toBe(true);
  });

  it("shouldRespond=true 时推荐动作不能是 ignore", () => {
    expect(firstIssuePaths(draft({ shouldRespond: true, recommendedAction: "ignore" }))).toContain(
      "recommendedAction",
    );
  });
});
