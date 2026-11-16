import {
  PERSONAS, type ArenaAnswer, type ArenaCheck, type ArenaConfig, type ArenaEvent,
  type ArenaMaterial, type ArenaQuestion, type ArenaState, type Challenge, type FactKey, type Persona,
} from "./types";
import { buildArenaReport } from "./report";

export const FACT_LABELS: Record<FactKey, string> = {
  price: "价格与计价单位", spec: "规格", origin: "产地", stock: "库存", storage: "保存方式",
  shelf: "保质期", logistics: "冷链与发货", refund: "售后政策",
};
export const CHALLENGES: Record<Challenge, { title: string; persona: Persona; keys: FactKey[]; prompt: string; ability: string }> = {
  intro: { title: "开场介绍", persona: "buyer", keys: ["spec", "origin"], prompt: "第一次看到这款商品，它的规格和产地分别是什么？", ability: "准确介绍商品" },
  price: { title: "价格与差异", persona: "price", keys: ["spec", "price"], prompt: "同类商品看起来更便宜，你家这个价格贵在哪里？能说下规格和一份多少钱吗？", ability: "用可核对的规格与计价解释差异，不臆测竞品" },
  origin: { title: "产地与规格", persona: "quality", keys: ["origin", "spec"], prompt: "这款来自哪里？实际每份规格是多少？", ability: "区分产品档案与宣传说法" },
  cold: { title: "冷链配送", persona: "quality", keys: ["logistics"], prompt: "怎么发货？运输中的冷链和送达时间能确定吗？", ability: "按已确认政策说明；未确认就承认缺资料" },
  storage: { title: "保质期与食品安全", persona: "quality", keys: ["storage", "shelf"], prompt: "收到之后怎么保存、能放多久？请按商品资料说。", ability: "说明保存条件及有效期限，不承诺未经核实的认证" },
  refund: { title: "售后纠纷", persona: "buyer", keys: ["refund"], prompt: "如果收到后发现包装破损，应该怎么处理？", ability: "说明已确认的售后流程与边界" },
  rush: { title: "连续提问", persona: "disruptor", keys: ["stock", "logistics"], prompt: "还有货吗？能不能先说库存，再说发货怎么确认？", ability: "按顺序逐题回应，避免冲动承诺" },
};
const TARGET: Record<ArenaConfig["goal"], Challenge[]> = {
  intro: ["intro", "storage", "price", "origin", "cold", "refund", "rush"],
  price: ["price", "cold", "refund", "origin", "storage", "intro", "rush"],
  quality: ["cold", "origin", "storage", "price", "refund", "intro", "rush"],
  service: ["refund", "cold", "storage", "price", "origin", "intro", "rush"],
  mixed: ["price", "cold", "refund", "storage", "origin", "rush", "intro"],
};
const PREFER: Record<Persona, Challenge[]> = {
  price: ["price", "intro"], quality: ["cold", "origin", "storage"],
  buyer: ["refund", "intro", "cold"], disruptor: ["rush", "price", "refund"],
};
export const MAX_QUESTIONS = 16;

export function elapsedAt(state: Pick<ArenaState, "config" | "elapsed" | "runningSince">, now: number) {
  return Math.min(state.config.minutes * 60_000, state.elapsed + (state.runningSince === null ? 0 : Math.max(0, now - state.runningSince)));
}

export function arenaMetrics(state: Pick<ArenaState, "audiences" | "questions" | "answers">) {
  return {
    trust: Math.round(state.audiences.reduce((n, a) => n + a.trust, 0) / state.audiences.length),
    responseRate: state.questions.length ? Math.round(100 * state.answers.filter((a) => a.check.verdict === "resolved" || a.check.verdict === "partial").length / state.questions.length) : 0,
    open: state.questions.filter((q) => q.status !== "resolved").length,
  };
}

