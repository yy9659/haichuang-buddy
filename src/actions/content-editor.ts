"use server";

import { revalidatePath } from "next/cache";

import { isContentFormat, isContentPlatform } from "@/lib/content-options";
import { fail, type Result } from "@/lib/result";
import { confirmContentStatus, saveContentBody, saveContentDraft, type ContentDraftInput } from "@/services/content-editor.service";
import type { ContentItem, ContentSlot } from "@/types";

function parseSlot(input: ContentSlot): Result<ContentSlot> {
  if (
    !input ||
    typeof input.productId !== "string" ||
    !input.productId ||
    !isContentPlatform(input.platform) ||
    !isContentFormat(input.format)
  ) {
    return fail("VALIDATION_FAILED", "内容位置不正确，请刷新页面重试");
  }
  return { ok: true, data: input };
}

function refreshContent(): void {
  revalidatePath("/content");
  revalidatePath("/dashboard");
  revalidatePath("/analytics");
}

function publicResult<T>(result: Result<T>): Result<T> {
  if (result.ok) return result;
  return {
    ok: false,
    error: {
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.retryable,
    },
  };
}

export async function saveContentBodyAction(
  slot: ContentSlot,
  body: string,
): Promise<Result<ContentItem>> {
  const parsed = parseSlot(slot);
  if (!parsed.ok) return parsed;
  if (typeof body !== "string") return fail("VALIDATION_FAILED", "正文格式不正确");
  const result = await saveContentBody(parsed.data, body);
  if (result.ok) refreshContent();
  return publicResult(result);
}

export async function saveContentDraftAction(
  slot: ContentSlot,
  input: ContentDraftInput,
): Promise<Result<ContentItem>> {
  const parsed = parseSlot(slot);
  if (!parsed.ok) return parsed;
  if (!input || typeof input !== "object" ||
    typeof input.title !== "string" || typeof input.hook !== "string" ||
    typeof input.body !== "string" || typeof input.cta !== "string") {
    return fail("VALIDATION_FAILED", "内容格式不正确");
  }
  const result = await saveContentDraft(parsed.data, input);
  if (result.ok) refreshContent();
  return publicResult(result);
}

export async function confirmContentStatusAction(
  slot: ContentSlot,
  status: "approved" | "published",
): Promise<Result<ContentItem>> {
  const parsed = parseSlot(slot);
  if (!parsed.ok) return parsed;
  if (status !== "approved" && status !== "published") {
    return fail("VALIDATION_FAILED", "内容状态不正确");
  }
  const result = await confirmContentStatus(parsed.data, status);
  if (result.ok) refreshContent();
  return publicResult(result);
}
