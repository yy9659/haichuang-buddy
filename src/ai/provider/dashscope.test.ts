/**
 * DashScope Provider 单测（**不联网**，用 stub fetch）
 *
 * 为什么必须 stub 而不是打真接口：
 * - 单元测试不能依赖外部服务与凭证，否则在没有 Key 的机器上全红；
 * - 真正需要验证的是**我们自己写的代码**：请求怎么拼、模型怎么选、错误怎么归一。
 *   这些恰好都是 stub 能精确断言的部分。
 *
 * 覆盖五类：
 * 1. 配置校验：缺 Key / 地址非法时**创建即失败**，不拖到第一次调用
 * 2. 请求构造：URL、鉴权头、档位→模型名、多模态 content 结构
 * 3. 错误归一：HTTP 状态码与业务错误码 → 项目标准错误码 + retryable
 * 4. 结构化输出：generateObject 的解析与 SCHEMA_INVALID
 * 5. 流式与边界：SSE 增量拼接、取消、空 content
 * 6. 向量化：请求构造、批量分片、维度硬校验（禁止截断 / 补齐）、429 归一
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import { resetServerEnvCache } from "@/lib/env";
import { AppError } from "@/lib/result";

import {
  DASHSCOPE_DEFAULT_BASE_URL,
  DASHSCOPE_EMBEDDING_MAX_BATCH,
  DASHSCOPE_PROVIDER_ID,
  createDashScopeProvider,
} from "./dashscope";

const API_KEY = "sk-test-key";
const CHAT_PATH = "/chat/completions";
const EMBED_PATH = "/embeddings";

/* ------------------------------------------------------------------ */
/* 测试脚手架                                                          */
/* ------------------------------------------------------------------ */

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** 请求体解析结果（断言用） */
interface ChatBody {
  model: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  messages: Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
  }>;
}

function abortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * 可注入的假 fetch。
 * 刻意**尊重 init.signal** —— 否则超时 / 取消这两条路径根本测不出来，
 * 而它们恰恰是最容易写错、线上最常触发的分支。
 */
function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const requestInit = init ?? {};
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: string }).url ?? input);

    calls.push({ url, init: requestInit });

    if (requestInit.signal?.aborted) {
      throw abortError();
    }
    return handler(url, requestInit);
  }) as typeof fetch;

  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** OpenAI 兼容协议的成功响应体 */
function completion(content: string): unknown {
  return { choices: [{ index: 0, message: { role: "assistant", content } }] };
}

function readBody(call: FetchCall): ChatBody {
  return JSON.parse(String(call.init.body)) as ChatBody;
}

/** 建立一个「总是成功」的 provider，并返回调用记录 */
function createOkProvider(
  content: string,
  options: Parameters<typeof createDashScopeProvider>[0] = {},
) {
  const { impl, calls } = stubFetch(() => jsonResponse(completion(content)));
  const provider = createDashScopeProvider({
    apiKey: API_KEY,
    fetchImpl: impl,
    ...options,
  });
  return { provider, calls };
}

/** 断言一个 promise 抛出指定错误码的 AppError，并返回该错误 */
async function expectAppError(
  promise: Promise<unknown>,
  code: string,
): Promise<AppError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  const appError = caught as AppError;
  expect(appError.code).toBe(code);
  return appError;
}

const originalEnv = {
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL,
  AI_API_KEY: process.env.AI_API_KEY,
  AI_MODEL_FAST: process.env.AI_MODEL_FAST,
  AI_MODEL_REASONING: process.env.AI_MODEL_REASONING,
  AI_MODEL_VISION: process.env.AI_MODEL_VISION,
  AI_TIMEOUT_MS: process.env.AI_TIMEOUT_MS,
};

/** 清掉所有与模型相关的环境变量，让「缺 Key」类断言不受本机 .env.local 影响 */
function clearModelEnv(): void {
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL_FAST;
  delete process.env.AI_MODEL_REASONING;
  delete process.env.AI_MODEL_VISION;
  delete process.env.AI_TIMEOUT_MS;
  resetServerEnvCache();
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetServerEnvCache();
}

beforeEach(() => {
  clearModelEnv();
});

afterEach(() => {
  restoreEnv();
});

