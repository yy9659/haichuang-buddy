/** 商家自己维护品牌依据与最终档案；模型只提供可编辑草稿。 */
import { z } from "zod";

import { AppError, attempt, fail, toAppError, type Result } from "@/lib/result";
import { getRepositories } from "@/repositories";
import type { BrandProfile, BusinessProfile, OwnerTwin } from "@/types";

const shortList = z.array(z.string().trim().min(1).max(120)).max(15);

export const businessSettingsSchema = z.object({
  name: z.string().trim().min(2).max(60),
  shortName: z.string().trim().min(1).max(30),
  description: z.string().trim().max(500),
  owner: z.string().trim().max(30),
  location: z.string().trim().max(80),
  mainCategory: z.string().trim().max(40),
  channels: shortList,
});

export const ownerSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(30),
  businessPhilosophy: shortList,
  tone: shortList,
  salesStyle: z.string().trim().max(160),
  targetCustomers: shortList,
  forbiddenExpressions: shortList,
});

export const brandDraftSchema = z.object({
  factsConfirmed: z.boolean().refine(Boolean),
  positioning: z.string().trim().min(2).max(200),
  brandStory: z.string().trim().min(2).max(1500),
  slogan: z.string().trim().max(80),
  ipConcept: z.string().trim().max(500),
  targetAudience: shortList,
  brandValues: shortList,
  brandPersonality: shortList,
  toneOfVoice: shortList,
  visualKeywords: shortList,
});

export type BusinessSettingsInput = z.infer<typeof businessSettingsSchema>;
export type OwnerSettingsInput = z.infer<typeof ownerSettingsSchema>;
export type BrandDraftInput = z.infer<typeof brandDraftSchema>;

function validationMessage(error: z.ZodError): string {
  const labels: Record<string, string> = {
    name: "商家名称", shortName: "展示简称", description: "商家自述",
    owner: "商家负责人", location: "所在地", mainCategory: "主营品类",
    channels: "经营渠道", displayName: "内容表达者称呼", businessPhilosophy: "经营理念",
    tone: "表达语气", salesStyle: "销售风格", targetCustomers: "目标顾客",
    forbiddenExpressions: "禁用表达", positioning: "品牌定位", brandStory: "品牌故事",
    slogan: "品牌主张", ipConcept: "IP 概念", targetAudience: "目标人群",
    brandValues: "品牌价值", brandPersonality: "品牌性格", toneOfVoice: "内容语气",
    visualKeywords: "视觉关键词", factsConfirmed: "资料真实性确认",
  };
  const key = String(error.issues[0]?.path[0] ?? "");
  return `${labels[key] ?? "资料"}填写不正确，请检查内容和字数`;
}

/** 基础资料变化后撤销旧品牌确认，但保留草稿供商家继续修改。 */
async function revokeExistingApproval(): Promise<void> {
  const repository = getRepositories().brand;
  const brand = await repository.getProfile();
  if (brand?.approved) await repository.update({ approved: false });
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export async function saveBusinessSettings(input: unknown): Promise<Result<BusinessProfile>> {
  const parsed = businessSettingsSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION_FAILED", validationMessage(parsed.error));
  return attempt(async () => {
    const current = await getRepositories().business.getProfile();
    if (current && current.name === parsed.data.name && current.shortName === parsed.data.shortName &&
      (current.description ?? "") === parsed.data.description && current.owner === parsed.data.owner &&
      current.location === parsed.data.location && current.mainCategory === parsed.data.mainCategory &&
      sameList(current.channels, parsed.data.channels)) return current;
    await revokeExistingApproval();
    return getRepositories().business.updateProfile(parsed.data);
  }, (cause) => toAppError(cause, "DB_ERROR", "保存商家资料失败"));
}

export async function saveOwnerSettings(input: unknown): Promise<Result<OwnerTwin>> {
  const parsed = ownerSettingsSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION_FAILED", validationMessage(parsed.error));
  return attempt(async () => {
    const current = await getRepositories().business.getOwnerTwin();
    if (current && current.displayName === parsed.data.displayName &&
      sameList(current.businessPhilosophy, parsed.data.businessPhilosophy) &&
      sameList(current.tone, parsed.data.tone) && current.salesStyle === parsed.data.salesStyle &&
      sameList(current.targetCustomers, parsed.data.targetCustomers) &&
      sameList(current.forbiddenExpressions, parsed.data.forbiddenExpressions)) return current;
    await revokeExistingApproval();
    return getRepositories().business.updateOwnerTwin({
      ...parsed.data,
      avatarLabel: parsed.data.displayName.slice(0, 1),
    });
  }, (cause) => toAppError(cause, "DB_ERROR", "保存表达偏好失败"));
}

export async function saveBrandDraft(input: unknown): Promise<Result<BrandProfile>> {
  const parsed = brandDraftSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION_FAILED", validationMessage(parsed.error));
  return attempt(async () => {
    const repository = getRepositories().brand;
    const existing = await repository.getProfile();
    const { factsConfirmed: _factsConfirmed, ...fields } = parsed.data;
    void _factsConfirmed;
    const draft = {
      ...fields,
      riskNotes: [] as string[],
      aiVersion: "manual-v1",
      confidence: 0,
      approved: false,
      sourceProductId: null,
    };
    return existing
      ? repository.update(draft)
      : repository.create(draft);
  }, (cause) => toAppError(cause, "DB_ERROR", "保存品牌档案失败"));
}

export async function approveBrandDraft(): Promise<Result<BrandProfile>> {
  return attempt(async () => {
    const repository = getRepositories().brand;
    const brand = await repository.getProfile();
    if (!brand) throw new AppError({ code: "NOT_FOUND", message: "请先填写或生成品牌档案" });
    if (brand.riskNotes.some((note) => note.includes("【Mock】"))) {
      throw new AppError({ code: "VALIDATION_FAILED", message: "演示占位档案不能直接确认；请先编辑并核对全部字段" });
    }
    return repository.update({ approved: true });
  }, (cause) => toAppError(cause, "DB_ERROR", "确认品牌档案失败"));
}
