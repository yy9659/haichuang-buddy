import { getAiTimeoutMs, getServerEnv } from "@/lib/env";
import { AppError } from "@/lib/result";
import { acquireModelLease, releaseModelLease } from "@/repositories/db/security.repository";
import { getSessionContext } from "@/repositories/db/session-context";

/** A real model transport must always have an authenticated tenant and a durable reservation. */
export async function reserveModelCall(leaseMs: number) {
  const context = await getSessionContext();
  if (context.kind !== "request" || !context.businessId) {
    throw new AppError({ code: "UNAUTHORIZED", message: "真实模型调用需要有效的商户会话。" });
  }
  const env = getServerEnv();
  if (env.DATA_SOURCE === "mock") throw new AppError({ code: "VALIDATION_FAILED", message: "真实模型调用需要持久化数据库。" });
  const businessId = context.businessId;
  const id = await acquireModelLease(businessId, env.AI_DAILY_CALL_LIMIT, env.AI_CONCURRENT_CALL_LIMIT, leaseMs);
  return { businessId, id };
}

export async function finishModelCall(businessId: string, id: string) {
  try { await releaseModelLease(businessId, id); }
  catch { console.warn("[model-quota] 并发凭据未能及时释放，将在到期后回收"); }
}

export const meteredModelFetch: typeof fetch = async (input, init) => {
  const timeout = getAiTimeoutMs();
  init?.signal?.throwIfAborted();
  const lease = await reserveModelCall(timeout + 30_000);
  const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(init?.signal ? [init.signal] : [])]);
  let closed = false;
  let detach = () => {};
  async function finish() {
    if (closed) return;
    closed = true;
    detach();
    await finishModelCall(lease.businessId, lease.id);
  }
  try {
    signal.throwIfAborted();
    const response = await fetch(input, { ...init, signal, redirect: "error" });
    if (!response.body) { await finish(); return response; }
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}).finally(finish); };
    signal.addEventListener("abort", abort, { once: true });
    detach = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            signal.throwIfAborted();
            await finish();
            controller.close();
          } else controller.enqueue(result.value);
        } catch (cause) {
          await finish();
          controller.error(cause);
        }
      },
      async cancel() {
        try { await reader.cancel(); } finally { await finish(); }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (cause) {
    await finish();
    throw cause;
  }
};