function event(state: ArenaState, at: number, kind: ArenaEvent["kind"], label: string, questionId?: string) {
  // Preserve question/answer evidence plus a bounded tail of administrative events.
  if (state.events.length >= 100) {
    const index = state.events.findIndex((entry) => entry.kind === "error" || entry.kind === "state");
    if (index >= 0) state.events.splice(index, 1);
  }
  state.events.push({ at, kind, label, questionId, ...arenaMetrics(state) });
}
function ask(state: ArenaState, challenge: Challenge, reason: string, at: number, options?: { previous: ArenaQuestion; focus: FactKey[] }) {
  if (state.questions.length >= MAX_QUESTIONS) return;
  const def = CHALLENGES[challenge];
  const ranked = state.audiences.slice().sort((a, b) => {
    const rank = (row: typeof a) => (row.persona === def.persona ? 40 : PREFER[row.persona].includes(challenge) ? 22 : 0)
      + row.interest / 10 - row.unresolved.length * 10;
    return rank(b) - rank(a);
  });
  const persona = options?.previous.persona ?? ranked[0].persona;
  const id = "q" + (state.questions.length + 1);
  const question: ArenaQuestion = {
    id, rootId: options?.previous.rootId ?? id, depth: options ? options.previous.depth + 1 : 0, challenge, persona,
    text: options ? `我还想确认${options.focus.map((k) => FACT_LABELS[k]).join("、")}。请直接说明已核对的信息；没把握的部分可以先说明待确认。` : def.prompt,
    reason, askedAt: at, focus: options?.focus ?? [...def.keys], status: "pending",
  };
  state.questions.push(question);
  const audience = state.audiences.find((a) => a.persona === persona)!;
  audience.unresolved = [...audience.unresolved, id];
  audience.concerns = [...new Set([...audience.concerns, ...question.focus])];
  audience.nextAction = "wait";
  event(state, at, "question", reason, id);
}

function nextChallenge(state: ArenaState) {
  const used = new Set(state.questions.map((q) => q.challenge));
  const order = TARGET[state.config.goal];
  const rank = (challenge: Challenge) => {
    const def = CHALLENGES[challenge];
    const matching = state.audiences.filter((a) => PREFER[a.persona].includes(challenge));
    const interest = Math.max(0, ...matching.map((a) => a.interest / 8 + (100 - a.trust) / 16
      - a.unresolved.length * 4 + def.keys.filter((key) => a.concerns.includes(key)).length * 4));
    const known = def.keys.filter((key) => state.material.facts.some((f) => f.key === key)).length;
    return 20 - order.indexOf(challenge) * 3 + interest + (state.config.level === "basic" ? known * 5 : known * 2);
  };
  return order.filter((c) => !used.has(c)).sort((a, b) => rank(b) - rank(a))[0];
}

export function createArena(id: string, material: ArenaMaterial, config: ArenaConfig, now: number, practice?: { parentId: string; challenge: Challenge }): ArenaState {
  const state: ArenaState = {
    id, version: 0, createdAt: now, status: "running", parentId: practice?.parentId ?? null, config, material,
    audiences: config.personas.map((persona) => ({ persona, trust: PERSONAS[persona].trust, interest: PERSONAS[persona].interest, concerns: [], resolved: [], unresolved: [], memory: [], nextAction: "listen" })),
    questions: [], answers: [], events: [], elapsed: 0, runningSince: now, draft: null, lease: null, report: null,
  };
  const opening = practice?.challenge ?? TARGET[config.goal][0];
  const available = CHALLENGES[opening].keys.filter((k) => material.facts.some((f) => f.key === k)).length;
  ask(state, opening, `${practice ? "专项复练：沿用原挑战" : "按训练目标开启挑战"} · ${available}/${CHALLENGES[opening].keys.length} 项有资料`, 0);
  if (config.level === "high" && config.personas.length > 1) {
    const next = nextChallenge(state);
    if (next) ask(state, next, "高压开场：另一个观众插入不同问题", 0);
  }
  return state;
}

export function progressArena(previous: ArenaState, now: number): ArenaState {
  if (previous.status !== "running") return previous;
  if (elapsedAt(previous, now) >= previous.config.minutes * 60_000) return controlArena(previous, "end", now);
  if (previous.config.level !== "high" || !previous.config.personas.includes("disruptor") ||
      previous.questions.some((q) => q.challenge === "rush") || previous.questions.length >= MAX_QUESTIONS) return previous;
  const at = elapsedAt(previous, now);
  if (previous.questions.filter((q) => q.status === "pending" && at - q.askedAt >= 20_000).length < 2) return previous;
  if (previous.questions.filter((q) => q.status === "pending").length >= 3) return previous;
  const state = structuredClone(previous);
  ask(state, "rush", "两条问题等待超过 20 秒，节奏干扰型观众插话", at);
  return state;
}

