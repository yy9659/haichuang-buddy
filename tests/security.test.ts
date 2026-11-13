import { mkdtemp, readFile, readdir, writeFile, cp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({ token: "", requestHeaders: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => browser.requestHeaders,
  cookies: async () => ({ get: () => browser.token ? { value: browser.token } : undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { closeDb, ensureLocalDatabaseReady, getDb, getLocalClient } from "@/db";
import { agentTasks, agentWorkflows, businesses, products, salesRecords, users } from "@/db/schema";
import { resetServerEnvCache } from "@/lib/env";
import { hashSessionToken } from "@/lib/session";
import { trustedClientSource } from "@/lib/public-security";
import { getRepositories } from "@/repositories";
import { getSessionContext } from "@/repositories/db/session-context";
import { acquireModelLease, administerAccount, releaseModelLease, takeRateSlot } from "@/repositories/db/security.repository";
import { login, register, type IssuedSession } from "@/services/auth.service";
import { requestPasswordReset, resetAccountPassword } from "@/services/account-recovery.service";
import { getAdminOverview } from "@/services/admin.service";
import { createWanxiangImageProvider, getAIProvider } from "@/ai/provider";
import { meteredModelFetch } from "@/services/model-quota.service";
import { deletePublicKnowledgeAction } from "@/actions/admin";
import { deleteProductAction } from "@/actions/products";
import { getProductDetailView } from "@/services/products";
import { GET as localImage } from "@/app/api/product-images/[filename]/route";
import { GET as posterImage } from "@/app/api/poster-backgrounds/[id]/route";
import { localProductImageFilename, saveLocalProductImage } from "@/storage/local-product-image";
import { savePosterBackgroundJob } from "@/storage/poster-background";
import { backupLocalData, restoreLocalData } from "../scripts/lib/local-backup";
import type { Result } from "@/lib/result";

const existingEmail = "operator@example.test";
const existingPassword = "old-demo";
const trialEmail = "trial@example.test";
const password = "Isolated-security-test-passphrase";
const replacement = "Replacement-security-test-passphrase";
let temp: string, database: string, assets: string, existingId: string, existingBusiness: string;
let admin: IssuedSession, merchant: IssuedSession;
let ownedProduct: string, filename: string;
const backgroundId = "a".repeat(32);
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kvp0AAAAASUVORK5CYII=", "base64");

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error("Test action failed: " + result.error.code + " " + result.error.message);
  return result.data;
}
function configure(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  resetServerEnvCache();
}
function authenticate(session?: IssuedSession) { browser.token = session?.token ?? ""; }

beforeAll(async () => {
  temp = await mkdtemp(path.join(tmpdir(), "buddy-security-"));
  database = path.join(temp, "db");
  assets = path.join(temp, "assets");
  const previous = path.join(temp, "pre-security-migrations");
  await cp("src/db/migrations", previous, { recursive: true });
  const journalPath = path.join(previous, "meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 13);
  await writeFile(journalPath, JSON.stringify(journal));
  const db = new PGlite(database);
  try {
    await migrate(drizzle(db), { migrationsFolder: previous });
    await db.exec("CREATE ROLE anon; GRANT USAGE ON SCHEMA public TO anon; GRANT SELECT ON users TO anon;");
    const seed = await db.query<{ id: string }>("INSERT INTO businesses(name,short_name) VALUES ('isolated old shop','test') RETURNING id");
    existingBusiness = seed.rows[0].id;
    const salt = randomBytes(16);
    const hash = scryptSync(existingPassword, salt, 64, { N: 16384, r: 8, p: 1 });
    existingId = (await db.query<{ id: string }>(
      "INSERT INTO users(email,name,business_id,password_hash) VALUES ($1,'legacy',$2,$3) RETURNING id",
      [existingEmail, existingBusiness, ["scrypt",16384,8,1,salt.toString("base64"),hash.toString("base64")].join("$")],
    )).rows[0].id;
  } finally { await db.close(); }

  configure({
    NODE_ENV: "test", DATA_SOURCE: "local", LOCAL_DB_DIR: database, ASSET_DATA_DIR: assets,
    AI_PROVIDER: "mock", APP_ORIGIN: "http://localhost:3000", REGISTRATION_MODE: "invite",
    MAIL_MODE: "file", MAIL_API_KEY: undefined, TRUSTED_PROXY_SECRET: undefined,
    AI_DAILY_CALL_LIMIT: "100", AI_CONCURRENT_CALL_LIMIT: "2", ADMIN_EMAILS: trialEmail,
  });
  await ensureLocalDatabaseReady();
});
afterEach(() => {
  authenticate();
  browser.requestHeaders = new Headers();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  resetServerEnvCache();
  if (temp) {
    const absolute = await realpath(temp);
    const base = await realpath(tmpdir());
    if (path.dirname(absolute) === base && path.basename(absolute).startsWith("buddy-security-")) {
      await rm(absolute, { recursive: true, force: false, maxRetries: 5, retryDelay: 250 });
    }
  }
});

async function readResetMail() {
  const dir = path.join(assets, "dev-mail");
  for (const file of await readdir(dir)) {
    const contents = await readFile(path.join(dir, file), "utf8");
    const match = /http:\/\/localhost:3000\/reset-password#([A-Za-z0-9_-]{43})/.exec(contents);
    if (match) return match[1];
  }
  throw new Error("Test email missing");
}

it("forward migration preserves an existing scrypt login, and grants only the confirmed existing account", async () => {
  const legacy = unwrap(await login({ email: existingEmail, password: existingPassword }));
  expect(legacy.user.role).toBe("merchant");
  expect((await getLocalClient().query<{ permitted: boolean }>("SELECT has_table_privilege('anon','public.users','SELECT') AS permitted")).rows[0].permitted).toBe(false);
  expect(legacy.user.businessId).toBe(existingBusiness);
  const [row] = await getDb().select().from(users).where(eq(users.id, existingId));
  expect(row.emailVerifiedAt).toBeNull();
  await expect(administerAccount(existingId, "wrong@example.test", "grant", "test")).rejects.toThrow("不匹配");
  await administerAccount(existingId, existingEmail, "grant", "test");
  expect(await getRepositories().sessions.findValidByTokenHash(hashSessionToken(legacy.token))).toBeNull();
  admin = unwrap(await login({ email: existingEmail, password: existingPassword }));
  expect(admin.user.role).toBe("admin");
  authenticate(admin);
  expect((await getAdminOverview()).dataSource).toBe("local");
});

it("production allows public registration with mail off, even with the old invitation flag present", async () => {
  configure({ NODE_ENV: "production", APP_ORIGIN: "https://fixture.example.test", MAIL_MODE: "off" });
  try {
    merchant = unwrap(await register({ email: trialEmail, name: "trial", password }));
    expect(merchant.user.role).toBe("merchant");
    expect(merchant.user.businessId).not.toBe(existingBusiness);
    const [row] = await getDb().select().from(users).where(eq(users.id, merchant.user.id));
    expect(row.emailVerifiedAt).toBeNull();
  } finally {
    configure({ NODE_ENV: "test", APP_ORIGIN: "http://localhost:3000", MAIL_MODE: "file" });
  }
});

it("registering again cannot claim an existing account or leave an orphan tenant", async () => {
  const before = (await getDb().select({ id: businesses.id }).from(businesses)).length;
  expect((await register({ email: existingEmail, name: "duplicate", password })).ok).toBe(false);
  const [row] = await getDb().select().from(users).where(eq(users.id, existingId));
  expect(row.role).toBe("admin");
  expect(row.businessId).toBe(existingBusiness);
  expect((await getDb().select({ id: businesses.id }).from(businesses))).toHaveLength(before);
});

it("concurrent registration of one email creates a tenant exactly once", async () => {
  const email = "race@example.test";
  const before = (await getDb().select({ id: businesses.id }).from(businesses)).length;
  const results = await Promise.all([1, 2, 3].map(() => register({ email, name: "race", password })));
  expect(results.filter((item) => item.ok)).toHaveLength(1);
  expect((await getDb().select({ id: businesses.id }).from(businesses))).toHaveLength(before + 1);
});

it("forgot password has the same response and scheduling for both addresses; reset revokes sessions", async () => {
  const scheduled: (() => Promise<void>)[] = [];
  const defer = (task: () => Promise<void>) => scheduled.push(task);
  const unverified = await requestPasswordReset(trialEmail, defer);
  expect(unverified.ok).toBe(true);
  await scheduled.pop()!();
  await expect(readdir(path.join(assets, "dev-mail"))).rejects.toMatchObject({ code: "ENOENT" });
  await administerAccount(merchant.user.id, trialEmail, "verify", "test");
  const found = await requestPasswordReset(trialEmail, defer);
  const missing = await requestPasswordReset("unknown@example.test", defer);
  expect(found).toEqual(missing);
  expect(found.ok).toBe(true);
  expect(scheduled).toHaveLength(2);
  await Promise.all(scheduled.map((task) => task()));
  const reset = await readResetMail();
  const secondSession = unwrap(await login({ email: trialEmail, password }));
  const results = await Promise.all([1, 2].map(() => resetAccountPassword(reset, replacement)));
  expect(results.filter((item) => item.ok)).toHaveLength(1);
  for (const session of [merchant, secondSession]) {
    expect(await getRepositories().sessions.findValidByTokenHash(hashSessionToken(session.token))).toBeNull();
  }
  expect((await login({ email: trialEmail, password })).ok).toBe(false);
  merchant = unwrap(await login({ email: trialEmail, password: replacement }));
  configure({ NODE_ENV: "production" });
  const disabled = await requestPasswordReset("disabled@example.test", defer);
  expect(disabled.ok).toBe(false);
  expect(scheduled).toHaveLength(2);
  configure({ NODE_ENV: "test" });
});

it("login throttles by both account and trusted source, never by user-supplied XFF", async () => {
  expect(trustedClientSource(new Headers({ "x-forwarded-for": "203.0.113.5" }))).toBe("shared");
  const secret = "synthetic-test-proxy-proof-long-enough";
  expect(() => trustedClientSource(new Headers({ "x-buddy-client-ip": "203.0.113.5" }), secret)).toThrow("可信代理");
  configure({ TRUSTED_PROXY_SECRET: secret });
  const source = (ip: string) => new Headers({ "x-buddy-proxy-proof": secret, "x-buddy-client-ip": ip });
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await login({ email: "limited@example.test", password }, source("192.0.2.2"));
    expect(!result.ok && result.error.code).toBe("UNAUTHORIZED");
  }
  const locked = await login({ email: "limited@example.test", password }, source("192.0.2.3"));
  expect(locked).toMatchObject({ ok: false, error: { code: "RATE_LIMITED", retryAfterSeconds: expect.any(Number) } });

  // Exercise atomic increments for a shared source without doing 40 expensive scrypt checks.
  const { sha256Hex } = await import("@/lib/hash");
  const slots = await Promise.all(Array.from({ length: 45 }, () => takeRateSlot("login:source:" + sha256Hex("192.0.2.4"), 40, 900)));
  expect(slots.filter((wait) => wait === 0)).toHaveLength(40);
  expect(await login({ email: "new-email@example.test", password }, source("192.0.2.4"))).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
  configure({ TRUSTED_PROXY_SECRET: undefined });
});

it("merchant cannot call management actions or view admin services", async () => {
  authenticate(merchant);
  await expect(getAdminOverview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(await deletePublicKnowledgeAction(existingId)).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
});

it("tenant ownership is enforced for product, workflow, task, image and poster access", async () => {
  authenticate(admin);
  const saved = unwrap(await saveLocalProductImage({ data: imageBytes, contentType: "image/png", name: "fixture" }));
  filename = localProductImageFilename(saved.url)!;
  ownedProduct = (await getDb().insert(products).values({ businessId: existingBusiness, name: "private fixture", category: "海产品", price: 3, imageUrl: saved.url }).returning())[0].id;
  await getDb().insert(salesRecords).values({ businessId: existingBusiness, recordNo: "fixture-1", saleDate: "2026-01-01", productName: "private fixture", channel: "store", quantity: 1, revenueCents: 300 });
  const [flow] = await getDb().insert(agentWorkflows).values({ businessId: existingBusiness, goal: "private workflow" }).returning();
  const [task] = await getDb().insert(agentTasks).values({ businessId: existingBusiness, workflowId: flow.id, title: "private task", agentType: "product_agent" }).returning();
  await savePosterBackgroundJob({ id: backgroundId, businessId: existingBusiness, contentId: task.id, productId: ownedProduct, taskId: "fixture", createdAt: Date.now(), model: "fixture", status: "completed", imageUrl: "/api/poster-backgrounds/" + backgroundId });
  await writeFile(path.join(assets, "poster-backgrounds", backgroundId + ".png"), imageBytes);
  const image = () => localImage(new Request("http://localhost/image"), { params: Promise.resolve({ filename }) });
  const poster = () => posterImage(new Request("http://localhost/poster"), { params: Promise.resolve({ id: backgroundId }) });
  expect((await image()).status).toBe(200);
  expect((await poster()).status).toBe(200);
  authenticate(merchant);
  expect(unwrap(await getProductDetailView(ownedProduct))).toBeNull();
  expect((await deleteProductAction(ownedProduct)).ok).toBe(false);
  expect(await getRepositories().agentWorkflows.findById(flow.id)).toBeNull();
  expect((await getRepositories().agentWorkflows.listRecent()).some((item) => item.id === flow.id)).toBe(false);
  expect(await getRepositories().agentTasks.listByWorkflow(flow.id)).toEqual([]);
  await expect(getRepositories().agentTasks.update(task.id, { status: "failed" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await image()).status).toBe(404);
  expect((await poster()).status).toBe(404);
  authenticate();
  expect((await image()).status).toBe(401);
});

it("atomically enforces shared concurrency and daily budget with distinct tenants", async () => {
  const businessId = merchant.user.businessId;
  const claims = await Promise.allSettled(Array.from({ length: 8 }, () => acquireModelLease(businessId, 3, 2, 30_000)));
  const granted = claims.flatMap((claim) => claim.status === "fulfilled" ? [claim.value] : []);
  expect(granted).toHaveLength(2);
  for (const id of granted) await releaseModelLease(businessId, id);
  const last = await acquireModelLease(businessId, 3, 2, 30_000);
  await releaseModelLease(businessId, last);
  await expect(acquireModelLease(businessId, 3, 2, 30_000)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  const unrelated = await acquireModelLease(existingBusiness, 3, 2, 30_000);
  await releaseModelLease(existingBusiness, unrelated);
});

it("real provider embeddings and text share one budget; denied requests never reach transport", async () => {
  authenticate(admin);
  configure({ AI_PROVIDER: "dashscope", DASHSCOPE_API_KEY: "fixture-not-a-real-key", AI_DAILY_CALL_LIMIT: "2", AI_CONCURRENT_CALL_LIMIT: "1" });
  const fetch = vi.fn(async () => Response.json({ data: [{ index: 0, embedding: Array(1024).fill(0.01) }] }));
  vi.stubGlobal("fetch", fetch);
  const provider = getAIProvider();
  expect((await provider.embed({ values: ["test embedding"] }))[0]).toHaveLength(1024);
  await expect(provider.generateText({ prompt: "test", system: "test" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  await expect(createWanxiangImageProvider(fetch as typeof globalThis.fetch).create("fixture background", "square")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(fetch).toHaveBeenCalledTimes(1);
  authenticate();
  await expect(provider.generateText({ prompt: "test", system: "test" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(fetch).toHaveBeenCalledTimes(1);
  configure({ AI_PROVIDER: "mock", AI_DAILY_CALL_LIMIT: "100", AI_CONCURRENT_CALL_LIMIT: "2" });
});

it("streaming transport holds the concurrent slot through body completion", async () => {
  authenticate(admin);
  configure({ AI_CONCURRENT_CALL_LIMIT: "1" });
  const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} })));
  vi.stubGlobal("fetch", fetch);
  const open = await meteredModelFetch("https://fixture.example.test");
  await expect(meteredModelFetch("https://fixture.example.test")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  expect(fetch).toHaveBeenCalledTimes(1);
  await open.body?.cancel();
  const next = await meteredModelFetch("https://fixture.example.test");
  await next.body?.cancel();
  expect(fetch).toHaveBeenCalledTimes(2);
  configure({ AI_CONCURRENT_CALL_LIMIT: "2" });
});

it("offline backup refuses open database or overwrite; isolated restore reads accounts and assets", async () => {
  const backup = path.join(temp, "snapshot");
  const target = path.join(temp, "restore");
  await expect(backupLocalData(database, assets, backup)).rejects.toThrow("独占");
  await closeDb();
  await backupLocalData(database, assets, backup);
  await expect(restoreLocalData(backup, database)).rejects.toBeDefined();
  await restoreLocalData(backup, target);
  configure({ LOCAL_DB_DIR: path.join(target, "pgdata"), ASSET_DATA_DIR: target });
  await ensureLocalDatabaseReady();
  const restored = unwrap(await login({ email: existingEmail, password: existingPassword }));
  authenticate(restored);
  expect(restored.user.role).toBe("admin");
  expect((await getSessionContext()).kind).toBe("request");
  expect(unwrap(await getProductDetailView(ownedProduct))?.product.name).toBe("private fixture");
  const picture = await localImage(new Request("http://localhost/image"), { params: Promise.resolve({ filename }) });
  const background = await posterImage(new Request("http://localhost/poster"), { params: Promise.resolve({ id: backgroundId }) });
  expect(Buffer.from(await picture.arrayBuffer())).toEqual(imageBytes);
  expect((await getDb().select().from(salesRecords).where(eq(salesRecords.businessId, existingBusiness)))[0].revenueCents).toBe(300);
  expect(Buffer.from(await background.arrayBuffer())).toEqual(imageBytes);
  await administerAccount(existingId, existingEmail, "revoke", "test");
  await expect(getAdminOverview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
