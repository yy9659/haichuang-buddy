import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AdminPanel({ title, eyebrow, action, children, className }: { title: string; eyebrow?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={cn("relative min-w-0 overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-white/80 shadow-card backdrop-blur-xl dark:border-cyan-400/15 dark:bg-gradient-to-br dark:from-[#102e49]/95 dark:to-[#091e35]/95 dark:shadow-[0_10px_35px_rgba(0,0,0,0.15)] dark:backdrop-blur-none", className)}>
    <div aria-hidden className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent dark:via-cyan-300/60" />
    <header className="flex min-h-16 items-center justify-between gap-3 border-b border-slate-900/8 px-5 py-3 dark:border-white/6">
      <div><p className="text-[9px] font-medium tracking-[0.22em] text-cyan-700/70 uppercase dark:text-cyan-400/60">{eyebrow}</p><h2 className="mt-0.5 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100"><span className="h-3.5 w-0.5 rounded-full bg-cyan-500 shadow-[0_0_8px_#22d3ee] dark:bg-cyan-400" />{title}</h2></div>{action}
    </header><div className="p-5">{children}</div>
  </section>;
}

export const AGENT_LABELS: Record<string, string> = { product_agent: "商品经理", brand_agent: "品牌经理", content_agent: "内容运营", live_agent: "直播导演", customer_service_agent: "智能客服", analytics_agent: "经营分析师", business_brain: "经营调度", poster_design: "海报设计" };
export const TASK_LABELS: Record<string, string> = { completed: "成功", failed: "失败", running: "执行中", queued: "等待中", skipped: "已跳过" };
export function TaskStatus({ status }: { status: string }) {
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px]", status === "failed" ? "border-rose-600/25 bg-rose-600/10 text-rose-700 dark:border-rose-400/25 dark:bg-rose-400/10 dark:text-rose-300" : status === "completed" ? "border-blue-600/25 bg-blue-600/10 text-blue-700 dark:border-blue-400/25 dark:bg-blue-400/10 dark:text-blue-300" : status === "running" ? "border-cyan-600/30 bg-cyan-600/10 text-cyan-700 dark:border-cyan-400/30 dark:bg-cyan-400/10 dark:text-cyan-200" : "border-slate-900/10 bg-slate-900/5 text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400")}><span className={cn("size-1.5 rounded-full bg-current", status === "running" && "motion-safe:animate-pulse")} />{TASK_LABELS[status] ?? status}</span>;
}
export function taskDuration(ms: number | null) { return ms === null ? "—" : `${(ms / 1000).toFixed(1)} 秒`; }
export function adminTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
