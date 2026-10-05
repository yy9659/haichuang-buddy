import type * as React from "react";
import { Brain, Check, TriangleAlert } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DashboardBusinessBrainState } from "@/services/dashboard";

export type BusinessBrainStatus = "idle" | "running" | "completed" | "error";

const RADIUS = 68;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 读取目标末尾由计划表单写入的商品、人群与渠道；旧目标保留原文。 */
function readGoalContext(goal: string | null) {
  if (!goal) return { summary: null, product: null, audience: null, channels: null };

  const match = goal.match(/（(?=[^）]*(?:主推商品：|目标用户：|渠道：))([^）]+)）$/);
  if (!match || match.index === undefined) {
    return { summary: goal, product: null, audience: null, channels: null };
  }

  const values = new Map<string, string>();
  for (const part of match[1].split("；")) {
    const separator = part.indexOf("：");
    if (separator > 0) values.set(part.slice(0, separator), part.slice(separator + 1).trim());
  }
  return {
    summary: goal.slice(0, match.index).trim() || goal,
    product: values.get("主推商品") || null,
    audience: values.get("目标用户") || null,
    channels: values.get("渠道") || null,
  };
}

function statusFromBrain(brain: DashboardBusinessBrainState): BusinessBrainStatus {
  if (brain.phase === "executing") return "running";
  if (brain.phase === "interrupted") return "error";
  if (brain.phase === "awaiting_confirmation") return "idle";
  if (brain.lastStatus === "completed") return "completed";
  if (brain.lastStatus === "failed" || brain.lastStatus === "partially_completed") return "error";
  return "idle";
}

/**
 * AI 经营大脑卡片（任务书 §20）。
 *
 * 只展示三样真实数据：当前状态、当前目标、按步数算出的执行进度。
 * 环形图比例 = 已完成步数 / 总步数 —— 不是「AI 大概完成了多少」的猜测，
 * 任务书 §12 禁止的正是后者。
 */
