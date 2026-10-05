import { getServerEnv, getDataSource } from "@/lib/env";
import { AppError, attempt, type Result } from "@/lib/result";
import { isAdminEmail, publicKnowledgeSchema } from "@/lib/admin";
import { getPlatformRepository } from "@/repositories/platform";
import { getCurrentAuthUser } from "./auth.service";
import type { PublicKnowledgeDocument, PublicKnowledgeInput } from "@/types/admin";

export async function requireAdmin() {
  const user = await getCurrentAuthUser();
  if (!user || !isAdminEmail(user.email, getServerEnv().ADMIN_EMAILS)) throw new AppError({ code: "UNAUTHORIZED", message: "此功能仅限平台管理员使用", retryable: false });
  return user;
}
export async function getAdminOverview() {
  await requireAdmin();
  return { snapshot: await getPlatformRepository().snapshot(new Date()), dataSource: getDataSource() };
}
export async function listPublicKnowledgeForAdmin() {
  await requireAdmin();
  return getPlatformRepository().listKnowledge();
}
export async function listPublishedPublicKnowledge() {
  if (!await getCurrentAuthUser()) throw new AppError({ code: "UNAUTHORIZED", message: "请登录后查阅公共资料", retryable: false });
  return getPlatformRepository().listKnowledge(true);
}
export async function savePublicKnowledge(id: string | null, input: PublicKnowledgeInput): Promise<Result<PublicKnowledgeDocument>> {
  return attempt(async () => {
    const user = await requireAdmin();
    if (id !== null && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) throw new AppError({ code: "VALIDATION_FAILED", message: "知识编号无效" });
    const parsed = publicKnowledgeSchema.safeParse(input);
    if (!parsed.success) throw new AppError({ code: "VALIDATION_FAILED", message: parsed.error.issues.map(issue => issue.message).join("；") });
    const saved = await getPlatformRepository().saveKnowledge(id, parsed.data, user.id);
    if (!saved) throw new AppError({ code: "NOT_FOUND", message: "知识已不存在，请刷新页面" });
    return saved;
  });
}
export async function deletePublicKnowledge(id: string): Promise<Result<{ deleted: boolean }>> {
  return attempt(async () => {
    await requireAdmin();
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) throw new AppError({ code: "VALIDATION_FAILED", message: "知识编号无效" });
    return { deleted: await getPlatformRepository().deleteKnowledge(id) };
  });
}
