import { z } from "zod";
import { PUBLIC_KNOWLEDGE_CATEGORIES, type PlatformTask, type PlatformTrendPoint } from "@/types/admin";

export function isAdminEmail(email: string, allowlist: string): boolean {
  return allowlist.split(/[,;，；\s]+/).filter(Boolean).some(value => value.toLowerCase() === email.trim().toLowerCase());
}

export const publicKnowledgeSchema = z.object({
  title: z.string().trim().min(2, "请填写知识标题").max(100),
  category: z.enum(PUBLIC_KNOWLEDGE_CATEGORIES),
  content: z.string().trim().min(10, "正文至少需要 10 个字").max(16000, "正文最多 16000 个字"),
  tags: z.array(z.string().trim().min(1).max(20)).max(8, "最多填写 8 个标签"),
  sourceName: z.string().trim().max(160),
  sourceUrl: z.union([z.literal(""), z.string().url().refine(value => /^https?:\/\//i.test(value), "来源链接需使用 http 或 https")]),
  verified: z.boolean(),
  status: z.enum(["draft", "published", "archived"]),
}).strict().superRefine((value, context) => {
  if (value.status === "published" && (!value.verified || !value.sourceName)) {
    context.addIssue({ code: "custom", path: ["status"], message: "发布前请填写来源并确认已核对正文；待核验资料可先保存为草稿。" });
  }
});

/** 仅输出脱敏摘要，不把模型凭据、完整地址或原始输出带入管理界面。 */
export function redactTaskError(message: string | null): string | null {
  if (!message) return null;
  return message.replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.-]+/gi, "[凭据已隐藏]")
    .replace(/(?:api[_-]?key|token|password|authorization)["']?\s*[:=]\s*["']?[^\s,;，；"'}]+/gi, "凭据=[已隐藏]")
    .replace(/https?:\/\/[^\s)）]+/gi, "[接口地址]").slice(0, 220);
}

export function chinaDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
export function platformWeekStart(now: Date): Date {
  return new Date(`${chinaDay(new Date(now.getTime() - 6 * 86400000))}T00:00:00+08:00`);
}

/** 以任务记录的结束时间及耗时估算执行区间；数据不代表 GPU 遥测或 HTTP 请求数。 */
export function buildPlatformTrend(tasks: readonly PlatformTask[], now: Date): PlatformTrendPoint[] {
  const start = platformWeekStart(now).getTime();
  return Array.from({ length: 7 }, (_, index) => {
    const lower = start + index * 86400000, upper = Math.min(lower + 86400000, now.getTime());
    const date = chinaDay(new Date(lower));
    const dayTasks = tasks.filter(task => chinaDay(new Date(task.createdAt)) === date);
    const durations = dayTasks.filter(task => (task.status === "completed" || task.status === "failed") && task.durationMs !== null);
    const events: [number, number][] = [];
    for (const task of tasks) {
      let from: number, to: number;
      if (task.completedAt && task.durationMs !== null && task.durationMs > 0) {
        to = new Date(task.completedAt).getTime(); from = to - task.durationMs;
      } else if (task.status === "running") {
        from = new Date(task.createdAt).getTime(); to = now.getTime();
      } else continue;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= lower || from >= upper) continue;
      events.push([Math.max(from, lower), 1], [Math.min(to, upper), -1]);
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let active = 0, peak = 0;
    for (const [, delta] of events) { active += delta; peak = Math.max(peak, active); }
    return { date, label: date.slice(5), peak, tasks: dayTasks.length,
      responseSeconds: durations.length ? Math.round(durations.reduce((sum, task) => sum + task.durationMs!, 0) / durations.length / 100) / 10 : null };
  });
}

export function seafoodCategory(name: string): string {
  if (/鱼丸/.test(name)) return "连江手工鱼丸";
  if (/鲍鱼/.test(name)) return "连江鲍鱼";
  if (/丁香鱼/.test(name)) return "丁香鱼";
  if (/海带|紫菜/.test(name)) return "海带紫菜";
  return "其他海产";
}
