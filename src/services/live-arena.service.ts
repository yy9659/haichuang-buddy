import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { checkArenaAnswer } from "@/ai/agents/arena-answer";
import { getAIProviderStatus } from "@/ai/provider";
import { getDataSource } from "@/lib/env";
import {
  applyArenaAnswer, controlArena, createArena, FACT_LABELS, progressArena, recordArenaFailure,
} from "@/lib/live-arena/engine";
import { arenaConfigSchema, type ArenaFact, type ArenaMaterial, type ArenaState, type ArenaView, type FactKey } from "@/lib/live-arena/types";
import { AppError, attempt, toAppError } from "@/lib/result";
import { getRepositories } from "@/repositories";
import { getSessionContext } from "@/repositories/db/session-context";
import { createArenaRepository } from "@/repositories/live-arena";
import { recordKnowledgeGap } from "./knowledge-gap.service";

const id = z.uuid();
const product = z.string().trim().max(64).regex(/^[\w-]+$/);
const startInput = z.object({ id, productId: product, config: arenaConfigSchema, confirmed: z.literal(true), materialVersion: z.string().length(64), parentId: id.optional() });
const answerInput = z.object({ id, turnId: id, questionId: z.string().regex(/^q\d{1,2}$/), text: z.string().trim().min(2).max(700) });
const commandInput = z.enum(["pause", "resume", "end", "cancel", "sync"]);
const gapId = z.string().regex(/^q\d{1,2}$/);
const blocked = (message: string) => new AppError({ code: "VALIDATION_FAILED", message });
const notFound = () => new AppError({ code: "NOT_FOUND", message: "没有找到该训练或商品。" });
const busy = (message: string) => new AppError({ code: "RATE_LIMITED", message });
const short = (value: string | undefined, n: number) => (value ?? "").trim().slice(0, n);
const runs = new Map<string, AbortController>();
type Scope = Awaited<ReturnType<typeof scope>>;
type Repo = ReturnType<typeof createArenaRepository>;

async function scope() {
  const context = await getSessionContext();
  if (context.kind !== "request" || !context.businessId || !context.userId) {
    throw new AppError({ code: "UNAUTHORIZED", message: "请先登录，再使用实战演练。" });
  }
  const businessId = context.businessId;
  // Original Mock domain data is single-shop sample data; never share personal training transcripts.
  const owner = getDataSource() === "mock" ? `${businessId}:${context.userId}` : businessId;
  return { businessId, repo: createArenaRepository(owner) };
}

function view(state: ArenaState): ArenaView {
  const { lease, ...data } = state;
  return { ...data, busyUntil: lease?.until ?? null };
}
async function required(repo: Repo, id: string) {
  const state = await repo.get(id);
  if (!state) throw notFound();
  return state;
}
function safe<T>(fn: () => Promise<T>) {
  return attempt(fn, (cause) => {
    if (cause instanceof z.ZodError) return toAppError(blocked("训练参数无效，请核对后重试。"));
    const error = toAppError(cause, "DB_ERROR", "暂时无法完成训练操作，请刷新后重试。");
    return { ...error, detail: undefined };
  });
}

async function materialFor(current: Scope, productId: string): Promise<ArenaMaterial> {
  const repos = getRepositories();
  if (!await repos.products.belongsToBusiness(current.businessId, productId)) throw notFound();
  const item = await repos.products.getById(productId);
  if (!item) throw notFound();
  const [dna, brand, scripts, policies, old] = await Promise.all([
    repos.productDna.getByProductId(productId),
    repos.brand.getProfile(),
    Promise.all([
      repos.content.findBySlot({ productId, platform: "douyin", format: "voiceover" }),
      repos.content.findBySlot({ productId, platform: "douyin", format: "short-video" }),
      repos.content.findBySlot({ productId, platform: "shipinhao", format: "voiceover" }),
    ]),
    Promise.all(["logistics", "after_sales"].map((type) => repos.knowledgeDocuments.findDocuments({
      type: type as "logistics" | "after_sales", source: "manual",
    }))),
    repos.live.getSession(),
  ]);
  const facts: ArenaFact[] = [];
  const add = (key: FactKey, text: string) => {
    const value = short(text, 240);
    if (value) facts.push({ id: "product-" + key, key, label: FACT_LABELS[key], text: value,
      source: "商品中心 · " + item.name, href: "/products/" + encodeURIComponent(productId) });
  };
  if (item.price > 0 && item.unit.trim()) add("price", `${item.price} 元 / ${item.unit}`);
  if (item.stock > 0) add("stock", `${item.stock} 件`);
  add("spec", item.specification);
  add("origin", item.origin);
  add("storage", item.storageMethod);
  add("shelf", item.shelfLife);
  for (const [index, list] of policies.entries()) {
    const key: FactKey = index === 0 ? "logistics" : "refund";
    // Prefer product-specific merchant-entered policies; shop-wide fallback only when no product-specific entry exists.
    const owned = list.filter((doc) => doc.businessId === current.businessId && (doc.productId === productId || doc.productId === null));
    const scoped = owned.some((doc) => doc.productId === productId) ? owned.filter((doc) => doc.productId === productId) : owned;
    for (const doc of scoped.slice(0, 2)) {
      const excerpt = short(doc.content, 480);
      if (excerpt) facts.push({ id: "doc-" + doc.id, key, label: FACT_LABELS[key], text: excerpt, source: doc.name, href: "/customer-service" });
    }
  }
  const source = scripts.find((script) => script?.voiceover?.trim());
  const details = {
    productId, productName: item.name, facts,
    sellingPoints: dna?.approved ? dna.sellingPoints.slice(0, 6).map((point) => short(point, 120)).filter(Boolean) : [],
    brandTone: brand?.approved ? brand.toneOfVoice.slice(0, 6).map((value) => short(value, 80)).filter(Boolean) : [],
    script: short(source?.voiceover ?? (old?.productId === productId ? old.hostTranscript : ""), 1600),
    scriptTitle: source?.title ?? (old?.productId === productId && old.hostTranscript ? "上一场彩排口播" : ""),
  };
  const version = createHash("sha256").update(JSON.stringify({ ...details, productUpdated: item.updatedAt })).digest("hex");
  return { ...details, version };
}