/* ------------------------------------------------------------------ */
/* 1. 配置校验                                                         */
/* ------------------------------------------------------------------ */

describe("配置校验", () => {
  it("缺 API Key 时创建即失败，并指出该配哪个变量", () => {
    let caught: unknown;
    try {
      createDashScopeProvider();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain("DASHSCOPE_API_KEY");
    // 提示里要带上「怎么退回 mock」，否则用户会卡住
    expect(error.detail).toContain("mock");
  });

  it("DASHSCOPE_API_KEY 缺失时回退到 AI_API_KEY", async () => {
    process.env.AI_API_KEY = "sk-fallback";
    resetServerEnvCache();

    const { impl, calls } = stubFetch(() => jsonResponse(completion("ok")));
    const provider = createDashScopeProvider({ fetchImpl: impl });
    await provider.generateText({ system: "s", prompt: "p" });

    expect(calls[0]?.init.headers).toBeDefined();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-fallback");
  });

  it("接口地址非法时创建即失败", () => {
    expect(() =>
      createDashScopeProvider({ apiKey: API_KEY, baseUrl: "dashscope.aliyuncs.com" }),
    ).toThrowError(AppError);
  });

  it("默认接口地址为百炼 OpenAI 兼容模式", async () => {
    const { provider, calls } = createOkProvider("ok");
    await provider.generateText({ system: "s", prompt: "p" });
    expect(calls[0]?.url).toBe(`${DASHSCOPE_DEFAULT_BASE_URL}${CHAT_PATH}`);
  });

  it("provider id 默认是 dashscope，可被覆盖", () => {
    const { provider } = createOkProvider("ok");
    expect(provider.id).toBe(DASHSCOPE_PROVIDER_ID);
    const { provider: custom } = createOkProvider("ok", { id: "dashscope-proxy" });
    expect(custom.id).toBe("dashscope-proxy");
  });

  it("自定义 baseUrl 时会去掉结尾多余的斜杠", async () => {
    const { provider, calls } = createOkProvider("ok", {
      baseUrl: "https://proxy.example.com/v1/",
    });
    await provider.generateText({ system: "s", prompt: "p" });
    expect(calls[0]?.url).toBe(`https://proxy.example.com/v1${CHAT_PATH}`);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 请求构造                                                         */
/* ------------------------------------------------------------------ */

describe("请求构造", () => {
  it("generateText：携带鉴权头、system/user 两条消息，默认走 fast 档", async () => {
    const { provider, calls } = createOkProvider("连江鲍鱼确实新鲜");

    const text = await provider.generateText({
      system: "你是商品经理",
      prompt: "分析这个商品",
    });

    expect(text).toBe("连江鲍鱼确实新鲜");
    expect(calls).toHaveLength(1);

    const call = calls[0];
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(call?.init.method).toBe("POST");

    const body = readBody(call);
    expect(body.model).toBe("qwen-plus");
    expect(body.messages).toEqual([
      { role: "system", content: "你是商品经理" },
      { role: "user", content: "分析这个商品" },
    ]);
    // 结构化推理要稳，因此默认给了非 0 的低温度
    expect(body.temperature).toBe(0.2);
  });

  it("generateText：tier=reasoning 切换到复杂推理模型", async () => {
    const { provider, calls } = createOkProvider("ok");
    await provider.generateText({ system: "s", prompt: "p", tier: "reasoning" });
    expect(readBody(calls[0]).model).toBe("qwen-max");
  });

  it("AI_MODEL_* 能覆盖档位对应的模型名", async () => {
    process.env.AI_MODEL_REASONING = "qwen3-max-preview";
    resetServerEnvCache();

    const { provider, calls } = createOkProvider("ok");
    await provider.generateText({ system: "s", prompt: "p", tier: "reasoning" });
    expect(readBody(calls[0]).model).toBe("qwen3-max-preview");
  });

  it("maxOutputTokens 透传为 max_tokens；不传时不带上该字段", async () => {
    const { provider, calls } = createOkProvider("ok");
    await provider.generateText({ system: "s", prompt: "p", maxOutputTokens: 512 });
    expect(readBody(calls[0]).max_tokens).toBe(512);

    const { provider: second, calls: secondCalls } = createOkProvider("ok");
    await second.generateText({ system: "s", prompt: "p" });
    expect(readBody(secondCalls[0]).max_tokens).toBeUndefined();
  });

  it("analyzeImage：使用 vision 档并构造多模态 content（文本 + 图片）", async () => {
    const { provider, calls } = createOkProvider("主体完整，色泽自然");

    const description = await provider.analyzeImage({
      system: "你是图像分析助手",
      prompt: "请分析这张图",
      imageUrls: [
        "https://example.supabase.co/storage/v1/object/public/product-images/a.webp",
        "https://example.supabase.co/storage/v1/object/public/product-images/b.webp",
      ],
    });

    expect(description).toBe("主体完整，色泽自然");

    const body = readBody(calls[0]);
    expect(body.model).toBe("qwen-vl-max");
    expect(body.messages[0]).toEqual({ role: "system", content: "你是图像分析助手" });

    const content = body.messages[1]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      return;
    }
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "text", text: "请分析这张图" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: {
        url: "https://example.supabase.co/storage/v1/object/public/product-images/a.webp",
      },
    });
    expect(content[2]).toMatchObject({ type: "image_url" });
  });

  it("analyzeImage：接受 data:image 内联图，但拒绝本地路径", async () => {
    const { provider, calls } = createOkProvider("ok");
    await provider.analyzeImage({
      system: "s",
      prompt: "p",
      imageUrls: ["data:image/png;base64,iVBORw0KGgo="],
    });
    expect(calls).toHaveLength(1);

    const error = await expectAppError(
      provider.analyzeImage({
        system: "s",
        prompt: "p",
        imageUrls: ["/tmp/baoyu.png"],
      }),
      "VALIDATION_FAILED",
    );
    // 提示要告诉调用方图片应该放哪里
    expect(error.detail).toContain("Supabase Storage");
  });

  it("analyzeImage：没有图片时直接报错，不发起请求", async () => {
    const { provider, calls } = createOkProvider("ok");
    await expectAppError(
      provider.analyzeImage({ system: "s", prompt: "p", imageUrls: [] }),
      "VALIDATION_FAILED",
    );
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 错误归一                                                         */
/* ------------------------------------------------------------------ */

describe("错误归一化", () => {
  const cases: Array<{
    status: number;
    code: string;
    retryable: boolean;
    body: string;
  }> = [
    { status: 401, code: "UNAUTHORIZED", retryable: false, body: "invalid api key" },
    { status: 403, code: "UNAUTHORIZED", retryable: false, body: "forbidden" },
    { status: 429, code: "RATE_LIMITED", retryable: true, body: "too many requests" },
    { status: 500, code: "MODEL_UNAVAILABLE", retryable: true, body: "internal error" },
    { status: 503, code: "MODEL_UNAVAILABLE", retryable: true, body: "unavailable" },
    { status: 504, code: "MODEL_TIMEOUT", retryable: true, body: "gateway timeout" },
    { status: 400, code: "VALIDATION_FAILED", retryable: false, body: "bad parameter" },
  ];

  for (const testCase of cases) {
    it(`HTTP ${testCase.status} → ${testCase.code}（retryable=${testCase.retryable}）`, async () => {
      const { impl, calls } = stubFetch(
        () => new Response(testCase.body, { status: testCase.status }),
      );
      const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

      const error = await expectAppError(
        provider.generateText({ system: "s", prompt: "p" }),
        testCase.code,
      );
      expect(error.retryable).toBe(testCase.retryable);
      // 详情里必须能看出是哪个模型出的问题，否则线上根本没法排查
      expect(error.detail).toContain("qwen-plus");
      expect(error.detail).toContain(String(testCase.status));
      expect(calls).toHaveLength(1);
    });
  }

  it("欠费 / 额度不足的响应被识别为 QUOTA_EXCEEDED 而非笼统的 403", async () => {
    const { impl } = stubFetch(
      () =>
        new Response('{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}', {
          status: 403,
        }),
    );
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const error = await expectAppError(
      provider.generateText({ system: "s", prompt: "p" }),
      "QUOTA_EXCEEDED",
    );
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("配额");
  });

  it("HTTP 200 但响应体带业务错误码时同样归一为错误", async () => {
    const { impl } = stubFetch(() =>
      jsonResponse({ code: "InvalidParameter", message: "model not found" }),
    );
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const error = await expectAppError(
      provider.generateText({ system: "s", prompt: "p" }),
      "VALIDATION_FAILED",
    );
    expect(error.detail).toContain("model not found");
  });

  it("HTTP 200 但 error 字段非空时归一为错误", async () => {
    const { impl } = stubFetch(() =>
      jsonResponse({ error: { code: "Throttling", message: "Requests rate limit exceeded" } }),
    );
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    await expectAppError(
      provider.generateText({ system: "s", prompt: "p" }),
      "RATE_LIMITED",
    );
  });

  it("choices 缺失时视为模型服务异常", async () => {
    const { impl } = stubFetch(() => jsonResponse({ request_id: "abc" }));
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const error = await expectAppError(
      provider.generateText({ system: "s", prompt: "p" }),
      "MODEL_UNAVAILABLE",
    );
    expect(error.detail).toContain("choices");
  });

  it("content 为空字符串时视为失败，而不是成功返回空结论", async () => {
    const { impl } = stubFetch(() => jsonResponse(completion("   ")));
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const error = await expectAppError(
      provider.generateText({ system: "s", prompt: "p" }),
      "MODEL_UNAVAILABLE",
    );
    expect(error.message).toContain("空内容");
    // 最可能的原因要写进 detail，省得对着失败排查半天
    expect(error.detail).toContain("内容安全");
  });

  it("短暂断连后重试一次并成功返回", async () => {
    let attempts = 0;
    const { impl, calls } = stubFetch(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("fetch failed: ECONNRESET");
      }
      return jsonResponse(completion("重新分析完成"));
    });
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    await expect(provider.generateText({ system: "s", prompt: "p" })).resolves.toBe("重新分析完成");
    expect(calls).toHaveLength(2);
  });

  it("连续网络异常重试一次后归为 MODEL_UNAVAILABLE", async () => {
    const { impl, calls } = stubFetch(() => {
      throw new Error("fetch failed: ECONNRESET");
    });
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const error = await expectAppError(
      provider.generateText({ system: "s", prompt: "p" }),
      "MODEL_UNAVAILABLE",
    );
    expect(error.detail).toContain("ECONNRESET");
    expect(calls).toHaveLength(2);
  });

  it("运行环境禁止联网时说明原因且不重复请求", async () => {
    const { impl, calls } = stubFetch(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("access denied"), { code: "EACCES" }),
      });
    });
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const error = await expectAppError(
      provider.generateText({ system: "s", prompt: "p" }),
      "MODEL_UNAVAILABLE",
    );
    expect(error.message).toContain("无法访问模型网络");
    expect(error.detail).toContain("EACCES");
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("超过超时上限时抛 MODEL_TIMEOUT", async () => {
    // handler 永不主动返回，只等 signal 被超时定时器 abort
    const { impl } = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(abortError()),
            { once: true },
          );
        }),
    );
    const provider = createDashScopeProvider({
      apiKey: API_KEY,
      fetchImpl: impl,
      timeoutMs: 20,
    });

    const error = await expectAppError(
      provider.generateText({ system: "s", prompt: "p" }),
      "MODEL_TIMEOUT",
    );
    expect(error.message).toContain("超时");
    expect(error.detail).toContain("20ms");
  });

  it("调用方传入已取消的 signal 时抛 MODEL_TIMEOUT（不误报为服务不可用）", async () => {
    const { provider } = createOkProvider("ok");
    const error = await expectAppError(
      provider.generateText({
        system: "s",
        prompt: "p",
        signal: AbortSignal.abort(),
      }),
      "MODEL_TIMEOUT",
    );
    expect(error.message).toContain("取消");
  });
});

