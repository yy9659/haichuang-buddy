import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ businessId: "", userId: "" }));
vi.mock("@/repositories/db/session-context", () => ({ getSessionContext: async () => ({ kind: "request", ...session }) }));

import { createMockAIProvider } from "@/ai/provider/mock";
import { checkArenaAnswer } from "@/ai/agents/arena-answer";
import { closeDb, ensureLocalDatabaseReady, getDb } from "@/db";
import { businesses, liveComments, liveSessions, liveSuggestions, products } from "@/db/schema";
import { resetServerEnvCache } from "@/lib/env";
import { applyArenaAnswer, controlArena, createArena, elapsedAt, progressArena } from "@/lib/live-arena/engine";
import { ARENA_WEIGHTS, compareArenaChallenge } from "@/lib/live-arena/report";
import type { ArenaConfig, ArenaMaterial, ArenaState } from "@/lib/live-arena/types";
import { createArenaRepository } from "@/repositories/live-arena";
import { answerLiveArena, commandLiveArena, fileArenaKnowledgeGap, loadArenaMaterial, loadArenaWorkflowAdvice, loadArenaWorkspace, startLiveArena } from "@/services/live-arena.service";
import { POST } from "@/app/api/live-arena/answer/route";

const sample: ArenaMaterial = {
  productId: "fixture", productName: "练习鲍鱼", version: "a".repeat(64),
  facts: [
    { id: "p", key: "price", label: "价格", text: "60 元 / 盒", source: "商品档案", href: "/products/fixture" },
    { id: "s", key: "spec", label: "规格", text: "500g", source: "商品档案", href: "/products/fixture" },
    { id: "l", key: "logistics", label: "冷链", text: "顺丰冷链，时效以当地配送为准", source: "商户物流政策", href: "/customer-service" },
  ],
  sellingPoints: ["顺丰冷链"], brandTone: [], script: "", scriptTitle: "",
};
const config: ArenaConfig = { goal: "price", level: "advanced", minutes: 3, personas: ["price", "quality", "buyer", "disruptor"] };
const mock = createMockAIProvider();
const start = (override: Partial<ArenaConfig> = {}, material = sample) => createArena("arena", material, { ...config, ...override }, 10_000);
async function say(state: ArenaState, text: string, q = state.questions[0], now = 16_000) {
  const check = await checkArenaAnswer({ question: q, audience: state.audiences.find((a) => a.persona === q.persona)!, material: state.material, answer: text }, mock);
  return applyArenaAnswer(state, { id: q.id + "-turn", questionId: q.id, text }, check, now);
}
function value<T>(result: { ok: true; data: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw Error(result.error.message);
  return result.data;
}

describe("live arena rules", () => {
  it("uses supported specs to improve trust and follows up only on the missing price", async () => {
    const state = start();
    const next = await say(state, "这个规格是500克，采用顺丰冷链。");
    expect(next.answers[0].check).toMatchObject({ verdict: "partial", covered: ["spec"], cited: ["s"] });
    expect(next.audiences[0]).toMatchObject({ trust: 58, nextAction: "wait" });
    expect(next.questions[1]).toMatchObject({ focus: ["price"], rootId: "q1", persona: "price" });
    const solved = await say(next, "这一盒是60元。", next.questions[1]);
    expect(solved.questions.slice(0, 2).every((q) => q.status === "resolved")).toBe(true);
    expect(solved.audiences[0].unresolved).not.toContain("q1");
  });

  it("records a cold-chain non-answer without falsely resolving it", async () => {
    const next = await say(start({ goal: "quality" }), "欢迎大家，喜欢的话可以点个关注。");
    expect(next.answers[0].check.verdict).toBe("off_topic");
    expect(next.questions[1]).toMatchObject({ challenge: "cold", focus: ["logistics"], persona: "quality" });
    expect(controlArena(next, "end", 20_000).report?.focus).toBe("cold");
  });

  it("does not credit a matching price number in a different sales unit", async () => {
    const next = await say(start(), "这款是500克，每斤60元。");
    expect(next.answers[0].check.covered).toEqual(["spec"]);
    expect(next.questions[1].focus).toEqual(["price"]);
  });

  it("marks unsupported delivery promises and keeps factual score low", async () => {
    const next = await say(start({ goal: "quality" }), "我们保证24小时内送达，明天一定到货。");
    expect(next.answers[0].check.risks.length).toBeGreaterThan(0);
    expect(next.answers[0].check.verdict).toBe("unsupported");
    expect(controlArena(next, "end", 22_000).report?.dimensions.find((d) => d.key === "factual")?.score).toBe(0);
  });

  it("high pressure tracks separate questions, roles and interruption conditions", async () => {
    const state = start({ level: "high" });
    expect(state.questions.map((q) => q.persona)).toEqual(["price", "quality"]);
    expect(progressArena(state, 29_000)).toBe(state);
    const interrupted = progressArena(state, 30_000);
    expect(interrupted.questions[2]).toMatchObject({ persona: "disruptor", challenge: "rush" });
    const next = await say(interrupted, "顺丰冷链，时效以当地配送为准。", interrupted.questions[1], 31_000);
    expect(next.questions[0].status).toBe("pending");
    expect(next.questions[1].status).toBe("resolved");
    expect(next.answers[0].questionId).toBe("q2");
    expect(next.audiences.find((a) => a.persona === "price")?.trust).toBe(state.audiences[0].trust);
  });

  it("compares the same challenge with traceable answer improvement", async () => {
    const first = controlArena(await say(start(), "这款规格是500g。"), "end", 20_000);
    const retry = createArena("retry", sample, config, 10_000, { parentId: first.id, challenge: first.report!.focus });
    const second = controlArena(await say(retry, "规格500g，每盒60元，按实际规格与每盒价格比较。"), "end", 20_000);
    const pair = compareArenaChallenge(first, second, first.report!.focus);
    expect(pair.before.answer?.check.verdict).toBe("partial");
    expect(pair.after.answer?.check.verdict).toBe("resolved");
    expect(pair.sameFacts).toBe(true);
    expect(Object.values(ARENA_WEIGHTS).reduce((n, d) => n + d.weight, 0)).toBe(100);
    const dims = second.report!.dimensions.filter((d) => d.score !== null);
    const score = Math.round(dims.reduce((n, d) => n + d.score! * d.weight, 0) / dims.reduce((n, d) => n + d.weight, 0));
    expect(second.report!.score).toBe(score);
  });

  it("pause freezes clock, expiry is terminal, empty training is not scored", () => {
    const initial = start();
    const paused = controlArena(initial, "pause", 15_000);
    expect(elapsedAt(paused, 60_000)).toBe(5_000);
    const resumed = controlArena(paused, "resume", 60_000);
    const ended = progressArena(resumed, 235_000);
    expect(ended.status).toBe("ended");
    expect(ended.report?.score).toBeNull();
    expect(ended.questions[0].status).toBe("unresolved");
    expect(controlArena(ended, "end", 240_000)).toBe(ended);
  });

  it("rules are repeatable and an explicit unknown is not a fabricated source", async () => {
    const material = { ...sample, facts: sample.facts.filter((f) => f.key !== "logistics") };
    const state = start({ goal: "quality" }, material);
    const text = "冷链和配送时效还没确认，需要核对后再回复，暂不承诺。";
    const a = await say(state, text);
    expect(await say(state, text)).toEqual(a);
    expect(a.answers[0].check).toMatchObject({ verdict: "resolved", cited: [], mode: "rules" });
    const report = controlArena(a, "end", 20_000).report!;
    expect(report.gaps[0].keys).toContain("logistics");
    expect(report.dimensions[0].score).toBeNull();
  });

  it("rejects made-up citations and preserves model errors without mock fallback", async () => {
    const state = start();
    const input = { question: state.questions[0], material: sample, audience: state.audiences[0], answer: "这款很不错，欢迎关注。" };
    const model = { ...mock, id: "fixture", generateObject: vi.fn().mockResolvedValue({
      relevant: true, clear: true, matches: [{ id: "s", said: "这款很不错", source: "1000g" }],
      selling: [], unsupported: [],
    }) };
    expect(await checkArenaAnswer(input, model)).toMatchObject({ verdict: "off_topic", cited: [], mode: "model" });
    model.generateObject.mockRejectedValue(new Error("timeout fixture"));
    await expect(checkArenaAnswer(input, model)).rejects.toThrow("timeout fixture");
  });
});

describe("isolated tenant persistence", () => {
  let root: string, productId: string, owner: string, otherOwner: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "buddy-arena-"));
    for (const [key, value] of Object.entries({ DATA_SOURCE: "local", LOCAL_DB_DIR: path.join(root, "db"), ASSET_DATA_DIR: path.join(root, "assets"), AI_PROVIDER: "mock" })) vi.stubEnv(key, value);
    resetServerEnvCache();
    await ensureLocalDatabaseReady();
    const shops = await getDb().insert(businesses).values([{ name: "A", shortName: "A" }, { name: "B", shortName: "B" }]).returning();
    owner = shops[0].id;
    otherOwner = shops[1].id;
    const [item] = await getDb().insert(products).values({ businessId: owner, name: "练习鲍鱼", category: "海产品", price: 60, unit: "盒", specification: "500g", origin: "连江" }).returning();
    productId = item.id;
    session.businessId = owner;
    session.userId = "owner";
  });
  afterEach(() => { session.businessId = owner; session.userId = "owner"; vi.unstubAllGlobals(); });
  afterAll(async () => {
    await closeDb();
    vi.unstubAllEnvs();
    resetServerEnvCache();
    if (root) {
      const actual = await realpath(root);
      if (path.dirname(actual) === await realpath(tmpdir()) && path.basename(actual).startsWith("buddy-arena-")) await rm(actual, { recursive: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("opens a saved workbench suggestion without exposing it to other merchants", async () => {
    const [legacy] = await getDb().insert(liveSessions).values({
      businessId: owner, productId, productName: "练习鲍鱼", title: "工作台备播记录", status: "ended", hostTranscript: "已有口播",
    }).returning();
    const [comment] = await getDb().insert(liveComments).values({
      sessionId: legacy.id, content: "这款商品的规格是多少？", authorName: "AI 协同预演",
    }).returning();
    const [advice] = await getDb().insert(liveSuggestions).values({
      commentId: comment.id, commentContent: comment.content, intent: "product_question", priority: "normal",
      responseMode: "reply", recommendedAction: "answer", suggestedReply: "规格为 500g。",
    }).returning();
    expect(await loadArenaWorkflowAdvice(advice.id)).toMatchObject({ productId, suggestion: { suggestedReply: "规格为 500g。" } });
    session.businessId = otherOwner;
    expect(await loadArenaWorkflowAdvice(advice.id)).toBeNull();
    session.userId = "";
    expect(await loadArenaWorkflowAdvice(advice.id)).toBeNull();
  });

  it("migrates; confirms start, double-submit/end, reload, same-challenge retry and tenant separation", async () => {
    const material = value(await loadArenaMaterial(productId));
    const args = { id: randomUUID(), config, productId, confirmed: true, materialVersion: material.version };
    expect((await startLiveArena({ ...args, confirmed: false })).ok).toBe(false);
    const starts = await Promise.all([startLiveArena(args), startLiveArena(args)]);
    expect(starts.map((s) => value(s).id)).toEqual([args.id, args.id]);
    expect((await startLiveArena({ ...args, id: randomUUID() })).ok).toBe(false);
    const input = { id: args.id, turnId: randomUUID(), questionId: "q1", text: "规格500g，每盒60元。" };
    const results = await Promise.all([answerLiveArena(input), answerLiveArena(input)]);
    expect(results.every((r) => r.ok)).toBe(true);
    const reloaded = value(await loadArenaWorkspace()).state!;
    expect(reloaded.answers).toHaveLength(1);
    expect(reloaded.answers[0].check.verdict).toBe("resolved");
    const ended = await Promise.all([commandLiveArena(args.id, "end"), commandLiveArena(args.id, "end")]);
    expect(value(ended[0]).report).toEqual(value(ended[1]).report);
    const first = value(ended[0]);
    expect(first.report).not.toBeNull();
    await getDb().update(products).set({ specification: "600g" }).where(eq(products.id, productId));
    expect(value(await loadArenaWorkspace(first.id)).stale).toBe(true);
    const fresh = value(await loadArenaMaterial(productId));
    const retry = value(await startLiveArena({ ...args, id: randomUUID(), parentId: first.id, materialVersion: fresh.version }));
    expect(retry.parentId).toBe(first.id);
    expect(retry.questions[0].challenge).toBe(first.report!.focus);
    await commandLiveArena(retry.id, "end");
    session.businessId = otherOwner;
    session.userId = "other";
    expect(await loadArenaMaterial(productId)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await loadArenaWorkspace(first.id)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await answerLiveArena(input)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await commandLiveArena(retry.id, "end")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    session.userId = "";
    expect(await loadArenaWorkspace()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });

  it("keeps failed real analysis for retry and writes missing knowledge only after confirmation", async () => {
    const product = value(await loadArenaMaterial(productId));
    const args = { id: randomUUID(), config: { ...config, goal: "quality" }, productId, confirmed: true, materialVersion: product.version };
    const created = value(await startLiveArena(args));
    vi.stubEnv("AI_PROVIDER", "dashscope");
    vi.stubEnv("DASHSCOPE_API_KEY", "test-only-fixture");
    resetServerEnvCache();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fixture transport outage"); }));
    const input = { id: created.id, turnId: randomUUID(), questionId: "q1", text: "冷链运输时效需要核对，暂不承诺。" };
    try {
      const failed = value(await answerLiveArena(input));
      expect(failed.draft?.error).toContain("未生成评分");
      expect(failed.answers).toHaveLength(0);
      expect(failed.busyUntil).toBeNull();
    } finally {
      vi.stubEnv("AI_PROVIDER", "mock");
      resetServerEnvCache();
    }
    const retried = value(await answerLiveArena(input));
    expect(retried.answers).toHaveLength(1);
    const ended = value(await commandLiveArena(created.id, "end"));
    expect(ended.report?.gaps[0].keys).toContain("logistics");
    expect(ended.filedGaps?.q1).toBeUndefined();
    expect(value(await fileArenaKnowledgeGap(created.id, "q1")).filedGaps?.q1).toBe("filed");
    expect(value(await fileArenaKnowledgeGap(created.id, "q1")).filedGaps?.q1).toBe("filed");
  });

  it("cancels an in-flight semantic check without committing a late answer", async () => {
    const product = value(await loadArenaMaterial(productId));
    const arena = value(await startLiveArena({ id: randomUUID(), config, productId, confirmed: true, materialVersion: product.version }));
    vi.stubEnv("AI_PROVIDER", "dashscope");
    vi.stubEnv("DASHSCOPE_API_KEY", "test-only-fixture");
    resetServerEnvCache();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const transport = vi.fn(async (_input, init?: RequestInit) => {
      enter();
      return await new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) { reject(init.signal.reason); return; }
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", transport);
    try {
      const submitted = answerLiveArena({ id: arena.id, turnId: randomUUID(), questionId: "q1", text: "500g 每盒60元。" });
      const ready = await Promise.race([entered.then(() => true), submitted.then(() => false)]);
      expect(ready).toBe(true);
      const paused = value(await commandLiveArena(arena.id, "pause"));
      expect(paused.status).toBe("paused");
      expect(paused.draft?.error).toContain("取消");
      expect(value(await submitted).answers).toHaveLength(0);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubEnv("AI_PROVIDER", "mock");
      resetServerEnvCache();
      await commandLiveArena(arena.id, "end");
    }
  });

  it("mock repository isolates owners and rejects stale revision", async () => {
    vi.stubEnv("DATA_SOURCE", "mock");
    resetServerEnvCache();
    try {
      const a = createArenaRepository("mock-a");
      const b = createArenaRepository("mock-b");
      const state = start();
      expect(await a.insert(state)).toBe(true);
      expect(await b.get(state.id)).toBeNull();
      expect(await a.save(state, controlArena(state, "pause", 11_000))).not.toBeNull();
      expect(await a.save(state, controlArena(state, "end", 12_000))).toBeNull();
    } finally {
      vi.stubEnv("DATA_SOURCE", "local");
      resetServerEnvCache();
    }
  });

  it("rejects foreign Origin and oversized JSON before invoking analysis", async () => {
    vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    resetServerEnvCache();
    const url = "http://localhost:3000/api/live-arena/answer";
    const post = (origin: string, body: string) => POST(new Request(url, { method: "POST", headers: { origin, "Content-Type": "application/json" }, body }));
    expect((await post("https://foreign.example", "{}")).status).toBe(403);
    expect((await post("http://localhost:3000", "x".repeat(8200))).status).toBe(413);
  });
});