/** Retry quick non-network state transitions on CAS conflicts. */
async function change(repo: Repo, id: string, transition: (state: ArenaState) => ArenaState) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await required(repo, id);
    const next = transition(state);
    if (next === state) return state;
    const saved = await repo.save(state, next);
    if (saved) return saved;
  }
  throw busy("本场状态正在更新，请稍候重试。");
}

export function loadArenaWorkspace(selected?: unknown) {
  return safe(async () => {
    const current = await scope();
    const active = await current.repo.latest(true);
    let state = selected ? await required(current.repo, id.parse(selected)) : active ?? await current.repo.latest();
    if (state && state.status !== "ended") state = await change(current.repo, state.id, (value) => advance(value, Date.now()));
    const [history, products, parent] = await Promise.all([
      current.repo.history(), getRepositories().products.list(),
      state?.parentId ? current.repo.get(state.parentId) : Promise.resolve(null),
    ]);
    // DB list is scoped by session; Mock shares an example catalogue but not training state.
    const mine = products.map((p) => ({ id: p.id, name: p.name }));
    let stale = false;
    if (state?.status === "ended") {
      try { stale = (await materialFor(current, state.material.productId)).version !== state.material.version; }
      catch (cause) { if (cause instanceof AppError && cause.code === "NOT_FOUND") stale = true; else throw cause; }
    }
    return {
      products: mine, state: state ? view(state) : null,
      parent: parent ? view(parent) : null, stale, provider: getAIProviderStatus(),
      history: history.map((s) => ({ id: s.id, name: s.material.productName, status: s.status, createdAt: s.createdAt, score: s.report?.score ?? null })),
    };
  });
}

export function loadArenaMaterial(value: unknown) {
  return safe(async () => materialFor(await scope(), product.parse(value)));
}

/** Read-only workbench output. It is not counted as the host's answer or fact evidence. */
export async function loadArenaWorkflowAdvice(value: string) {
  const result = await safe(async () => {
    await scope();
    if (!product.safeParse(value).success) return null;
    const item = await getRepositories().live.findSuggestionById(value);
    return item && !item.suggestion.failureMessage ? item : null;
  });
  return result.ok ? result.data : null;
}

export function startLiveArena(raw: unknown) {
  return safe(async () => {
    const current = await scope();
    const input = startInput.parse(raw);
    const replay = await current.repo.get(input.id);
    if (replay) return view(replay);
    const active = await current.repo.latest(true);
    if (active) {
      const saved = await change(current.repo, active.id, (s) => advance(s, Date.now()));
      if (saved.status !== "ended") throw blocked("还有一场未结束的演练，请先回到当前场次。");
    }
    const parent = input.parentId ? await required(current.repo, input.parentId) : null;
    if (parent && (!parent.report || parent.material.productId !== input.productId)) throw blocked("请使用同一商品复练已完成的报告。");
    const material = await materialFor(current, input.productId);
    if (material.version !== input.materialVersion) throw blocked("商品资料已更新，请重新载入并核对。");
    const state = createArena(input.id, material, parent?.config ?? input.config, Date.now(),
      parent?.report ? { parentId: parent.id, challenge: parent.report.focus } : undefined);
    if (await current.repo.insert(state)) return view(state);
    const existing = await current.repo.get(input.id);
    if (existing) return view(existing);
    throw busy("另一场演练已开始，请刷新工作区。");
  });
}

function advance(state: ArenaState, now: number) {
  const moved = progressArena(state, now);
  if (moved.lease && moved.lease.until <= now) return recordArenaFailure(moved, "上一次分析已超时。口播已保留，可重新提交。", now);
  return moved;
}

