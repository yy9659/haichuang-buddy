"use server";

import type { PosterDesignRequest } from "@/lib/poster-design";
import { PosterDesignRequestSchema } from "@/lib/poster-design";
import { attempt, fail, type Result } from "@/lib/result";
import { designPoster, getPosterDesignCapabilities, pollPosterBackground, startPosterBackground } from "@/services/poster-design.service";

function publicResult<T>(result: Result<T>): Result<T> {
  if (result.ok) return result;
  return { ok: false, error: { code: result.error.code, message: result.error.message, retryable: result.error.retryable } };
}
export async function posterDesignCapabilitiesAction() { return publicResult(await attempt(() => getPosterDesignCapabilities())); }
export async function designPosterAction(input: PosterDesignRequest) {
  const parsed = PosterDesignRequestSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION_FAILED", "请检查海报文字和设计要求，要求最多 240 字。");
  return publicResult(await designPoster(parsed.data));
}
export async function startPosterBackgroundAction(input: PosterDesignRequest) {
  const parsed = PosterDesignRequestSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION_FAILED", "请先完成海报设计并核对文字。");
  return publicResult(await startPosterBackground(parsed.data));
}
export async function pollPosterBackgroundAction(id: string) { return publicResult(await pollPosterBackground(id)); }
