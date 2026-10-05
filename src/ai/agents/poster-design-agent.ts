import { getAIProvider, AI_PROVIDER_LABEL, type AIProvider } from "@/ai/provider";
import { PosterDesignSchema, type PosterDesignResult } from "@/lib/poster-design";
import { attempt, AppError, toAppError, type Result } from "@/lib/result";
import { buildPosterDesignPrompt, POSTER_DESIGN_SYSTEM } from "@/ai/prompts/poster-design";
import { generateValidatedObject } from "@/ai/schemas/agent-output";

const GeneratedPosterDesignSchema = PosterDesignSchema.refine(
  (design) => !!design.composition,
  "请提供 composition 自定义画面布局",
);

export async function runPosterDesignAgent(
  context: Record<string, unknown>,
  provider: AIProvider = getAIProvider(),
): Promise<Result<PosterDesignResult>> {
  return attempt(async () => {
    const generated = await generateValidatedObject({
      provider,
      system: POSTER_DESIGN_SYSTEM,
      prompt: buildPosterDesignPrompt(context),
      schema: GeneratedPosterDesignSchema,
      tier: "reasoning",
      signal: AbortSignal.timeout(45_000),
      maxAttempts: 2,
      repairGuidance: () =>
        "只修复不合法的区域，保留配色、文案与设计方向。六个矩形不能重叠，x/y至少24，x+width<=976，y+height<=968。照片通常宽至少450、高至少300，价格区域宽至少380、高至少100。",
    });
    if (!generated.ok) throw new AppError(generated.error);
    return {
      design: generated.data.value,
      isMock: provider.id === "mock",
      providerLabel: provider.id === "mock"
        ? "演示设计"
        : AI_PROVIDER_LABEL[provider.id] ?? "AI 设计模型",
    };
  }, (cause) => toAppError(
    cause,
    "MODEL_UNAVAILABLE",
    "AI 暂时没有完成设计，请重试；原来的海报仍可使用。",
  ));
}