/* ------------------------------------------------------------------ */
/* 4. 结构化输出                                                       */
/* ------------------------------------------------------------------ */

describe("generateObject", () => {
  const schema = z.object({
    category: z.string(),
    confidence: z.number(),
  });

  it("能从带代码围栏的输出里提取并校验对象", async () => {
    const raw = [
      "好的，结果如下：",
      "```json",
      '{ "category": "海产品", "confidence": 0.8 }',
      "```",
    ].join("\n");
    const { provider } = createOkProvider(raw);

    const value = await provider.generateObject({
      system: "s",
      prompt: "p",
      schema,
      tier: "reasoning",
    });
    expect(value).toEqual({ category: "海产品", confidence: 0.8 });
  });

  it("输出不符合 Schema 时抛 SCHEMA_INVALID（把纠错交给上层）", async () => {
    const { provider } = createOkProvider('{ "category": "海产品" }');

    const error = await expectAppError(
      provider.generateObject({ system: "s", prompt: "p", schema }),
      "SCHEMA_INVALID",
    );
    // 默认 SCHEMA_INVALID 可重试，这正是 Agent 回喂纠错的前提
    expect(error.retryable).toBe(true);
  });

  it("输出完全没有 JSON 时抛 SCHEMA_INVALID", async () => {
    const { provider } = createOkProvider("我不太确定这个商品是什么。");
    await expectAppError(
      provider.generateObject({ system: "s", prompt: "p", schema }),
      "SCHEMA_INVALID",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5. 流式与边界                                                       */
/* ------------------------------------------------------------------ */

/** 消费一个字符串流（tsconfig 的 lib 未开 DOM.AsyncIterable，因此用 reader 而非 for await） */
async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return chunks;
}

describe("streamText", () => {
  function sseResponse(chunks: string[]): Response {
    const lines = chunks
      .map((chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}`)
      .concat("data: [DONE]")
      .join("\n\n");
    return new Response(`${lines}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  it("逐段解析 SSE 增量，拼接后等于完整文本", async () => {
    const { impl, calls } = stubFetch(() => sseResponse(["连江", "鲜活", "鲍鱼"]));
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const stream = await provider.streamText({ system: "s", prompt: "p" });
    const collected = await collectStream(stream);

    expect(collected).toEqual(["连江", "鲜活", "鲍鱼"]);
    expect(collected.join("")).toBe("连江鲜活鲍鱼");
    expect(readBody(calls[0]).stream).toBe(true);
  });

  it("同时回调 onChunk", async () => {
    const { impl } = stubFetch(() => sseResponse(["A", "B"]));
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const seen: string[] = [];
    const stream = await provider.streamText({
      system: "s",
      prompt: "p",
      onChunk: (chunk) => seen.push(chunk),
    });
    await collectStream(stream);

    expect(seen).toEqual(["A", "B"]);
  });

  it("流式请求失败时在建流阶段就抛错（不会返回一个注定读不到数据的流）", async () => {
    const { impl } = stubFetch(() => new Response("rate limited", { status: 429 }));
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    await expectAppError(
      provider.streamText({ system: "s", prompt: "p" }),
      "RATE_LIMITED",
    );
  });
});

describe("embed", () => {
  it("短暂网络中断只重试一次", async () => {
    let count = 0;
    const { impl } = stubFetch(() => {
      count++;
      if (count === 1) throw new TypeError("fetch failed");
      return jsonResponse({ data: [{ index: 0, embedding: embeddingVector(1) }] });
    });
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });
    expect(await provider.embed({ values: ["保存方法"] })).toHaveLength(1);
    expect(count).toBe(2);
  });

  it("权限被拒绝时给出准确提示，不做无效重试", async () => {
    for (const code of ["EACCES", "EPERM"]) {
      const denied = Object.assign(new Error("connect denied"), { code });
      const { impl, calls } = stubFetch(() => { throw new TypeError("fetch failed", { cause: denied }); });
      const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });
      const error = await expectAppError(provider.embed({ values: ["冷冻多久"] }), "MODEL_UNAVAILABLE");
      expect(error.message).toContain("允许联网的终端");
      expect(error.retryable).toBe(false);
      expect(error.detail).toContain(code);
      expect(calls).toHaveLength(1);
    }
  });

  it("持续网络故障两次后停止，不无限重试", async () => {
    const { impl, calls } = stubFetch(() => { throw new TypeError("fetch failed"); });
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });
    await expectAppError(provider.embed({ values: ["保存方法"] }), "MODEL_UNAVAILABLE");
    expect(calls).toHaveLength(2);
  });

  it("调用方取消时不重试", async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl, calls } = stubFetch(() => jsonResponse({}));
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });
    await expectAppError(provider.embed({ values: ["保存方法"], signal: controller.signal }), "MODEL_TIMEOUT");
    expect(calls).toHaveLength(1);
  });

  /** 造一个维度合法的假向量（内容不重要，这里验证的是「我们自己写的代码」） */
  function embeddingVector(seed: number): number[] {
    return Array.from(
      { length: EMBEDDING_DIMENSIONS },
      (_, index) => ((seed + index) % 97) / 97,
    );
  }

  function embeddingsResponse(vectors: number[][], order?: number[]): unknown {
    return {
      data: vectors.map((embedding, index) => ({
        index: order?.[index] ?? index,
        embedding,
      })),
    };
  }

  it("请求打到 /embeddings，带上 dimensions 与编码格式，返回 1024 维向量", async () => {
    const vector = embeddingVector(1);
    const { impl, calls } = stubFetch(() => jsonResponse(embeddingsResponse([vector])));
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const result = await provider.embed({ values: ["连江鲍鱼怎么保存"] });

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${DASHSCOPE_DEFAULT_BASE_URL}${EMBED_PATH}`);

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      model: string;
      input: string[];
      dimensions: number;
      encoding_format: string;
    };
    expect(body.input).toEqual(["连江鲍鱼怎么保存"]);
    // 显式声明维度是刻意的：依赖服务端默认值会在换模型时静默变成别的维度
    expect(body.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(body.encoding_format).toBe("float");
    expect(body.model.length).toBeGreaterThan(0);
  });

  it("按响应里的 index 还原顺序，而不是相信返回顺序", async () => {
    const first = embeddingVector(1);
    const second = embeddingVector(50);
    const { impl } = stubFetch(() =>
      jsonResponse(embeddingsResponse([second, first], [1, 0])),
    );
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const result = await provider.embed({ values: ["甲", "乙"] });
    expect(result[0]).toEqual(first);
    expect(result[1]).toEqual(second);
  });

  it("维度不是 1024 时抛 VALIDATION_FAILED，**不截断也不补齐**", async () => {
    // 故意少一半：这正是「换个模型就悄悄错位」的场景
    const wrong = Array.from({ length: 512 }, (_, index) => index / 512);
    const { impl } = stubFetch(() => jsonResponse(embeddingsResponse([wrong])));
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const error = await expectAppError(
      provider.embed({ values: ["鲍鱼"] }),
      "VALIDATION_FAILED",
    );
    expect(error.message).toContain("维度");
    expect(error.retryable).toBe(false);
  });

  it("空文本立即报错，且不发请求", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(embeddingsResponse([])));
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    await expectAppError(provider.embed({ values: ["  "] }), "VALIDATION_FAILED");
    expect(calls).toHaveLength(0);
  });

  it("空数组返回空数组，不发请求", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(embeddingsResponse([])));
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    await expect(provider.embed({ values: [] })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("超过单批上限时自动分片，不把超限请求发给服务端", async () => {
    const { impl, calls } = stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return jsonResponse(
        embeddingsResponse(body.input.map((_, index) => embeddingVector(index))),
      );
    });
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    const values = Array.from(
      { length: DASHSCOPE_EMBEDDING_MAX_BATCH + 3 },
      (_, index) => `文本 ${index}`,
    );
    const result = await provider.embed({ values });

    expect(result).toHaveLength(values.length);
    // 13 条按 10 一批 → 2 次请求
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const body = JSON.parse(String(call.init.body)) as { input: string[] };
      expect(body.input.length).toBeLessThanOrEqual(DASHSCOPE_EMBEDDING_MAX_BATCH);
    }
  });

  it("HTTP 429 归一为 RATE_LIMITED（供上层决定是否退避，而不是当成模型坏了）", async () => {
    const { impl } = stubFetch(
      () => new Response(JSON.stringify({ message: "too many requests" }), { status: 429 }),
    );
    const provider = createDashScopeProvider({ apiKey: API_KEY, fetchImpl: impl });

    await expectAppError(provider.embed({ values: ["鲍鱼"] }), "RATE_LIMITED");
  });
});
