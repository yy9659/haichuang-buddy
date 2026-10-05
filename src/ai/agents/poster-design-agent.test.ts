import { describe, expect, it, vi } from "vitest";
import { createMockAIProvider, type AIProvider } from "@/ai/provider";
import { AppError } from "@/lib/result";
import { buildMockPosterDesign, buildPosterDesignPrompt } from "@/ai/prompts/poster-design";
import { PosterDesignSchema } from "@/lib/poster-design";
import { runPosterDesignAgent } from "./poster-design-agent";

const context = { request: { instruction: "更温馨，适合家庭晚餐", previous: null } };

describe("海报设计 Agent", () => {
  it("演示方案有明确标记，且调整真实构图参数", async () => {
    const result = await runPosterDesignAgent(context, createMockAIProvider());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isMock).toBe(true);
    expect(result.data.design.layout).toBe("showcase");
    expect(result.data.design.palette.accent).toBe("#bd5636");
  });
  it("真实提供方收到商品上下文，结果不是演示方案", async () => {
    const generateText = vi.fn().mockResolvedValue(JSON.stringify(buildMockPosterDesign(buildPosterDesignPrompt(context))));
    const provider = { ...createMockAIProvider(), id: "dashscope", generateText } as AIProvider;
    const result = await runPosterDesignAgent({ ...context, product: { name: "鱼丸", price: 45 } }, provider);
    expect(result.ok && result.data.isMock).toBe(false);
    expect(generateText).toHaveBeenCalledOnce();
    expect(generateText.mock.calls[0][0].prompt).toContain('"price":45');
    expect(generateText.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });
  it("模型失败或不合法参数不会悄悄变成演示成功", async () => {
    const provider = { ...createMockAIProvider(), id: "dashscope", generateText: vi.fn().mockRejectedValue(new AppError({ code: "MODEL_UNAVAILABLE", message: "暂时不可用" })) } as AIProvider;
    const result = await runPosterDesignAgent(context, provider);
    expect(result.ok).toBe(false);
    const bad = { ...buildMockPosterDesign(buildPosterDesignPrompt(context)), palette: { background: "url(javascript:alert(1))" } };
    expect(PosterDesignSchema.safeParse(bad).success).toBe(false);
    provider.generateText = vi.fn().mockResolvedValue(JSON.stringify(bad));
    const invalid = await runPosterDesignAgent(context, provider);
    expect(!invalid.ok && invalid.error.code).toBe("SCHEMA_INVALID");
  });
  it("布局重叠只纠错一次，网络失败不会重复调用", async () => {
    const good = buildMockPosterDesign(buildPosterDesignPrompt(context));
    const bad = { ...good, composition: { ...good.composition, title: good.composition!.photo } };
    const generateText = vi.fn().mockResolvedValueOnce(JSON.stringify(bad)).mockResolvedValueOnce(JSON.stringify(good));
    const result = await runPosterDesignAgent(context, { ...createMockAIProvider(), id: "dashscope", generateText });
    expect(result.ok).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1][0].prompt).toContain("区域重叠");
    generateText.mockReset().mockRejectedValue(new AppError({ code: "MODEL_UNAVAILABLE", message: "网络不可用" }));
    expect((await runPosterDesignAgent(context, { ...createMockAIProvider(), generateText })).ok).toBe(false);
    expect(generateText).toHaveBeenCalledOnce();
  });
});
