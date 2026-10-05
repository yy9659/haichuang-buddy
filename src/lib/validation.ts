/**
 * Zod 校验错误的展示转换
 *
 * 校验失败要给出「人能看懂、并且知道改哪一项」的提示，
 * 而不是把 Zod 的原始 issues 直接抛到界面上。
 */

import type { ZodError } from "zod";

/** 把字段名映射为中文标签；未命中时回退为字段名本身 */
export type FieldLabelMap = Readonly<Record<string, string>>;

/**
 * 把字段路径拼成标签键：数组下标不参与拼接。
 *
 * 为什么要丢掉下标：`issues.path` 里数组元素带下标（如 `["tasks", 0, "id"]`），
 * 若照原样拼成 `tasks.0.id`，标签表就得为每个下标各写一条 —— 那不可能穷举。
 * 丢掉下标后 `tasks.0.id` 与 `tasks.1.id` 都能命中同一条 `tasks.id` 标签，
 * 「任务 id 不能为空」这类提示才出得来。非数组字段的路径不受影响。
 */
function labelOf(path: readonly PropertyKey[], labels?: FieldLabelMap): string {
  const field = path
    .filter((segment) => typeof segment !== "number")
    .map((segment) => String(segment))
    .join(".");
  if (!field) {
    return "";
  }
  return labels?.[field] ?? field;
}

/** 取第一条错误，返回"字段：原因"，用于对话框顶部的红色提示 */
export function firstIssueMessage(
  error: ZodError,
  labels?: FieldLabelMap,
): string {
  const issue = error.issues[0];
  if (!issue) {
    return "提交的内容不合法，请检查后重试";
  }
  const label = labelOf(issue.path, labels);
  return label ? `${label}：${issue.message}` : issue.message;
}

/** 全部错误拼成一行，用于日志与 detail 字段 */
export function formatIssues(error: ZodError, labels?: FieldLabelMap): string {
  return error.issues
    .map((issue) => {
      const label = labelOf(issue.path, labels);
      return label ? `${label}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
