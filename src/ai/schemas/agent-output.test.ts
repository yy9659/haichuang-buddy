import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PRODUCT_AGENT_SYSTEM_PROMPT, buildProductAgentPrompt } from "@/ai/prompts/product-agent";
import { createMockAIProvider } from "@/ai/provider/mock";

import {
  buildSchemaRepairPrompt,
  extractJsonObject,
  generateValidatedObject,
  parseAgentObject,
} from "./agent-output";
import { PRODUCT_DNA_FIELD_LABELS, ProductDNASchema } from "./product-dna";

const simpleSchema = z.object({ name: z.string().min(1), count: z.number() });

describe("extractJsonObject", () => {
  it("提取 Markdown 代码围栏内的 JSON", () => {
    const raw = ["说明文字", "```json", '{"name":"鲍鱼"}', "```", "结束"].join("\n");
    expect(extractJsonObject(raw)).toBe('{"name":"鲍鱼"}');
  });

  it("无围栏时提取前后带杂文的第一个配平对象", () => {
    const raw = '好的，结果是 {"name":"海带","count":3} 以上。';
    expect(extractJsonObject(raw)).toBe('{"name":"海带","count":3}');
  });

  it("字符串字面量里的大括号不会破坏配平", () => {
    const raw = '{"text": "包含 } 与 { 的字符串", "n": 1}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it("没有对象时返回 null", () => {
    expect(extractJsonObject("完全没有 JSON")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
  });
});

describe("parseAgentObject", () => {
  it("解析并校验成功", () => {
    const result = parseAgentObject('{"name":"鲍鱼","count":2}', simpleSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ name: "鲍鱼", count: 2 });
    }
  });

  it("没有 JSON 时返回 SCHEMA_INVALID", () => {
    const result = parseAgentObject("我不太确定", simpleSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCHEMA_INVALID");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("JSON 语法错误时返回 SCHEMA_INVALID 并给出原因", () => {
    const result = parseAgentObject('{"name": }', simpleSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCHEMA_INVALID");
      expect(result.error.message).toContain("无法解析");
      expect(result.error.detail).toContain("原因：");
    }
  });

  it("结构不符时用中文标签描述错误", () => {
    const result = parseAgentObject('{"category":"海产品"}', ProductDNASchema, PRODUCT_DNA_FIELD_LABELS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toBeTruthy();
    }
  });
});

describe("buildSchemaRepairPrompt", () => {
  it("长报告纠错可以保留末尾销售内容，同时默认摘要仍有长度限制", () => {
    const raw = JSON.stringify({ executiveSummary: "长报告内容".repeat(250), salesReview: { summary: "需要纠正的76.2%", actions: [] } });
    const complete = buildSchemaRepairPrompt({ previousOutput: raw, issues: "销售占比无依据", previousOutputLimit: 16_000 });
    expect(complete).toContain('"salesReview":{"summary":"需要纠正的76.2%"');
    expect(complete).not.toContain("已截断");
    expect(buildSchemaRepairPrompt({ previousOutput: raw, issues: "测试" })).toContain("已截断");
  });
  it("包含错误信息与上一版输出，且要求只返回 JSON", () => {
    const prompt = buildSchemaRepairPrompt({
      previousOutput: '{"category":"海产品"}',
      issues: "核心卖点至少需要 1 条",
      requiredKeys: ["category", "sellingPoints"],
    });

    expect(prompt).toContain("核心卖点至少需要 1 条");
    expect(prompt).toContain("必须包含的键：category、sellingPoints");
    expect(prompt).toContain("<<<PREVIOUS_OUTPUT>>>");
    expect(prompt).toContain('{"category":"海产品"}');
  });
});

/** 构造带商品上下文的提示词，供 Mock Provider 识别为结构化请求 */
function buildPrompt(): string {
  return buildProductAgentPrompt({
    context: {
      name: "连江鲜活鲍鱼",
      description: "当日现捞的鲜活鲍鱼",
      category: "海产品",
      subCategory: "鲍鱼",
      origin: "福建连江 · 黄岐半岛",
      tags: ["鲜活", "当日现捞"],
    },
  });
}

describe("generateValidatedObject", () => {
  it("纠错时把长输出末尾的错误与采样设置传给模型", async () => {
    const first = { name: "报告内容".repeat(250), count: "错误字段位于末尾" };
    const provider = createMockAIProvider();
    let calls = 0;
    provider.generateText = async input => {
      calls += 1;
      expect(input.temperature).toBe(0);
      if (calls === 1) return JSON.stringify(first);
      expect(input.prompt).toContain('"count":"错误字段位于末尾"');
      return JSON.stringify({ name: "已纠正", count: 2 });
    };
    const result = await generateValidatedObject({ provider, system: "测试", prompt: "原始上下文", schema: simpleSchema, repairOutputLimit: 16_000, temperature: 0 });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });
  it("一次成功时不触发纠错", async () => {
    const result = await generateValidatedObject({
      provider: createMockAIProvider({ scenario: "ok" }),
      system: PRODUCT_AGENT_SYSTEM_PROMPT,
      prompt: buildPrompt(),
      schema: ProductDNASchema,
      labels: PRODUCT_DNA_FIELD_LABELS,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.attempts).toBe(1);
      expect(result.data.repaired).toBe(false);
      expect(result.data.repairNotes).toHaveLength(0);
      expect(result.data.value.subcategory).toBe("鲍鱼");
    }
  });

  it("脏 JSON 会被自动纠错一次并成功", async () => {
    const result = await generateValidatedObject({
      provider: createMockAIProvider({ scenario: "messy-then-ok" }),
      system: PRODUCT_AGENT_SYSTEM_PROMPT,
      prompt: buildPrompt(),
      schema: ProductDNASchema,
      labels: PRODUCT_DNA_FIELD_LABELS,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.attempts).toBe(2);
      expect(result.data.repaired).toBe(true);
      expect(result.data.repairNotes.length).toBe(1);
    }
  });

  it("连续脏输出时用尽重试并给出明确错误", async () => {
    const result = await generateValidatedObject({
      provider: createMockAIProvider({ scenario: "always-invalid" }),
      system: PRODUCT_AGENT_SYSTEM_PROMPT,
      prompt: buildPrompt(),
      schema: ProductDNASchema,
      labels: PRODUCT_DNA_FIELD_LABELS,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCHEMA_INVALID");
      expect(result.error.message).toContain("未通过结构校验");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("模型调用失败时不做无意义重试，直接透传错误码", async () => {
    const result = await generateValidatedObject({
      provider: createMockAIProvider({ scenario: "timeout" }),
      system: PRODUCT_AGENT_SYSTEM_PROMPT,
      prompt: buildPrompt(),
      schema: ProductDNASchema,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MODEL_TIMEOUT");
    }
  });
});
