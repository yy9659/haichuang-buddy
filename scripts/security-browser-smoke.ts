// Optional loopback-only smoke test. Uses synthetic accounts and never calls a real model or mail API.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, ensureLocalDatabaseReady, getDb } from "@/db";
import { businesses, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { resetServerEnvCache } from "@/lib/env";
import { administerAccount } from "@/repositories/db/security.repository";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const app = "http://127.0.0.1:3917";
const operator = "operator@fixture.example";
const participant = "participant@fixture.example";
const recoveryUser = "verified-recovery@fixture.example";
const original = "Synthetic-test-password-only";
const replacement = "Another-test-only-password";
let stage = "准备隔离环境";
let temp: string | undefined;
let appProcess: ChildProcess | undefined, browserProcess: ChildProcess | undefined;
let ws: WebSocket | undefined;

async function waitFor<T>(check: () => Promise<T>, timeout = 60000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  do {
    try { const result = await check(); if (result) return result; } catch { /* wait for readiness */ }
    await delay(300);
  } while (Date.now() < end);
  throw new Error("timed out");
}

async function main() {
  const executable = process.env.BUDDY_SMOKE_BROWSER;
  if (!executable) throw new Error("BUDDY_SMOKE_BROWSER missing");
  // Fixed loopback test port must not be in use. Never re-use another server.
  const { createServer } = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject).listen(3917, "127.0.0.1", () => socket.close(() => resolve()));
  });
  temp = await mkdtemp(path.join(tmpdir(), "buddy-browser-"));
  const db = path.join(temp, "db"), assets = path.join(temp, "assets"), profile = path.join(temp, "browser");
  const environment = {
    NODE_ENV: "development" as const, DATA_SOURCE: "local", LOCAL_DB_DIR: db, ASSET_DATA_DIR: assets,
    APP_ORIGIN: app, MAIL_MODE: "file", TRUSTED_PROXY_SECRET: "",
    AI_PROVIDER: "dashscope", AI_DAILY_CALL_LIMIT: "0", DASHSCOPE_API_KEY: "synthetic-invalid-key",
    DASHSCOPE_BASE_URL: "https://model.fixture.invalid/compatible-mode/v1", NEXT_TELEMETRY_DISABLED: "1",
  };
  Object.assign(process.env, environment);
  resetServerEnvCache();
  try {
    await ensureLocalDatabaseReady();
    const [business] = await getDb().insert(businesses).values({ name: "fixture admin", shortName: "fixture" }).returning();
    const [user] = await getDb().insert(users).values({ businessId: business.id, email: operator, name: "test admin", passwordHash: await hashPassword(original) }).returning();
    await administerAccount(user.id, operator, "grant", "smoke-test");
    const [shop] = await getDb().insert(businesses).values({ name: "fixture merchant", shortName: "fixture" }).returning();
    const [verified] = await getDb().insert(users).values({ businessId: shop.id, email: recoveryUser, name: "test merchant", passwordHash: await hashPassword(original) }).returning();
    await administerAccount(verified.id, recoveryUser, "verify", "smoke-test");
  } finally { await closeDb(); }
  stage = "启动临时应用";
  appProcess = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3917"], {
    env: { ...process.env, ...environment }, windowsHide: true, stdio: "ignore",
  });
  appProcess.on("error", () => {});
  await waitFor(async () => (await fetch(app + "/login", { signal: AbortSignal.timeout(1500) })).ok, 120000);
  stage = "启动隔离浏览器";
  browserProcess = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true, stdio: "ignore" });
  browserProcess.on("error", () => {});
  const debugPort = await waitFor(async () => Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]));
  const pages = await fetch("http://127.0.0.1:" + debugPort + "/json/list").then((response) => response.json()) as { type: string; webSocketDebuggerUrl: string }[];
  ws = new WebSocket(pages.find((item) => item.type === "page")!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.addEventListener("open", () => resolve(), { once: true }); ws!.addEventListener("error", reject, { once: true }); });
  let id = 0;
  async function command(method: string, params = {}) {
    const key = ++id;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const listener = (event: MessageEvent) => {
        const result = JSON.parse(String(event.data));
        if (result.id !== key) return;
        clearTimeout(timeout);
        ws!.removeEventListener("message", listener);
        if (result.error) reject(new Error("CDP failed")); else resolve(result.result);
      };
      const timeout = setTimeout(() => { ws!.removeEventListener("message", listener); reject(new Error("CDP timeout")); }, 12000);
      ws!.addEventListener("message", listener);
      ws!.send(JSON.stringify({ id: key, method, params }));
    });
  }
  async function evaluate<T>(expression: string): Promise<T> {
    const output = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (output.exceptionDetails) throw new Error("browser expression failed");
    return (output.result as { value: T }).value;
  }
  const until = (expression: string) => waitFor(() => evaluate(expression));
  const hasText = (label: string) => "document.body?.innerText.includes(" + JSON.stringify(label) + ")";
  const at = (route: string) => "location.pathname === " + JSON.stringify(route) + " && document.readyState === 'complete'";
  async function go(route: string, settled: string, expression?: string) {
    await command("Page.navigate", { url: app + route });
    await until(at(settled) + (expression ? " && (" + expression + ")" : ""));
    await delay(700);
  }
  const set = (selector: string, value: string) => evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(i,${JSON.stringify(value)}); i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
  const click = (label: string) => evaluate(`[...document.querySelectorAll("button")].find(b=>b.innerText.trim()===${JSON.stringify(label)}).click()`);
  const submit = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)}).form.requestSubmit()`);
  async function mailLink(route: string) {
    return waitFor(async () => {
      for (const name of await readdir(path.join(assets, "dev-mail"))) {
        const body = await readFile(path.join(assets, "dev-mail", name), "utf8");
        const url = body.split("\n").find((line) => line.startsWith(app + route + "#"));
        if (url) return url.slice(app.length).trim();
      }
      return null;
    });
  }
  stage = "管理员登录";
  await go("/login", "/login", "!!document.querySelector('#email')");
  await set("#email", operator); await set("#password", original); await submit("#email");
  await until(at("/admin"));
  await command("Network.clearBrowserCookies");
  stage = "开放注册与管理员隔离";
  await go("/register", "/register", "!!document.querySelector('#name') && !document.querySelector('#invite-token')");
  await set("#email", participant); await set("#name", "试用商户"); await set("#password", original); await submit("#email");
  await until(at("/dashboard"));
  await go("/admin", "/dashboard");
  await command("Network.clearBrowserCookies");
  stage = "找回、重设和旧会话失效";
  await go("/login", "/login", "!!document.querySelector('#email')");
  await set("#email", recoveryUser); await set("#password", original); await submit("#email");
  await until(at("/dashboard"));
  await go("/forgot-password", "/forgot-password", "!!document.querySelector('#account-email')");
  await set("#account-email", recoveryUser); await submit("#account-email");
  const reset = await mailLink("/reset-password");
  await go(reset, "/reset-password", "document.querySelector('#reset-token')?.value.length === 43");
  await set("#new-password", replacement); await submit("#new-password");
  await until(hasText("所有设备已退出"));
  await go("/dashboard", "/login");
  await set("#email", recoveryUser); await set("#password", replacement); await submit("#email");
  await until(at("/dashboard"));
  stage = "浏览器额度耗尽";
  await go("/products", "/products", hasText("添加商品"));
  await click("添加商品");
  await until("!!document.querySelector('#product-name')");
  await set("#product-name", "隔离验证商品"); await set("#product-price", "10");
  await set("#product-unit", "份"); await click("创建商品");
  await until("[...document.querySelectorAll('a')].some(a=>a.href.includes('/products/')&&a.innerText.includes('隔离验证商品'))");
  const href = await evaluate<string>("[...document.querySelectorAll('a')].find(a=>a.href.includes('/products/')&&a.innerText.includes('隔离验证商品')).pathname");
  await go(href, href, hasText("AI 分析商品"));
  await click("AI 分析商品");
  await until(hasText("今日 AI 调用次数已用完"));
  console.log("浏览器通过：管理员登录、开放注册、管理端隔离、找回重设、旧会话失效、新密码登录、额度耗尽。");
  await command("Browser.close").catch(() => {});
}

async function stop(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // Only the subprocess tree spawned by this smoke test; never target another instance.
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("exit", () => resolve()); killer.once("error", () => resolve());
    });
  } else child.kill("SIGTERM");
}

main().catch(() => { console.error("浏览器验证未通过，阶段：" + stage); process.exitCode = 1; })
  .finally(async () => {
    ws?.close();
    await stop(browserProcess); await stop(appProcess);
    if (temp) {
      const actual = await realpath(temp);
      if (path.dirname(actual) === await realpath(tmpdir()) && path.basename(actual).startsWith("buddy-browser-")) {
        await rm(actual, { recursive: true, force: false, maxRetries: 5, retryDelay: 300 }).catch(() => {});
      }
    }
  });