export function applyArenaAnswer(previous: ArenaState, input: Pick<ArenaAnswer, "id" | "questionId" | "text">, check: ArenaCheck, now: number, submittedAt = now): ArenaState {
  const state = structuredClone(previous);
  const question = state.questions.find((q) => q.id === input.questionId);
  if (!question || question.status !== "pending" || state.status !== "running") return previous;
  const at = elapsedAt(state, now);
  state.answers.push({ ...input, at, latencyMs: Math.max(0, elapsedAt(state, submittedAt) - question.askedAt), check });
  const complete = check.verdict === "resolved";
  question.status = complete ? "resolved" : "unresolved";
  const a = state.audiences.find((row) => row.persona === question.persona)!;
  const priorTrust = a.trust;
  const change = { resolved: 9, partial: 3, off_topic: -7, unsupported: -15 }[check.verdict];
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  a.trust = clamp(a.trust + change);
  const delta = a.trust - priorTrust;
  a.interest = clamp(a.interest + (complete ? (a.persona === "buyer" ? 12 : 6) : check.verdict === "partial" ? 1 : -5));
  if (complete) {
    const chain = state.questions.filter((item) => item.rootId === question.rootId);
    for (const item of chain) item.status = "resolved";
    const solved = chain.map((item) => item.id);
    a.resolved = [...new Set([...a.resolved, ...solved])];
    a.unresolved = a.unresolved.filter((id) => !solved.includes(id));
  }
  a.concerns = a.concerns.filter((key) => check.risks.length > 0 || !check.covered.includes(key));
  a.memory = [...a.memory, { questionId: question.id, result: check.verdict, quote: check.quote.slice(0, 120) }].slice(-4);
  a.nextAction = complete ? "listen" : "follow_up";
  state.draft = null;
  state.lease = null;
  event(state, at, "answer", `${PERSONAS[a.persona].label} · 模拟认可度 ${delta >= 0 ? "+" : ""}${delta} · ${{ resolved: "已回应", partial: "仍有顾虑", off_topic: "没有切题", unsupported: "承诺待核"}[check.verdict]}`, question.id);
  const remaining = check.risks.length ? question.focus : question.focus.filter((key) => !check.covered.includes(key));
  if (!complete && question.depth < (state.config.level === "high" ? 2 : 1)) {
    ask(state, question.challenge,
      check.risks.length ? "检测到待核承诺，要求回到资料" :
        check.verdict === "partial" ? "已有部分依据，追问未回应的要点" : "当前回答没有解决顾虑，要求直接回应",
      at, { previous: question, focus: remaining.length ? remaining : question.focus });
  } else if (state.questions.filter((q) => q.status === "pending").length < (state.config.level === "high" ? 2 : 1)) {
    const next = nextChallenge(state);
    if (next) ask(state, next, complete ? "该题已回应，按观众兴趣和资料覆盖转入新挑战" : "达到追问上限，保留疑点后转入下一题", at);
  }
  return state;
}

export function controlArena(previous: ArenaState, command: "pause" | "resume" | "end" | "cancel", now: number): ArenaState {
  if (previous.status === "ended" ||
      (command === "pause" && previous.status !== "running") ||
      (command === "resume" && previous.status !== "paused") ||
      (command === "cancel" && !previous.lease)) return previous;
  if (elapsedAt(previous, now) >= previous.config.minutes * 60_000) command = "end";
  const state = structuredClone(previous);
  const at = elapsedAt(state, now);
  state.lease = null;
  if (state.draft && previous.lease) state.draft.error = "本次分析已取消，未计入评分。";
  if (command !== "cancel") {
    state.elapsed = at;
    state.runningSince = command === "resume" ? now : null;
    state.status = command === "end" ? "ended" : command === "pause" ? "paused" : "running";
  }
  event(state, at, "state", { pause: "暂停演练", resume: "继续演练", end: "结束并生成复盘", cancel: "取消本次回答分析" }[command]);
  if (command === "end") {
    for (const question of state.questions) if (question.status === "pending") question.status = "unresolved";
    for (const audience of state.audiences) audience.nextAction = "listen";
    state.report = buildArenaReport(state);
  }
  return state;
}

export function recordArenaFailure(previous: ArenaState, message: string, now: number): ArenaState {
  const state = structuredClone(previous);
  state.lease = null;
  if (state.draft) state.draft.error = message;
  event(state, elapsedAt(state, now), "error", message, state.draft?.questionId);
  return state;
}
