import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { liveArenas } from "@/db/schema";
import { getDataSource } from "@/lib/env";
import type { ArenaState } from "@/lib/live-arena/types";
import { AppError } from "@/lib/result";

interface ArenaRepository {
  get(id: string): Promise<ArenaState | null>;
  latest(activeOnly?: boolean): Promise<ArenaState | null>;
  history(): Promise<Pick<ArenaState, "id" | "createdAt" | "status" | "material" | "report">[]>;
  insert(state: ArenaState): Promise<boolean>;
  save(previous: ArenaState, next: ArenaState): Promise<ArenaState | null>;
}

const globalStore = globalThis as typeof globalThis & { __buddyArenas?: Map<string, ArenaState[]> };

export function createArenaRepository(businessId: string): ArenaRepository {
  if (!businessId) throw new AppError({ code: "UNAUTHORIZED", message: "无有效商户会话" });
  if (getDataSource() === "mock") {
    const memory = globalStore.__buddyArenas ??= new Map<string, ArenaState[]>();
    const all = () => memory.get(businessId) ?? [];
    return {
      async get(id) { return structuredClone(all().find((item) => item.id === id) ?? null); },
      async latest(activeOnly) { return structuredClone(all().find((item) => !activeOnly || item.status !== "ended") ?? null); },
      async history() { return structuredClone(all().slice(0, 12).map(({ id, createdAt, status, material, report }) => ({ id, createdAt, status, material, report }))); },
      async insert(state) {
        if (all().some((item) => item.id === state.id || item.status !== "ended")) return false;
        memory.set(businessId, [structuredClone(state), ...all()].slice(0, 30));
        return true;
      },
      async save(previous, next) {
        const items = all();
        const index = items.findIndex((item) => item.id === previous.id && item.version === previous.version);
        if (index < 0) return null;
        const state = { ...next, version: previous.version + 1 };
        items[index] = structuredClone(state);
        return state;
      },
    };
  }
  const db = getDb();
  const owner = eq(liveArenas.businessId, businessId);
  return {
    async get(id) {
      const [row] = await db.select({ state: liveArenas.state }).from(liveArenas)
        .where(and(owner, eq(liveArenas.id, id))).limit(1);
      return row?.state ?? null;
    },
    async latest(activeOnly) {
      const [row] = await db.select({ state: liveArenas.state }).from(liveArenas)
        .where(and(owner, activeOnly ? eq(liveArenas.active, true) : undefined))
        .orderBy(desc(liveArenas.updatedAt)).limit(1);
      return row?.state ?? null;
    },
    async history() {
      const rows = await db.select({ state: liveArenas.state }).from(liveArenas)
        .where(owner).orderBy(desc(liveArenas.updatedAt)).limit(12);
      return rows.map(({ state }) => state);
    },
    async insert(state) {
      const rows = await db.insert(liveArenas).values({ id: state.id, businessId, state })
        .onConflictDoNothing().returning({ id: liveArenas.id });
      return rows.length === 1;
    },
    async save(previous, next) {
      const state = { ...next, version: previous.version + 1 };
      const [row] = await db.update(liveArenas).set({
        state, active: state.status !== "ended", version: state.version, updatedAt: new Date(),
      }).where(and(owner, eq(liveArenas.id, previous.id), eq(liveArenas.version, previous.version)))
        .returning({ state: liveArenas.state });
      return row?.state ?? null;
    },
  };
}
