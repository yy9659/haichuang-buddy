"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, CircleAlert, Clock3, Loader2, Radio } from "lucide-react";
import { commandArenaAction, fileArenaGapAction, getArenaMaterialAction, getArenaWorkspaceAction, startArenaAction } from "@/actions/live-arena";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { arenaMetrics, CHALLENGES, elapsedAt, FACT_LABELS } from "@/lib/live-arena/engine";
import { GOALS, LEVELS, PERSONAS, type ArenaConfig, type ArenaMaterial, type ArenaView, type FactKey, type Persona } from "@/lib/live-arena/types";
import type { Result } from "@/lib/result";
import { ArenaReview, ArenaTrend, timeLabel, VERDICT } from "./arena-evidence";
import { ArenaMedia } from "./arena-media";

type Workspace = Extract<Awaited<ReturnType<typeof getArenaWorkspaceAction>>, { ok: true }>["data"];
const DEFAULT_CONFIG: ArenaConfig = { goal: "mixed", level: "advanced", minutes: 3, personas: ["price", "quality", "buyer", "disruptor"] };
const STATUS = { running: "演练中", paused: "已暂停", ended: "已完成" };
const QUESTION_STATUS = { pending: "待回答", resolved: "已解决", unresolved: "未解决" };
const keys = Object.keys(FACT_LABELS) as FactKey[];
const personas = Object.keys(PERSONAS) as Persona[];
const panel = "rounded-2xl border border-border bg-card p-4 shadow-card min-w-0";
const input = "h-9 w-full rounded-xl border border-input bg-background px-3 text-sm";

