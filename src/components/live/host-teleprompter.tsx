/**
 * 中栏：直播画面占位 + 主播提词器（服务端组件）
 *
 * S6 的关键改动：**提词器不再是一段写死的脚本文案**。
 *
 * 旧版由 `TeleprompterSegment[]`（开场 / 卖点 / 异议 / 收单）拼成，看起来像
 * 一份脚本，实际上每个字都是 Mock 里手抄的 —— 它和「AI 分析了评论」毫无关系。
 * 任务书第二十五节要求提词器的内容**必须来自真实数据**，因此现在它由三块真实
 * 来源组合而成，任一块缺失都在界面上如实留空并给出原因：
 *
 * 1. **当前商品**（含 Product DNA 卖点）—— 直播总是围绕一件商品；
 * 2. **品牌语气**（Brand Profile）—— 决定话术该用什么口吻；
 * 3. **最新一条高优先级 AI 建议** —— 由 Live Agent 现场产出，随评论实时更新。
 */

import { CircleCheck, Mic, PlayCircle, Radio, Tags } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { LIVE_INTENT_META, LIVE_PRIORITY_META } from "@/lib/status-meta";
import type { LiveSession, LiveTeleprompterView } from "@/types";

interface HostTeleprompterProps {
  session: LiveSession;
  teleprompter: LiveTeleprompterView;
  showStage?: boolean;
}

/** 中栏：直播画面占位 + 主播提词器 */
export function HostTeleprompter({ session, teleprompter, showStage = true }: HostTeleprompterProps) {
  const latest = teleprompter.latestSuggestion;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 直播画面占位（本轮无真实推流） */}
      {showStage ? <div className="relative aspect-16/9 w-full overflow-hidden rounded-xl border border-border bg-gradient-to-br from-slate-800 via-slate-700 to-slate-900 shadow-card">
        <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(80%_60%_at_20%_10%,white,transparent_60%)]" />
        <div className="absolute top-3 left-3 flex items-center gap-2">
          {session.status === "live" ? (
            <Badge variant="danger" className="gap-1.5">
              <span className="size-1.5 animate-pulse-soft rounded-full bg-current" />
              直播中
            </Badge>
          ) : (
            <Badge variant="secondary">已结束</Badge>
          )}
          <span className="rounded-md bg-black/30 px-2 py-0.5 text-[11px] text-white tabular-nums backdrop-blur-sm">
            {session.durationText}
          </span>
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-black/60 to-transparent p-4">
          <div className="flex flex-col gap-0.5 text-white">
            <span className="text-[11px] text-white/70">当前讲解商品</span>
            <span className="text-[15px] font-semibold">
              {teleprompter.productName}
            </span>
          </div>
          <span className="rounded-md bg-white/15 px-2 py-1 text-[11px] text-white backdrop-blur-sm">
            彩排模式 · 未连接平台
          </span>
        </div>
      </div> : null}

      {/* 当前话术：最新一条高优先级 AI 建议（真实产出） */}
      <div className="rounded-xl border border-primary/25 bg-primary-soft/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Mic className="size-3.5 text-primary" />
          <span className="text-[12px] font-semibold text-primary">
            当前话术 · 来自最新高优先级问题
          </span>
          {latest ? (
            <span className="ml-auto inline-flex items-center gap-1.5">
              <Badge
                variant={LIVE_INTENT_META[latest.intent].tone}
                className="px-1.5 py-0 text-[10px]"
              >
                {LIVE_INTENT_META[latest.intent].label}
              </Badge>
              <Badge
                variant={LIVE_PRIORITY_META[latest.priority].tone}
                className="px-1.5 py-0 text-[10px]"
              >
                {LIVE_PRIORITY_META[latest.priority].label}
              </Badge>
            </span>
          ) : null}
        </div>
        <p className="mt-2 text-[14px] leading-6 font-medium">
          {latest
            ? latest.suggestedReply || latest.hostSuggestion
            : "暂无高优先级建议。录入一个模拟问题后，可在这里练习口播。"}
        </p>
        {latest ? (
          <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
            主播提示：{latest.hostSuggestion}
          </p>
        ) : null}
      </div>

      {/* 商品卖点 / 品牌语气：提词器的两块真实依据 */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-card p-3 shadow-card">
        <div className="flex flex-col gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
            <Tags className="size-3.5 text-primary" />
            商品核心卖点
          </span>
          {teleprompter.sellingPoints.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {teleprompter.sellingPoints.map((point) => (
                <li
                  key={point}
                  className="rounded-md border border-border bg-muted/50 px-2 py-1 text-[11px] leading-4"
                >
                  {point}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-warning/25 bg-warning/12 px-2.5 py-2 text-[11px] leading-4 text-warning">
              {teleprompter.dnaNotice ?? "商品尚未完成 AI 分析，营销建议依据较少。"}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
            <Radio className="size-3.5 text-primary" />
            品牌语气
          </span>
          {teleprompter.brandTone.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {teleprompter.brandTone.map((tone) => (
                <li
                  key={tone}
                  className="rounded-md border border-border bg-muted/50 px-2 py-1 text-[11px] leading-4"
                >
                  {tone}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-warning/25 bg-warning/12 px-2.5 py-2 text-[11px] leading-4 text-warning">
              {teleprompter.brandNotice ?? "尚未生成品牌档案，品牌语气能力减少。"}
            </p>
          )}
        </div>

        {/* 提词器说明：把「来源是真实的」这件事写在界面上 */}
        <div className="mt-auto flex items-start gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
          <PlayCircle className="mt-0.5 size-3 shrink-0" />
          <span>
            提词内容来自当前商品、商品理解、品牌档案与最新建议，
            <CircleCheck className="mx-0.5 inline size-3 text-success" />
            未经 AI 分析的评论不会出现在这里。
          </span>
        </div>
      </div>
    </div>
  );
}
