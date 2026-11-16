import { z } from "zod";

export const PERSONAS = {
  price: { name: "精打细算", label: "价格敏感型", trust: 55, interest: 62 },
  quality: { name: "懂海产的老顾客", label: "品质质疑型", trust: 42, interest: 60 },
  buyer: { name: "准备下单", label: "购买意向型", trust: 65, interest: 80 },
  disruptor: { name: "着急的路人", label: "节奏干扰型", trust: 38, interest: 48 },
} as const;
export const personaSchema = z.enum(["price", "quality", "buyer", "disruptor"]);
export type Persona = z.infer<typeof personaSchema>;
export const GOALS = { intro: "商品介绍", price: "价格异议", quality: "品质质疑", service: "售后危机", mixed: "综合控场" } as const;
export const LEVELS = { basic: "基础", advanced: "进阶", high: "高压" } as const;
export const challengeSchema = z.enum(["intro", "price", "origin", "cold", "storage", "refund", "rush"]);
export type Challenge = z.infer<typeof challengeSchema>;
export const arenaConfigSchema = z.object({
  goal: z.enum(["intro", "price", "quality", "service", "mixed"]),
  level: z.enum(["basic", "advanced", "high"]),
  minutes: z.number().int().min(1).max(10),
  personas: z.array(personaSchema).min(1).max(4).refine((p) => new Set(p).size === p.length, "不要重复添加观众"),
});
export type ArenaConfig = z.infer<typeof arenaConfigSchema>;
export type FactKey = "price" | "spec" | "origin" | "stock" | "storage" | "shelf" | "logistics" | "refund";
export interface ArenaFact { id: string; key: FactKey; label: string; text: string; source: string; href: string }
export interface ArenaMaterial {
  productId: string; productName: string; version: string;
  facts: ArenaFact[]; sellingPoints: string[]; brandTone: string[]; script: string; scriptTitle: string;
}
export interface Audience {
  persona: Persona; trust: number; interest: number; concerns: FactKey[];
  resolved: string[]; unresolved: string[];
  memory: { questionId: string; result: Verdict; quote: string }[];
  nextAction: "listen" | "follow_up" | "wait";
}
export type Verdict = "resolved" | "partial" | "off_topic" | "unsupported";
export interface ArenaQuestion {
  id: string; rootId: string; depth: number; challenge: Challenge; persona: Persona;
  text: string; reason: string; askedAt: number; focus: FactKey[]; status: "pending" | "resolved" | "unresolved";
}
export interface ArenaCheck {
  verdict: Verdict; covered: FactKey[]; cited: string[]; risks: string[];
  selling: number[]; clarity: "clear" | "unclear" | "unknown";
  mode: "rules" | "model"; quote: string;
}
export interface ArenaAnswer {
  id: string; questionId: string; text: string; at: number; latencyMs: number; check: ArenaCheck;
}
export interface ArenaEvent {
  at: number; kind: "question" | "answer" | "state" | "error"; label: string;
  questionId?: string; trust: number; responseRate: number; open: number;
}
export interface ArenaReport {
  score: number | null;
  dimensions: { key: string; label: string; score: number | null; weight: number; basis: string }[];
  improvements: string[];
  gaps: { questionId: string; keys: FactKey[] }[];
  focus: Challenge;
  focusQuestion: string;
}
export interface ArenaState {
  id: string; createdAt: number; version: number;
  status: "running" | "paused" | "ended";
  parentId: string | null; config: ArenaConfig; material: ArenaMaterial;
  audiences: Audience[]; questions: ArenaQuestion[]; answers: ArenaAnswer[]; events: ArenaEvent[];
  elapsed: number; runningSince: number | null;
  attempts?: number;
  draft: { id: string; questionId: string; text: string; error?: string } | null;
  lease: { token: string; until: number } | null;
  report: ArenaReport | null;
  filedGaps?: Record<string, "filing" | "filed">;
}
export type ArenaView = Omit<ArenaState, "lease"> & { busyUntil: number | null };