export function commandLiveArena(rawId: unknown, rawCommand: unknown) {
  return safe(async () => {
    const current = await scope();
    const command = commandInput.parse(rawCommand);
    let previousToken: string | undefined;
    const state = await change(current.repo, id.parse(rawId), (value) => {
      const now = Date.now();
      previousToken = value.lease?.token;
      const moved = advance(value, now);
      return command === "sync" ? moved : controlArena(moved, command, now);
    });
    if (!state.lease && previousToken) runs.get(previousToken)?.abort();
    return view(state);
  });
}

export function answerLiveArena(raw: unknown, signal?: AbortSignal) {
  return safe(async () => {
    const current = await scope();
    const input = answerInput.parse(raw);
    if (signal?.aborted) throw blocked("连接已关闭，未开始分析。");
    const token = randomUUID();
    const submittedAt = Date.now();
    const claimed = await change(current.repo, input.id, (s) => {
      const state = advance(s, Date.now());
      if (state.answers.some((a) => a.id === input.turnId) || state.status === "ended") return state;
      if (state.status !== "running") throw blocked("请继续演练后再提交回答。");
      if (state.lease) {
        if (state.draft?.id === input.turnId) return state;
        throw busy("上一条正在分析，请等待或取消。");
      }
      if ((state.attempts ?? 0) >= 32) throw blocked("本场分析次数已达上限，请结束后重新练习。");
      if (!state.questions.some((q) => q.id === input.questionId && q.status === "pending")) throw blocked("这道题已处理，请选择待回答的问题。");
      return { ...state, attempts: (state.attempts ?? 0) + 1, lease: { token, until: Date.now() + 28_000 }, draft: { id: input.turnId, questionId: input.questionId, text: input.text } };
    });
    if (claimed.lease?.token !== token) return view(claimed);
    const controller = new AbortController();
    runs.set(token, controller);
    const question = claimed.questions.find((q) => q.id === input.questionId)!;
    let updated: ArenaState;
    try {
      const owner = claimed.audiences.find((a) => a.persona === question.persona)!;
      signal?.throwIfAborted();
      const check = await checkArenaAnswer({ question, audience: owner, material: claimed.material, answer: input.text,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]) });
      signal?.throwIfAborted();
      updated = await change(current.repo, input.id, (s) => {
        const state = advance(s, Date.now());
        if (state.lease?.token !== token) return state;
        return applyArenaAnswer(state, { id: input.turnId, questionId: input.questionId, text: input.text }, check, Date.now(), submittedAt);
      });
    } catch (cause) {
      const error = toAppError(cause, "MODEL_UNAVAILABLE", "语义分析未完成");
      const reason = ({ MODEL_TIMEOUT: "语义分析超时", SCHEMA_INVALID: "模型输出未通过结构校验", QUOTA_EXCEEDED: "今日模型额度已用完", RATE_LIMITED: "模型调用繁忙", MODEL_UNAVAILABLE: "模型暂不可用" } as Record<string, string>)[error.code] ?? "语义分析未完成";
      updated = await change(current.repo, input.id, (s) => s.lease?.token === token
        ? recordArenaFailure(s, (signal?.aborted ? "连接已中断" : reason) + "，口播已保留，未生成评分。", Date.now()) : s);
    } finally {
      runs.delete(token);
    }
    return view(updated);
  });
}

export function fileArenaKnowledgeGap(rawId: unknown, rawQuestion: unknown) {
  return safe(async () => {
    const current = await scope();
    const arenaId = id.parse(rawId);
    const questionId = gapId.parse(rawQuestion);
    const state = await required(current.repo, arenaId);
    const gap = state.report?.gaps.find((g) => g.questionId === questionId);
    const question = state.questions.find((q) => q.id === questionId);
    if (!gap || !question) throw notFound();
    if (state.filedGaps?.[questionId] === "filed") return view(state);
    if (state.filedGaps?.[questionId] === "filing") throw busy("该条正在记录，请稍候。");
    if (!await getRepositories().products.belongsToBusiness(current.businessId, state.material.productId)) throw notFound();
    const claimed = await current.repo.save(state, { ...state, filedGaps: { ...state.filedGaps, [questionId]: "filing" } });
    if (!claimed) throw busy("记录正在更新，请刷新后重试。");
    const target = question.challenge;
    const result = await recordKnowledgeGap({
      businessId: current.businessId, productId: state.material.productId, question: question.text,
      intent: target === "cold" || target === "rush" ? "logistics" : target === "refund" ? "after_sales" :
        target === "storage" ? "storage" : target === "price" ? "price" : "product",
      reason: "实战演练待核：" + gap.keys.map((key) => FACT_LABELS[key]).join("、"),
    });
    const saved = await change(current.repo, arenaId, (s) => {
      const filedGaps = { ...s.filedGaps };
      if (result.ok) filedGaps[questionId] = "filed"; else delete filedGaps[questionId];
      return { ...s, filedGaps };
    });
    if (!result.ok) throw new AppError(result.error);
    return view(saved);
  });
}
