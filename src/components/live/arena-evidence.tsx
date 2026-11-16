"use client";

import Link from "next/link";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { CHALLENGES, FACT_LABELS } from "@/lib/live-arena/engine";
import { compareArenaChallenge } from "@/lib/live-arena/report";
import type { ArenaView } from "@/lib/live-arena/types";

export const VERDICT = { resolved: "回应到位", partial: "部分回应", off_topic: "未切题", unsupported: "事实待核" };
export function timeLabel(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ArenaTrend({ state }: { state: ArenaView }) {
  const points = state.events.map((e, i) => ({ ...e, index: i + 1, time: timeLabel(e.at) }));
  return <section className="min-w-0 rounded-2xl border border-border bg-card p-4">
    <h3 className="mb-1 font-semibold">训练趋势 <span className="ml-2 text-xs text-muted-foreground">模拟估计</span></h3>
    <p className="text-xs text-muted-foreground">每个点对应一次提问、回应或操作；横轴为事件次序。</p>
    <div className="mt-3 h-[160px] min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points}>
          <CartesianGrid opacity={0.18} vertical={false} />
          <XAxis dataKey="index" fontSize={10} />
          <YAxis domain={[0, 100]} width={30} fontSize={10} />
          <Tooltip content={({ active, payload }) => {
            const event = payload?.[0]?.payload as typeof points[number] | undefined;
            return active && event ? <div className="max-w-56 rounded-lg border border-border bg-card p-2 text-xs shadow-lg">
              <p>{event.time} · {event.label}</p><p>模拟认可 {event.trust} · 有效回应 {event.responseRate}%</p>
            </div> : null;
          }} />
          <Line dataKey="trust" name="模拟认可" stroke="#0ea5e9" strokeWidth={2} isAnimationActive={false} />
          <Line dataKey="responseRate" name="有效回应率" stroke="#22c55e" strokeWidth={2} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>🔹 模拟认可度</span><span>● 有效回应率</span></div>
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer">查看关键事件（{points.length}）</summary>
      <ol className="mt-2 max-h-52 space-y-2 overflow-auto text-xs">
        {points.map((e) => <li key={e.index}><span className="mr-2 tabular-nums text-muted-foreground">{e.time}</span>{e.label}{e.questionId ? ` · ${e.questionId.toUpperCase()}` : ""}</li>)}
      </ol>
    </details>
  </section>;
}

function AnswerTimeline({ state }: { state: ArenaView }) {
  return <ol className="space-y-2">
    {state.questions.map((question) => {
      const answer = state.answers.find((a) => a.questionId === question.id);
      const facts = state.material.facts.filter((f) => answer?.check.cited.includes(f.id));
      return <li key={question.id} className="rounded-xl border border-border px-3 py-2">
        <details>
          <summary className="cursor-pointer text-sm"><span className="mr-2 text-xs text-muted-foreground">{timeLabel(question.askedAt)}</span>{question.id.toUpperCase()} · {CHALLENGES[question.challenge].title} · {answer ? VERDICT[answer.check.verdict] : "没有计分回答"}</summary>
          <div className="mt-2 space-y-1 text-sm">
            <p>{question.text}</p>
            {answer && <blockquote className="rounded-lg bg-muted/60 p-2 whitespace-pre-wrap">{answer.text}</blockquote>}
            {answer?.check.quote && answer.check.quote !== answer.text && <p>核验片段：「{answer.check.quote}」</p>}
            {answer?.check.risks.length ? <p className="text-destructive">待核：「{answer.check.risks.join("」「")}」</p> : null}
            {facts.length ? <ul>{facts.map((f) => <li key={f.id}><Link className="text-primary underline" href={f.href}>{f.source}</Link> · {f.text}</li>)}</ul> : <p className="text-xs text-muted-foreground">没有匹配到可引用的档案片段。</p>}
            {answer && <p className="text-xs text-muted-foreground">{answer.check.mode === "rules" ? "规则演示" : "语义 + 规则"} · {Math.round(answer.latencyMs / 1000)} 秒内提交</p>}
          </div>
        </details>
      </li>;
    })}
  </ol>;
}

export function ArenaReview({ state, parent, stale, onPractice, onFile, busy }: {
  state: ArenaView; parent: ArenaView | null; stale: boolean; busy: boolean; onPractice: () => void; onFile: (id: string) => void;
}) {
  const report = state.report;
  if (!report) return null;
  const pair = parent?.report && compareArenaChallenge(parent, state, parent.report.focus);
  const quality = ["unsupported", "off_topic", "partial", "resolved"];
  const before = pair && pair.before.answer;
  const after = pair && pair.after.answer;
  const comparableMode = !!before && !!after && before.check.mode === after.check.mode;
  const better = before && after && comparableMode ? quality.indexOf(after.check.verdict) - quality.indexOf(before.check.verdict) : null;
  return <div className="grid gap-4 xl:grid-cols-2">
    <section className="rounded-2xl border border-border bg-card p-5">
      <p className="text-sm text-muted-foreground">文字复盘 · {state.material.productName}</p>
      <h2 className="my-2 text-3xl font-semibold tabular-nums">{report.score ?? "无法评估"} {report.score !== null && <span className="text-sm font-normal text-muted-foreground">/ 100</span>}</h2>
      {state.answers.some((a) => a.check.mode === "rules") && <p className="mb-3 text-xs text-muted-foreground">含规则演示结果，不等同于模型或人工评审。</p>}
      {stale && <p className="mb-3 rounded-lg border border-amber-500/30 p-2 text-sm">当前商品资料与训练快照不同，报告仅代表当时的资料。</p>}
      <dl className="space-y-3">
        {report.dimensions.map((d) => <div key={d.key} className="rounded-xl bg-muted/35 p-3">
          <dt className="flex justify-between gap-2 text-sm font-medium"><span>{d.label} · {d.weight}%</span><span>{d.score ?? "无法评估"}</span></dt>
          {d.score !== null && <div className="my-1.5 h-1.5 rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: d.score + "%" }} /></div>}
          <dd className="mt-1 text-xs leading-5 text-muted-foreground">{d.basis}</dd>
        </div>)}
      </dl>
      <div className="mt-4 space-y-2 text-sm">
        {report.improvements.map((s) => <p key={s}>{s}</p>)}
        <div className="flex flex-wrap gap-3 pt-2">
          <Button onClick={onPractice}>根据弱项再次训练</Button>
          <Link className="my-auto text-primary underline" href={`/content?productId=${encodeURIComponent(state.material.productId)}&platform=douyin&format=voiceover&angle=${report.focus === "price" || report.focus === "intro" ? "selling-point" : "trust"}`}>在推广素材完善口播</Link>
        </div>
      </div>
    </section>
    <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
      {pair && <div className="space-y-2 rounded-xl border border-border p-3 text-sm">
        <h3 className="font-semibold">同类首问对照 · {CHALLENGES[parent!.report!.focus].title}</h3>
        <p>上一场 {parent!.report!.score ?? "—"} · 本场 {report.score ?? "—"}（整场题量可能不同）</p>
        {([["上次", before], ["本次", after]] as const).map(([label, answer]) => <div key={label} className="rounded-lg bg-muted/40 p-2">
          <strong>{label} · {answer ? VERDICT[answer.check.verdict] : "无评分回答"}</strong>
          {answer && <p className="mt-1 whitespace-pre-wrap">{answer.text}</p>}
          {answer && <p className="mt-1 text-xs text-muted-foreground">已回应要点：{answer.check.covered.map((field) => FACT_LABELS[field]).join("、") || "暂无"}{answer.check.risks.length > 0 && " · 仍有待核承诺"}</p>}
        </div>)}
        <p>{!pair.sameFacts ? "资料已更新，只并排展示，不推断进步。" : better === null ? "有一场缺少可比较的回答，或两场使用了不同核验方式。" : better > 0 ? "同类首问回应有所改善；仍以引用和待核项为准。" : better < 0 ? "本次首问回应仍需加强。" : "同类首问的回应等级未改变。"}</p>
      </div>}
      <h3 className="font-semibold">问题与证据时间轴</h3>
      <AnswerTimeline state={state} />
      {report.gaps.length > 0 && <div className="space-y-2">
        <h3 className="font-semibold">需要补充的商品资料</h3>
        {report.gaps.map((gap) => <div key={gap.questionId} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{gap.questionId.toUpperCase()} · {gap.keys.map((key) => FACT_LABELS[key]).join("、")}</span>
          <Button variant="outline" size="sm" disabled={busy || !!state.filedGaps?.[gap.questionId]} onClick={() => onFile(gap.questionId)}>{state.filedGaps?.[gap.questionId] === "filed" ? "已记入答疑缺口" : "确认记录待核项"}</Button>
        </div>)}
        <Link className="text-sm text-primary underline" href="/customer-service">到答疑助手补充知识</Link>
      </div>}
    </section>
  </div>;
}
