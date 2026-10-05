"use server";

import { revalidatePath } from "next/cache";

import { fail, type Result } from "@/lib/result";
import {
  approveBrandDraft,
  saveBrandDraft,
  saveBusinessSettings,
  saveOwnerSettings,
  type BrandDraftInput,
  type BusinessSettingsInput,
  type OwnerSettingsInput,
} from "@/services/brand-editor.service";
import type { BrandProfile, BusinessProfile, OwnerTwin } from "@/types";
import { getCurrentAuthUser } from "@/services/auth.service";

async function requireLogin(): Promise<Result<true>> {
  return (await getCurrentAuthUser())
    ? { ok: true, data: true }
    : fail("UNAUTHORIZED", "请先登录后再修改品牌资料");
}

function refresh(): void {
  for (const path of ["/brand", "/dashboard", "/content", "/products", "/live", "/customer-service"]) {
    revalidatePath(path);
  }
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

export async function saveBusinessSettingsAction(input: BusinessSettingsInput): Promise<Result<BusinessProfile>> {
  const auth = await requireLogin();
  if (!auth.ok) return auth;
  const result = await saveBusinessSettings(input);
  if (result.ok) refresh();
  return publicResult(result);
}

export async function saveOwnerSettingsAction(input: OwnerSettingsInput): Promise<Result<OwnerTwin>> {
  const auth = await requireLogin();
  if (!auth.ok) return auth;
  const result = await saveOwnerSettings(input);
  if (result.ok) refresh();
  return publicResult(result);
}

export async function saveBrandDraftAction(input: BrandDraftInput): Promise<Result<BrandProfile>> {
  const auth = await requireLogin();
  if (!auth.ok) return auth;
  const result = await saveBrandDraft(input);
  if (result.ok) refresh();
  return publicResult(result);
}

export async function approveBrandDraftAction(): Promise<Result<BrandProfile>> {
  const auth = await requireLogin();
  if (!auth.ok) return auth;
  const result = await approveBrandDraft();
  if (result.ok) refresh();
  return publicResult(result);
}