export function ArenaWorkspace({ initial, preferredProductId, children }: {
  initial: Workspace;
  preferredProductId?: string;
  children?: ReactNode;
}) {
  const preferred = initial.products.find((item) => item.id === preferredProductId)?.id;
  const [workspace, setWorkspace] = useState(initial);
  const [state, setState] = useState(initial.state);
  const [prep, setPrep] = useState(!initial.state || (initial.state.status === "ended" && !!preferred));
  const [productId, setProductId] = useState(preferred ?? initial.state?.material.productId ?? initial.products[0]?.id ?? "");
  const [config, setConfig] = useState<ArenaConfig>(DEFAULT_CONFIG);
  const [parent, setParent] = useState<ArenaView | null>(null);
  const [material, setMaterial] = useState<ArenaMaterial | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshMaterial, setRefreshMaterial] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [selected, setSelected] = useState(initial.state?.draft?.questionId ?? "");
  const [draft, setDraft] = useState(initial.state?.draft?.text ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [refreshing, setRefreshing] = useState(false);
  const startId = useRef<string | null>(null);
  const turn = useRef<{ id: string; questionId: string; text: string } | null>(null);
  const latest = useRef(initial.state);
  const syncBusy = useRef(false);
  const answerRequest = useRef<AbortController | null>(null);
  useEffect(() => () => answerRequest.current?.abort(), []);

  function accept(next: ArenaView, replace = false) {
    const previous = latest.current;
    if (!replace && previous && (next.id !== previous.id || next.version < previous.version)) return;
    latest.current = next;
    const request = turn.current;
    if (request && next.answers.some((a) => a.id === request.id)) {
      setDraft("");
      turn.current = null;
    }
    setState(next);
    if (replace || previous?.status !== next.status) {
      setWorkspace((current) => {
        const summary = { id: next.id, name: next.material.productName, status: next.status, createdAt: next.createdAt, score: next.report?.score ?? null };
        const exists = current.history.some((item) => item.id === next.id);
        return { ...current, history: exists ? current.history.map((item) => item.id === next.id ? summary : item) : [summary, ...current.history].slice(0, 12) };
      });
    }
  }

  useEffect(() => {
    if (!prep || !productId) return;
    let alive = true;
    setLoading(true);
    setMaterial(null);
    setConfirmed(false);
    startId.current = null;
    void getArenaMaterialAction(productId).then((r) => {
      if (!alive) return;
      if (r.ok) setMaterial(r.data);
      else setMessage(r.error.message);
    }).catch(() => { if (alive) setMessage("未能载入商品资料，请重试。"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [prep, productId, refreshMaterial]);

  useEffect(() => {
    if (prep || !state || state.status === "ended") return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [prep, state?.id, state?.status]); // Only changes with the displayed session and lifecycle.

  const remaining = state ? Math.max(0, state.config.minutes * 60_000 - elapsedAt(state, now)) : 0;
  const exhausted = !!state && state.status === "running" && remaining === 0;
  useEffect(() => {
    if (prep || !state || state.status === "ended") return;
    const sessionId = state.id;
    let alive = true;
    const sync = async () => {
      if (syncBusy.current) return;
      syncBusy.current = true;
      try {
        const result = await commandArenaAction(sessionId, "sync");
        if (!alive) return;
        if (result.ok) accept(result.data);
        else setMessage(result.error.message);
      } catch {
        if (alive) setMessage("网络中断，已保存的进度不会丢失。可刷新或继续重试。");
      } finally { syncBusy.current = false; }
    };
    if (exhausted) void sync();
    const timer = window.setInterval(() => void sync(), 6000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [prep, state?.id, state?.status, exhausted]);

  const pending = state?.questions.filter((q) => q.status === "pending") ?? [];
  const selection = pending.find((q) => q.id === selected);
  const orphanedDraft = !!draft.trim() && !!selected && !selection;
  const current = orphanedDraft ? undefined : selection ?? pending[0];
  const active = state?.status === "running" && !exhausted;
  const analyzing = !!state?.busyUntil && state.busyUntil > now;
  const mediaActive = !!active && !busy && !submitting && !analyzing && !!current;
  const isRetry = !!state?.draft?.error && state.draft.questionId === current?.id;

  async function openSession(id?: string) {
    setRefreshing(true);
    setMessage("");
    try {
      const r = await getArenaWorkspaceAction(id);
      if (!r.ok) { setMessage(r.error.message); return; }
      setWorkspace(r.data);
      if (r.data.state) {
        accept(r.data.state, true);
        setPrep(false);
        setSelected(r.data.state.draft?.questionId ?? "");
        setDraft(r.data.state.draft?.text ?? "");
      }
    } catch { setMessage("未能读取训练记录，请检查网络后重试。"); }
    finally { setRefreshing(false); }
  }

  function beginPrep(previous: ArenaView | null) {
    setParent(previous);
    const nextProduct = previous?.material.productId ?? (workspace.products.some((p) => p.id === productId) ? productId : workspace.products[0]?.id ?? "");
    setProductId(nextProduct);
    setConfig(previous?.config ?? DEFAULT_CONFIG);
    setConfirmed(false);
    setMessage("");
    setRefreshMaterial((x) => x + 1);
    setPrep(true);
  }

  async function start() {
    if (!material || !confirmed || busy) return;
    setBusy(true);
    setMessage("");
    startId.current ??= crypto.randomUUID();
    try {
      const r = await startArenaAction({ id: startId.current, productId, config, confirmed, materialVersion: material.version, parentId: parent?.id });
      if (!r.ok) { setMessage(r.error.message); return; }
      setWorkspace((w) => ({ ...w, parent, stale: false }));
      accept(r.data, true);
      setSelected("");
      setDraft("");
      turn.current = null;
      setPrep(false);
      setNow(Date.now());
    } catch { setMessage("开始请求未确认。再次点击会复用同一请求编号。"); }
    finally { setBusy(false); }
  }

  async function command(which: "pause" | "resume" | "end" | "cancel") {
    if (!state || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const r = await commandArenaAction(state.id, which);
      if (r.ok) {
        accept(r.data);
        if (!r.data.busyUntil) answerRequest.current?.abort();
      }
      else setMessage(r.error.message);
    } catch { setMessage("操作结果未确认，请重试或刷新场次。"); }
    finally { setBusy(false); }
  }

  async function submit(value = draft, questionId = current?.id) {
    if (!state || !questionId || !active || analyzing || answerRequest.current || value.trim().length < 2) return;
    const controller = new AbortController();
    answerRequest.current = controller;
    setSubmitting(true);
    setSelected(questionId);
    setMessage("");
    const text = value.trim();
    if (turn.current?.text !== text || turn.current.questionId !== questionId) turn.current = { id: crypto.randomUUID(), text, questionId };
    const request = turn.current;
    try {
      const response = await fetch("/api/live-arena/answer", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ id: state.id, turnId: request.id, questionId, text }),
      });
      const r = await response.json() as Result<ArenaView>;
      if (!r.ok) { setMessage(r.error.message); return; }
      accept(r.data);
    } catch { if (!controller.signal.aborted) setMessage("连接中断，保留了输入。可重试同一条回答或刷新恢复。"); }
    finally { answerRequest.current = null; setSubmitting(false); }
  }

  async function file(questionId: string) {
    if (!state || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await fileArenaGapAction(state.id, questionId);
      if (result.ok) accept(result.data);
      else setMessage(result.error.message);
    } catch { setMessage("暂时无法记录缺口，请重试。"); }
    finally { setBusy(false); }
  }

  return <div className="space-y-4">
    <header className={panel + " flex flex-wrap items-center justify-between gap-3"}>
      <div><p className="text-xs font-medium tracking-wider text-primary">直播导演</p><h1 className="mt-1 text-xl font-semibold">AI 实战演练</h1>
        <p className="mt-1 text-sm text-muted-foreground">用商品资料回应模拟观众。只记录训练文字，不连接真实直播。</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="soft">{workspace.provider.isMock ? "规则演示 · 不调用模型" : workspace.provider.usable ? "语义判断 + 规则核验" : "模型未就绪"}</Badge>
        <Button variant="outline" size="sm" disabled={refreshing || busy || submitting} onClick={() => void openSession()}>{refreshing ? "载入中…" : "恢复最近场次"}</Button>
      </div>
    </header>

    {children}

    {message && <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"><CircleAlert size={17} />{message}</div>}

    {prep ? <section className={panel}>
      <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-semibold">{parent?.report ? "专项复练 · " + CHALLENGES[parent.report.focus].title : "智能备播"}</h2>{state && <Button variant="outline" size="sm" onClick={() => setPrep(false)}>返回训练记录</Button>}</div>
      {workspace.products.length ? <>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1 text-sm">演练商品<Select disabled={!!parent || busy} value={productId} onChange={(e) => { setMessage(""); setProductId(e.target.value); }}>{workspace.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
          <label className="space-y-1 text-sm">训练目标<Select disabled={!!parent || busy} value={config.goal} onChange={(e) => { startId.current = null; setConfig({ ...config, goal: e.target.value as ArenaConfig["goal"] }); }}>{Object.entries(GOALS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></label>
          <label className="space-y-1 text-sm">难度<Select disabled={!!parent || busy} value={config.level} onChange={(e) => { startId.current = null; setConfig({ ...config, level: e.target.value as ArenaConfig["level"] }); }}>{Object.entries(LEVELS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></label>
          <label className="space-y-1 text-sm">时长（分钟）<input className={input} type="number" min={1} max={10} disabled={!!parent || busy} value={config.minutes || ""} onChange={(e) => { startId.current = null; setConfig({ ...config, minutes: Number(e.target.value) }); }} /></label>
        </div>
        <fieldset className="my-4 flex flex-wrap gap-2" disabled={!!parent || busy}>
          <legend className="mb-2 text-sm font-medium">模拟观众组合</legend>
          {personas.map((id) => <label key={id} className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm"><input type="checkbox" checked={config.personas.includes(id)} onChange={(e) => { startId.current = null; setConfig({ ...config, personas: e.target.checked ? [...config.personas, id] : config.personas.filter((x) => x !== id) }); }} />{PERSONAS[id].label}</label>)}
        </fieldset>
        {loading ? <p role="status" className="text-sm text-muted-foreground">正在整理练习依据…</p> : material ? <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">本场事实依据</h3><Button size="sm" variant="outline" disabled={busy} onClick={() => setRefreshMaterial((n) => n + 1)}>重新载入资料</Button></div>
          <dl className="grid gap-2 sm:grid-cols-2">
            {keys.map((key) => {
              const facts = material.facts.filter((f) => f.key === key);
              return <div key={key} className="rounded-xl bg-muted/45 p-3"><dt className="font-medium text-sm">{FACT_LABELS[key]}</dt>
                <dd className="mt-1 break-words text-xs leading-relaxed">{facts.length ? facts.map((f) => <div key={f.id}><Link className="text-primary" href={f.href}>{f.source}</Link> · {f.text}</div>) : <span className="text-muted-foreground">待确认，演练中不要承诺</span>}</dd></div>;
            })}
          </dl>
          <details className="rounded-xl border border-border p-3 text-sm"><summary className="cursor-pointer">口播参考、品牌表达与商品卖点</summary>
            <p className="mt-2 text-muted-foreground">品牌表达：{material.brandTone.join("、") || "暂无已确认档案"}</p>
            <p className="mt-1 text-muted-foreground">已确认卖点：{material.sellingPoints.join("、") || "暂无经确认的商品卖点"}</p>
            <p className="mt-2 whitespace-pre-wrap">{material.script ? `${material.scriptTitle}（参考，不作为事实）：\n${material.script}` : "未找到已有口播稿，可直接即兴练习。"}</p>
          </details>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我已核对本场资料，缺失项不作承诺。</label>
          {!workspace.provider.isMock && <p className="text-xs text-muted-foreground">提交回答时，当前问题、相关资料和文字片段将由已配置的模型服务核验。</p>}
        </div> : <Button variant="outline" size="sm" onClick={() => setRefreshMaterial((n) => n + 1)}>重试加载资料</Button>}
        <Button className="mt-4" disabled={busy || loading || !confirmed || !material || !config.personas.length || config.minutes < 1 || config.minutes > 10 || !Number.isInteger(config.minutes)} onClick={() => void start()}>{busy ? "正在开始…" : "开始演练"}</Button>
      </> : <p className="text-sm text-muted-foreground">还没有可训练的商品。<Link href="/products" className="ml-2 text-primary underline">到商品中心添加</Link></p>}
    </section> : state && <>
      <section className={panel + " flex flex-wrap items-center justify-between gap-3"}>
        <div><div className="flex flex-wrap items-center gap-2"><Radio size={17} className="text-primary" /><h2 className="font-semibold">{state.material.productName}</h2><Badge variant="soft">{STATUS[state.status]}</Badge></div>
          <p className="mt-1 text-xs text-muted-foreground">{GOALS[state.config.goal]} · {LEVELS[state.config.level]} · {state.config.personas.length} 个模拟角色</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {state.status !== "ended" ? <>
            <span className="flex items-center gap-1 font-mono text-sm"><Clock3 size={15} />{timeLabel(remaining)}</span>
            <Button variant="outline" size="sm" disabled={busy || exhausted} onClick={() => void command(state.status === "paused" ? "resume" : "pause")}>{state.status === "paused" ? "继续" : "暂停"}</Button>
            <Button size="sm" disabled={busy} onClick={() => void command("end")}>结束并复盘</Button>
          </> : <Button size="sm" variant="outline" onClick={() => beginPrep(null)}>新建演练</Button>}
        </div>
      </section>

      {state.status !== "ended" ? <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Object.entries({ "模拟认可度": arenaMetrics(state).trust + " / 100", "有效回应率": arenaMetrics(state).responseRate + "%", "未解决问题": arenaMetrics(state).open, "当前挑战": current ? CHALLENGES[current.challenge].title : "本轮题目已处理" }).map(([key, value]) => <div key={key} className={panel}><p className="text-xs text-muted-foreground">{key}</p><p className="mt-1 font-semibold tabular-nums">{value}</p></div>)}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <section className={panel + " space-y-3"}>
            <h3 className="font-semibold">镜头与口播</h3>
            <ArenaMedia key={state.id} active={mediaActive} questionId={current?.id} onFinal={(text) => {
              if (!current) return;
              setSelected(current.id);
              setDraft((value) => [value, text].filter(Boolean).join(" ").slice(0, 700));
            }} />
            {current ? <label className="block space-y-1 text-sm"><span>回答 {current.id.toUpperCase()} · {PERSONAS[current.persona].label}</span><Textarea maxLength={700} rows={3} placeholder="逐条回应当前问题，或用语音转写后编辑" value={draft} disabled={!active || submitting || analyzing} onChange={(e) => { setSelected(current.id); setDraft(e.target.value); }} /></label> : orphanedDraft ? <div className="space-y-2">
              <p className="text-sm text-muted-foreground">这段文字绑定的问题已在另一处处理。可复制留存，不会转交给其他题。</p>
              <Textarea aria-label="未提交口播" readOnly value={draft} />
              <Button variant="outline" size="sm" onClick={() => { setDraft(""); setSelected(""); }}>清空并继续</Button>
            </div> : <p className="text-sm text-muted-foreground">目前没有待答问题，可以结束演练并查看复盘。</p>}
            {state.draft?.error && <p role="status" className="text-sm text-destructive">{state.draft.error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button disabled={!current || !active || analyzing || submitting || draft.trim().length < 2} onClick={() => void submit()}>{analyzing || submitting ? <><Loader2 className="animate-spin" />核验中</> : "提交这条回答"}</Button>
              {analyzing || submitting ? <Button variant="outline" disabled={busy} onClick={() => void command("cancel")}>取消分析</Button> : null}
              {isRetry && state.draft && <Button variant="outline" disabled={!active || submitting || analyzing} onClick={() => { const saved = state.draft!; setDraft(saved.text); void submit(saved.text, saved.questionId); }}>重试已保存口播</Button>}
            </div>
          </section>
          <section className={panel + " space-y-3"}>
            <h3 className="font-semibold">模拟观众 <span className="text-xs font-normal text-muted-foreground">按题关联回答</span></h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {state.audiences.map((a) => <div key={a.persona} className="rounded-xl bg-muted/45 p-2 text-xs"><strong>{PERSONAS[a.persona].label}</strong><p className="mt-1 text-muted-foreground">模拟认可 {a.trust} · 兴趣 {a.interest} · 已解决 {a.resolved.length}</p></div>)}
            </div>
            <ul aria-label="模拟弹幕" className="max-h-[410px] space-y-2 overflow-y-auto">
              {[...state.questions].reverse().map((q) => {
                const answer = state.answers.find((a) => a.questionId === q.id);
                return <li key={q.id} className={"rounded-xl border p-3 " + (q.id === current?.id ? "border-primary bg-primary/5" : "border-border")}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{q.id.toUpperCase()} · {PERSONAS[q.persona].label}</span><Badge variant="soft">{QUESTION_STATUS[q.status]}</Badge>{q.depth > 0 && <span>追问</span>}</div>
                  <p className="mt-1 text-sm">{q.text}</p><p className="mt-1 text-xs text-muted-foreground">{q.reason} · 考查：{CHALLENGES[q.challenge].ability}</p>
                  <p className="mt-1 text-xs text-muted-foreground">预期核对：{q.focus.map((key) => FACT_LABELS[key]).join("、")}</p>
                  {answer && <p className="mt-2 text-xs">{VERDICT[answer.check.verdict]}{answer.check.risks.length ? " · 待核：" + answer.check.risks.join("、") : ""}</p>}
                  {q.status === "pending" && q.id !== current?.id && <Button variant="outline" size="sm" className="mt-2" disabled={submitting || analyzing || !!draft.trim()} onClick={() => setSelected(q.id)}>回答此题</Button>}
                </li>;
              })}
            </ul>
            <p className="text-xs text-muted-foreground">有未提交文字时不会切换问题，避免把口播挂到另一条弹幕。</p>
          </section>
        </div>
        <ArenaTrend state={state} />
      </> : <ArenaReview state={state} parent={workspace.parent} stale={workspace.stale} busy={busy} onPractice={() => beginPrep(state)} onFile={(questionId) => void file(questionId)} />}
    </>}

    {workspace.history.length > 0 && <details className={panel}><summary className="cursor-pointer text-sm font-medium"><Activity className="mr-2 inline size-4" />历史训练</summary>
      <ul className="mt-2 space-y-2">{workspace.history.map((session) => <li key={session.id}><button type="button" disabled={refreshing || busy || submitting} className="text-left text-sm text-primary hover:underline disabled:opacity-50" onClick={() => void openSession(session.id)}>{session.name} · {new Date(session.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · {STATUS[session.status]}{session.score !== null && ` · ${session.score} 分`}</button></li>)}</ul>
    </details>}
  </div>;
}
