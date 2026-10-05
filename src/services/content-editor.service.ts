/** 商家对生成内容的人工修改与使用确认。AI 生成本身不会自动发布。 */
import { AppError, attempt, fail, toAppError, type Result } from "@/lib/result";
import { getRepositories } from "@/repositories";
import type { ContentItem, ContentSlot } from "@/types";

export interface ContentDraftInput {
  title: string;
  hook: string;
  body: string;
  cta: string;
}

export async function saveContentDraft(
  slot: ContentSlot,
  input: ContentDraftInput,
): Promise<Result<ContentItem>> {
  const draft = {
    title: input.title.trim(),
    hook: input.hook.trim(),
    body: input.body.trim(),
    cta: input.cta.trim(),
  };
  if (!draft.title || draft.title.length > 60 || !draft.hook || draft.hook.length > 120 ||
    !draft.body || draft.body.length > 5000 || !draft.cta || draft.cta.length > 80) {
    return fail("VALIDATION_FAILED", "标题、开头、正文和行动引导不能为空，且不能超过输入框字数上限");
  }
  return attempt(
    async () => {
      const repository = getRepositories().content;
      const current = await repository.findBySlot(slot);
      if (!current) {
        throw new AppError({ code: "NOT_FOUND", message: "没有找到这份内容" });
      }
      if (current.status === "published") {
        throw new AppError({ code: "VALIDATION_FAILED", message: "已发布的内容不能直接改写，请先生成新版本" });
      }
      const editNotice = "文案已人工修改，原有风险提示未重新扫描，请核对最新内容。";
      const riskNotes = [
        ...(current.riskNotes ?? []).filter((note) => note !== editNotice).slice(0, 7),
        editNotice,
      ];
      return repository.updateBySlot(slot, { ...draft, status: "draft", riskNotes });
    },
    (cause) => toAppError(cause, "DB_ERROR", "保存内容修改失败"),
  );
}

export async function saveContentBody(
  slot: ContentSlot,
  body: string,
): Promise<Result<ContentItem>> {
  const text = body.trim();
  if (!text || text.length > 5000) {
    return fail("VALIDATION_FAILED", "正文需为 1–5000 字");
  }
  const current = await attempt(
    () => getRepositories().content.findBySlot(slot),
    (cause) => toAppError(cause, "DB_ERROR", "读取内容失败"),
  );
  if (!current.ok) return current;
  if (!current.data) return fail("NOT_FOUND", "没有找到这份内容");
  return saveContentDraft(slot, {
    title: current.data.title,
    hook: current.data.hook,
    body: text,
    cta: current.data.cta,
  });
}

export async function confirmContentStatus(
  slot: ContentSlot,
  next: "approved" | "published",
): Promise<Result<ContentItem>> {
  return attempt(
    async () => {
      const repository = getRepositories().content;
      const current = await repository.findBySlot(slot);
      if (!current) {
        throw new AppError({ code: "NOT_FOUND", message: "没有找到这份内容" });
      }
      if (current.riskNotes?.some((note) => note.includes("【Mock】"))) {
        throw new AppError({ code: "VALIDATION_FAILED", message: "演示模式生成的占位内容不能标记为可发布" });
      }
      if (next === "approved" && current.status !== "draft" && current.status !== "reviewing") {
        throw new AppError({ code: "VALIDATION_FAILED", message: "只有草稿或待确认内容可以审核通过" });
      }
      if (next === "published" && current.status !== "approved") {
        throw new AppError({ code: "VALIDATION_FAILED", message: "请先审核确认，再手动记录发布状态" });
      }
      return repository.updateBySlot(slot, { status: next });
    },
    (cause) => toAppError(cause, "DB_ERROR", "更新内容状态失败"),
  );
}
