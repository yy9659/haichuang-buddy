import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AdminPanel({ title, eyebrow, action, children, className }: { title: string; eyebrow?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={cn("relative min-w-0 overflow-hidden rounded-2xl border border-cyan-400/15 bg-gradient-to-br from-[#102e49]/95 to-[#091e35]/95 shadow-[0_10px_35px_rgba(0,0,0,0.15)]", className)}>
    <div aria-hidden className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" />
    <header className="flex min-h-16 items-center justify-between gap-3 border-b border-white/6 px-5 py-3">
      <div><p className="text-[9px] font-medium tracking-[0.22em] text-cyan-400/60 uppercase">{eyebrow}</p><h2 className="mt-0.5 flex items-center gap-2 text-sm font-semibold text-slate-100"><span className="h-3.5 w-0.5 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee]" />{title}</h2></div>{action}
    </header><div className="p-5">{children}</div>
  </section>;
}

export const AGENT_LABELS: Record<string, string> = { product_agent: "商品经理", brand_agent: "品牌经理", content_agent: "内容运营", live_agent: "直播导演", customer_service_agent: "智能客服", analytics_agent: "经营分析师", business_brain: "经营调度", poster_design: "海报设计" };
export const TASK_LABELS: Record<string, string> = { completed: "成功", failed: "失败", running: "执行中", queued: "等待中", skipped: "已跳过" };
export function TaskStatus({ status }: { status: string }) {
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px]", status === "failed" ? "border-rose-400/25 bg-rose-400/10 text-rose-300" : status === "completed" ? "border-blue-400/25 bg-blue-400/10 text-blue-300" : status === "running" ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200" : "border-white/10 bg-white/5 text-slate-400")}><span className={cn("size-1.5 rounded-full bg-current", status === "running" && "motion-safe:animate-pulse")} />{TASK_LABELS[status] ?? status}</span>;
}
export function taskDuration(ms: number | null) { return ms === null ? "—" : `${(ms / 1000).toFixed(1)} 秒`; }
export function adminTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
