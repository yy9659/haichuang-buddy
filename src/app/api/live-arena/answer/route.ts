import { answerLiveArena } from "@/services/live-arena.service";
import { configuredAppOrigin } from "@/lib/public-security";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };

// Fetch runs independently of the client Server Action queue (pause/cancel/end).
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  let valid = false;
  try {
    const expected = configuredAppOrigin();
    valid = !!origin && (expected ? new URL(origin).origin === expected.origin : new URL(origin).host === request.headers.get("host"));
  } catch { /* reject */ }
  if (!valid || request.headers.get("sec-fetch-site") === "cross-site" ||
      !request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ ok: false, error: { code: "UNAUTHORIZED", message: "请从本站训练页面发起请求。", retryable: false } }, { status: 403, headers });
  }
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ ok: false, error: { message: "缺少回答参数。" } }, { status: 400, headers });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return Response.json({ ok: false, error: { message: "回答请求过长。" } }, { status: 413, headers });
      }
      chunks.push(value);
    }
    return Response.json(await answerLiveArena(JSON.parse(Buffer.concat(chunks).toString("utf8")), request.signal), { headers });
  } catch {
    return Response.json({ ok: false, error: { message: "请求未完成，请检查输入或重试。" } }, { status: 400, headers });
  } finally { reader.releaseLock(); }
}