export function BusinessBrainCard({
  brain,
  status: statusOverride,
  progress: progressOverride,
  action,
}: {
  brain: DashboardBusinessBrainState;
  status?: BusinessBrainStatus;
  progress?: number;
  action?: React.ReactNode;
}) {
  const status = statusOverride ?? statusFromBrain(brain);
  const awaiting = status === "idle" && brain.phase === "awaiting_confirmation";
  const goal = readGoalContext(brain.goal);
  const hasGoalMeta = Boolean(goal.product || goal.audience || goal.channels);
  const recorded = brain.progress;
  const percent =
    progressOverride !== undefined && Number.isFinite(progressOverride)
      ? Math.round(Math.min(100, Math.max(0, progressOverride)))
      : recorded && recorded.total > 0
        ? Math.round((recorded.done / recorded.total) * 100)
        : status === "completed" ? 100 : null;
  const statusLabel =
    status === "running" ? "AI 正在调度中" :
      awaiting ? "等待确认计划" :
        status === "completed" ? "本轮已完成" :
          status === "error" ? brain.phase === "interrupted" ? "任务可能中断" : "任务需处理" :
            !brain.provider.usable ? "AI 服务暂不可用" :
              brain.provider.isMock ? "演示模式待命" : "AI 服务已连接";
  const coreCaption =
    status === "completed" ? "本轮工作已完成" :
      status === "running" ? "任务执行中" :
        awaiting ? "等待确认计划" :
          status === "error" ? "任务需处理" : "等待指令";

  return (
    <Card className="relative isolate flex h-full min-h-0 flex-col overflow-hidden border-white/10 bg-white/[0.05] shadow-md shadow-black/20">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-600 to-cyan-500" />

      <div className="flex min-h-56 flex-1 flex-col xl:min-h-0">
        <header className="relative flex flex-wrap items-start justify-between gap-2 px-4 pt-3.5 pb-2">
          <div className="flex items-start gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-300/10 text-cyan-300">
              <Brain className={cn("size-4.5", status === "running" && "motion-safe:animate-pulse")} aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold leading-5 text-white">{brain.name}</h2>
              <p className="mt-0.5 text-xs text-slate-400">{brain.role}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              status === "error" ? "border-rose-400/25 bg-rose-400/10 text-rose-200" :
                status === "completed" ? "border-blue-400/30 bg-blue-400/10 text-blue-200" :
                  "border-cyan-300/25 bg-cyan-300/10 text-cyan-100",
            )}>
              <span className={cn(
                "size-1.5 rounded-full",
                status === "error" ? "bg-rose-400" : status === "completed" ? "bg-blue-400" : "bg-cyan-300",
                status === "running" && "motion-safe:animate-pulse",
              )} />
              {statusLabel}
            </span>
            {action}
          </div>
        </header>

        {brain.phase === "interrupted" ? (
          <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs leading-5 text-rose-200">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>上一轮任务停在「执行中」且已超过 10 分钟，可在下方任务列表中重试。</span>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 items-center justify-center px-4 pt-3 pb-2">
          <div
            className="relative flex size-32 shrink-0 items-center justify-center"
            role={percent === null ? "img" : "progressbar"}
            aria-label={percent === null ? coreCaption : "经营任务完成进度"}
            aria-valuenow={percent ?? undefined}
            aria-valuemin={percent === null ? undefined : 0}
            aria-valuemax={percent === null ? undefined : 100}
          >
            <div aria-hidden="true" className="absolute inset-3 rounded-full bg-cyan-400/20 blur-2xl" />
            <svg viewBox="0 0 180 180" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
              <defs>
                <linearGradient id="brain-core-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#22d3ee" />
                  <stop offset="100%" stopColor="#3b82f6" />
                </linearGradient>
              </defs>
              <circle cx="90" cy="90" r={RADIUS} fill="none" stroke="#123653" strokeWidth="11" />
              {percent !== null ? (
                <circle cx="90" cy="90" r={RADIUS} fill="none" stroke="url(#brain-core-gradient)" strokeWidth="11" strokeLinecap="round"
                  strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
                  className="drop-shadow-[0_0_12px_rgba(6,182,212,0.5)] transition-[stroke-dashoffset] duration-700 ease-out" />
              ) : null}
            </svg>
            <div className="relative flex flex-col items-center text-center">
              <span className="text-3xl font-semibold leading-8 tracking-tight text-white tabular-nums">
                {percent === null ? "—" : percent}
                {percent === null ? null : <span className="ml-0.5 text-base text-cyan-200">%</span>}
              </span>
              <span className="mt-1 text-[11px] text-slate-300">{coreCaption}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 与两侧 grid-rows-2 的第二排同高；减去一半的 1rem 行间距。 */}
      <div className="flex flex-col gap-2 px-4 pt-2 pb-3 xl:basis-[calc(50%_-_0.5rem)] xl:shrink-0 xl:justify-between">
        <section className="w-full min-w-0 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2" aria-label="当前经营目标">
          <p className="text-xs font-semibold tracking-wide text-cyan-300">当前经营目标</p>
          <p className="mt-0.5 line-clamp-2 text-xs font-medium leading-4 text-slate-100" title={brain.goal ?? undefined}>
            {goal.summary ?? "已准备就绪，点击上方按钮制定目标"}
          </p>
          {hasGoalMeta ? (
            <dl className="mt-1.5 grid grid-cols-3 gap-2 border-t border-white/10 pt-1.5">
              {([
                ["主推商品", goal.product],
                ["目标人群", goal.audience],
                ["渠道", goal.channels],
              ] as const).map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-slate-400">{label}</dt>
                  <dd className="truncate text-xs font-medium text-cyan-100" title={value ?? undefined}>{value ?? "待选择"}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </section>

        <div className="relative w-full rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-1.5" aria-label="经营工作阶段">
          <div aria-hidden="true" className={cn(
            "absolute inset-x-[12.5%] top-4 h-px",
            status === "completed" ? "bg-blue-400/50" : "bg-cyan-400/20",
          )} />
          <ol className="relative grid grid-cols-4 gap-1">
            {brain.skills.map((skill, index) => {
              const done = status === "completed";
              const active = !done && status === "running" && index === 0;
              return (
                <li key={skill} className="flex min-w-0 flex-col items-center gap-1 text-center">
                  <span className={cn(
                    "flex size-5 items-center justify-center rounded-full border",
                    done ? "border-blue-400/50 bg-blue-400/15 text-blue-300" :
                      active ? "border-cyan-300/60 bg-cyan-400/20 text-cyan-200 motion-safe:animate-pulse" :
                        "border-white/15 bg-slate-800 text-slate-500",
                  )}>
                    {done ? <Check className="size-3" strokeWidth={2} aria-hidden="true" /> :
                      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
                  </span>
                  <span className={cn(
                    "truncate text-[11px] font-medium",
                    done ? "text-blue-300" : active ? "text-cyan-200" : "text-slate-500",
                  )}>{skill}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </Card>
  );
}
