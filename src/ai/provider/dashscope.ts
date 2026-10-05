/**
 * DashScope（阿里云百炼 · 通义千问）Provider
 *
 * 为什么用 fetch 而不是官方 SDK：
 * - 百炼提供 OpenAI 兼容协议（`/compatible-mode/v1/chat/completions`），
 *   协议简单到几十行就能说清楚，引入 SDK 只会多一层版本耦合；
 * - **纪律要求**「业务代码禁止直接调用模型」，因此所有 HTTP 细节必须锁死在本文件内，
 *   上层只看见 `AIProvider` 接口。这里就是那道墙。
 *
 * 模型选型（可用 AI_MODEL_* 覆盖）：
 * - `fast`      → qwen-plus     常规文本生成
 * - `reasoning` → qwen-max      结构化推理（Product Agent 用这一档）
 * - `vision`    → qwen-vl-max   商品图片理解
 * - `embedding` → text-embedding-v3  RAG 向量化（S5 落地）
 *
 * 错误策略：**任何失败都收敛为带标准错误码的 AppError**，
 * 由上层（Agent / Service）统一包成 `Result<T>` 返回给页面 ——
 * 这样页面永远不需要认识 HTTP 状态码，也永远拿不到半截脏输出。
 */

import { parseAgentObject } from "@/ai/schemas/agent-output";
import { EMBEDDING_DIMENSIONS } from "@/lib/embedding";
import { getAiTimeoutMs, getServerEnv, resolveDashScopeApiKey } from "@/lib/env";
import { AppError, type ErrorCode } from "@/lib/result";

import type {
  AIProvider,
  AnalyzeImageInput,
  EmbedInput,
  GenerateObjectInput,
  GenerateTextInput,
  ModelTier,
  StreamTextInput,
} from "./types";

/** Provider 标识，写入 agent_tasks.output 便于区分 Mock 与真实模型 */
export const DASHSCOPE_PROVIDER_ID = "dashscope";

/** 百炼 OpenAI 兼容协议入口（不带结尾斜杠） */
export const DASHSCOPE_DEFAULT_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** 各档位的默认模型名；与 .env.example 的 AI_MODEL_* 保持一致 */
export const DASHSCOPE_DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: "qwen-plus",
  reasoning: "qwen-max",
  vision: "qwen-vl-max",
  embedding: "text-embedding-v3",
};

/** 错误详情里保留的响应体长度，避免把整页 HTML 错误页塞进 detail */
const MAX_DETAIL_LENGTH = 500;

/**
 * 单次 embeddings 请求最多提交多少条文本。
 *
 * 写成常量而不是「调用方自己看着办」：百炼对 embeddings 的批量上限有硬性约束，
 * 超限会直接返回 400 —— 而这个 400 与「模型名写错」的 400 长得一模一样，
 * 排查成本很高。Provider 在内部按这个值切分，把限制关在适配层里。
 */
export const DASHSCOPE_EMBEDDING_MAX_BATCH = 10;

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

export interface DashScopeProviderOptions {
  /** 直接注入 API Key（测试用）；默认读环境变量 */
  apiKey?: string;
  /** 覆盖接口地址（如私有网关 / 代理） */
  baseUrl?: string;
  /** 覆盖某个档位的模型名 */
  models?: Partial<Record<ModelTier, string>>;
  /** 单次调用超时（毫秒） */
  timeoutMs?: number;
  /** 注入 fetch（测试用）；默认使用运行时全局 fetch */
  fetchImpl?: typeof fetch;
  /** 覆盖 Provider 标识（便于多 Provider 并存时区分日志） */
  id?: string;
}

interface ResolvedDashScopeConfig {
  apiKey: string;
  baseUrl: string;
  models: Record<ModelTier, string>;
  timeoutMs: number;
}

/** 读取环境变量里的档位 → 模型名覆盖 */
function envModelOverride(tier: ModelTier): string | undefined {
  const env = getServerEnv();
  switch (tier) {
    case "fast":
      return env.AI_MODEL_FAST;
    case "reasoning":
      return env.AI_MODEL_REASONING;
    case "vision":
      return env.AI_MODEL_VISION;
    case "embedding":
      return env.AI_MODEL_EMBEDDING;
  }
}

/**
 * 解析并校验配置。缺 Key 时立刻抛出可操作的错误 ——
 * 而不是等真正发起请求后拿到一个语焉不详的 401。
 */
function resolveConfig(
  options: DashScopeProviderOptions,
): ResolvedDashScopeConfig {
  const apiKey = options.apiKey ?? resolveDashScopeApiKey();
  if (!apiKey) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "尚未配置通义千问（DashScope）的 API Key",
      detail:
        "缺少环境变量：DASHSCOPE_API_KEY（或回退用的 AI_API_KEY）。请写入 .env.local，或把 AI_PROVIDER 设为 mock。",
      retryable: false,
    });
  }

  const env = getServerEnv();
  const rawBaseUrl =
    options.baseUrl ?? env.DASHSCOPE_BASE_URL ?? DASHSCOPE_DEFAULT_BASE_URL;
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new AppError({
      code: "VALIDATION_FAILED",
      message: "DashScope 接口地址不合法",
      detail: `DASHSCOPE_BASE_URL=${rawBaseUrl}，需要以 http:// 或 https:// 开头`,
      retryable: false,
    });
  }

  const models = { ...DASHSCOPE_DEFAULT_MODELS };
  for (const tier of Object.keys(models) as ModelTier[]) {
    const override = options.models?.[tier] ?? envModelOverride(tier);
    if (override) {
      models[tier] = override;
    }
  }

  return {
    apiKey,
    baseUrl,
    models,
    // 视觉模型较慢，默认给到 90s；上层可用 AbortSignal 提前取消
    timeoutMs: options.timeoutMs ?? getAiTimeoutMs(),
  };
}

/* ------------------------------------------------------------------ */
/* 错误归一化                                                          */
/* ------------------------------------------------------------------ */

function clip(text: string, limit = MAX_DETAIL_LENGTH): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}…（已截断）`;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return typeof cause === "string" ? cause : "未知错误";
}

/** Node fetch 把系统网络错误放在 TypeError.cause，需向内检查才能区分网络权限与断线。 */
function networkPermissionCode(cause: unknown): "EACCES" | "EPERM" | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (code === "EACCES" || code === "EPERM") return code;
    current = current.cause;
  }
  return null;
}

/** 账户层面的关键词：命中时给 QUOTA_EXCEEDED，比笼统的 400/403 更有指导性 */
const QUOTA_KEYWORDS = [
  "arrearage",
  "insufficient",
  "quota",
  "balance",
  "欠费",
  "余额不足",
  "额度",
];

function isQuotaProblem(text: string): boolean {
  const lower = text.toLowerCase();
  return QUOTA_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** HTTP 状态码 → 项目标准错误码 */
function mapHttpError(status: number, body: string, model: string): AppError {
  const detail = `HTTP ${status}（模型 ${model}）：${clip(body)}`;

  if (isQuotaProblem(body)) {
    return new AppError({
      code: "QUOTA_EXCEEDED",
      message: "模型配额不足或账户欠费，请检查百炼控制台的额度",
      detail,
      retryable: false,
    });
  }

  switch (status) {
    case 401:
    case 403:
      return new AppError({
        code: "UNAUTHORIZED",
        message: "模型服务鉴权失败，请检查 DASHSCOPE_API_KEY 是否正确",
        detail,
        retryable: false,
      });
    case 429:
      return new AppError({
        code: "RATE_LIMITED",
        message: "模型调用触发限流，请稍后重试",
        detail,
      });
    case 408:
    case 504:
      return new AppError({
        code: "MODEL_TIMEOUT",
        message: "模型响应超时，请稍后重试",
        detail,
      });
    case 400:
    case 404:
    case 422:
      return new AppError({
        code: "VALIDATION_FAILED",
        message:
          "模型请求参数不合法，请确认 AI_MODEL_* 配置的模型名在当前账号下可用",
        detail,
        retryable: false,
      });
    default:
      return new AppError({
        code: "MODEL_UNAVAILABLE",
        message: "模型服务暂时不可用，请稍后重试",
        detail,
      });
  }
}

/** 百炼有时会以 HTTP 200 返回带 code 的错误体，这里按同一套规则收敛 */
function mapApiError(
  code: string,
  message: string,
  model: string,
): AppError {
  const combined = `${code} ${message}`;
  const detail = `DashScope 返回错误（模型 ${model}）：${clip(combined)}`;

  if (isQuotaProblem(combined)) {
    return new AppError({
      code: "QUOTA_EXCEEDED",
      message: "模型配额不足或账户欠费，请检查百炼控制台的额度",
      detail,
      retryable: false,
    });
  }
  if (/throttl|rate|limit/i.test(combined)) {
    return new AppError({
      code: "RATE_LIMITED",
      message: "模型调用触发限流，请稍后重试",
      detail,
    });
  }
  if (/auth|key|permission|denied/i.test(combined)) {
    return new AppError({
      code: "UNAUTHORIZED",
      message: "模型服务鉴权失败，请检查 DASHSCOPE_API_KEY 是否正确",
      detail,
      retryable: false,
    });
  }
  if (/model|invalid|parameter/i.test(combined)) {
    return new AppError({
      code: "VALIDATION_FAILED",
      message: "模型请求参数不合法，请确认 AI_MODEL_* 配置的模型名是否可用",
      detail,
      retryable: false,
    });
  }
  return new AppError({
    code: "MODEL_UNAVAILABLE",
    message: "模型服务返回了无法识别的错误",
    detail,
  });
}

/** 统一构造错误；保留 retryable 由错误码映射决定 */
function providerError(
  code: ErrorCode,
  message: string,
  detail: string,
): AppError {
  return new AppError({ code, message, detail });
}

/* ------------------------------------------------------------------ */
/* 请求 / 响应                                                          */
/* ------------------------------------------------------------------ */

interface ChatTextPart {
  type: "text";
  text: string;
}

interface ChatImagePart {
  type: "image_url";
  image_url: { url: string };
}

type ChatContent = string | Array<ChatTextPart | ChatImagePart>;

interface ChatMessage {
  role: "system" | "user";
  content: ChatContent;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

/**
 * 请求体构造。
 *
 * 刻意**不发送** `response_format: { type: "json_object" }`：
 * 并非所有 qwen 模型都支持该参数，一旦账号下模型不支持就会把一次本来能成功的调用
 * 变成 400。结构化输出改由「系统提示词强制纯 JSON + 提取器兜底 + 校验失败回喂纠错」保证，
 * 这条链路已在 S2-1 的 Mock Provider 上验证过。
 */
function buildChatRequest(
  model: string,
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxOutputTokens?: number;
    stream?: boolean;
  } = {},
): ChatRequest {
  const request: ChatRequest = { model, messages };
  // 结构化推理希望更稳定，默认给一个偏低但非 0 的温度
  request.temperature = options.temperature ?? 0.2;
  if (options.maxOutputTokens !== undefined) {
    request.max_tokens = options.maxOutputTokens;
  }
  if (options.stream !== undefined) {
    request.stream = options.stream;
  }
  return request;
}

/** 把外部传入的任意 URL 收敛成模型能理解的图片地址 */
function toImageUrl(value: string): string {
  const url = value.trim();
  if (!/^(https?:\/\/|data:image\/)/i.test(url)) {
    throw providerError(
      "VALIDATION_FAILED",
      "商品图片地址无法提交给模型",
      `仅支持 http(s) 或 data:image 开头的地址，收到：${clip(url, 120)}。` +
        "商品图片应存放在 Supabase Storage 并通过其公共 URL 访问。",
    );
  }
  return url;
}

/** 从 OpenAI 兼容响应里取出文本内容；结构不符时抛错而不是返回空串 */
function readCompletionText(payload: unknown, model: string): string {
  if (typeof payload !== "object" || payload === null) {
    throw providerError(
      "MODEL_UNAVAILABLE",
      "模型返回了无法解析的响应",
      `模型 ${model} 的响应不是 JSON 对象`,
    );
  }

  const record = payload as Record<string, unknown>;

  // 200 但带业务错误码
  const errorField = record.error;
  if (typeof errorField === "object" && errorField !== null) {
    const errorRecord = errorField as Record<string, unknown>;
    const code = typeof errorRecord.code === "string" ? errorRecord.code : "unknown";
    const message =
      typeof errorRecord.message === "string" ? errorRecord.message : "未知错误";
    throw mapApiError(code, message, model);
  }
  if (typeof record.code === "string" && record.choices === undefined) {
    const message = typeof record.message === "string" ? record.message : "";
    throw mapApiError(record.code, message, model);
  }

  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw providerError(
      "MODEL_UNAVAILABLE",
      "模型没有返回任何候选结果",
      `模型 ${model} 的响应缺少 choices`,
    );
  }

  const first = choices[0];
  if (typeof first !== "object" || first === null) {
    throw providerError(
      "MODEL_UNAVAILABLE",
      "模型返回的候选结果结构异常",
      `模型 ${model} 的 choices[0] 不是对象`,
    );
  }

  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    throw providerError(
      "MODEL_UNAVAILABLE",
      "模型返回的候选结果缺少 message",
      `模型 ${model} 的 choices[0].message 不是对象`,
    );
  }

  const content = (message as Record<string, unknown>).content;
  // qwen 在触发内容安全时会返回空 content，此时必须报错而不是当成成功
  if (typeof content !== "string" || content.trim().length === 0) {
    throw providerError(
      "MODEL_UNAVAILABLE",
      "模型返回了空内容",
      `模型 ${model} 的 content 为空。可能是提示词触发了内容安全策略，或输出被截断。`,
    );
  }

  return content;
}

/**
 * 从 embeddings 响应里取出向量，并**逐个校验维度**。
 *
 * 任务书第六节的硬约束：维度不符必须明确报错，禁止截断 / padding / 静默转换。
 * 三者都会产出一个「能写进库、但语义已经错位」的向量 —— 错位的向量不会报错，
 * 它只会让检索结果悄悄变差，是最难发现的一类故障。
 *
 * 顺序按响应里的 `index` 还原，而不是依赖数组顺序：OpenAI 兼容协议不保证
 * 返回顺序与提交顺序一致，而调用方（索引服务）是靠下标把向量对回 chunk 的，
 * 错位会让「A 的向量挂到 B 的内容上」—— 检索结果看起来正常，内容却对不上。
 */
function readEmbeddings(
  payload: unknown,
  model: string,
  expectedCount: number,
): number[][] {
  if (typeof payload !== "object" || payload === null) {
    throw providerError(
      "MODEL_UNAVAILABLE",
      "模型返回了无法解析的响应",
      `模型 ${model} 的 embeddings 响应不是 JSON 对象`,
    );
  }

  const record = payload as Record<string, unknown>;

  // 200 但带业务错误码（与 chat 同一套收敛规则）
  const errorField = record.error;
  if (typeof errorField === "object" && errorField !== null) {
    const errorRecord = errorField as Record<string, unknown>;
    const code = typeof errorRecord.code === "string" ? errorRecord.code : "unknown";
    const message =
      typeof errorRecord.message === "string" ? errorRecord.message : "未知错误";
    throw mapApiError(code, message, model);
  }
  if (typeof record.code === "string" && record.data === undefined) {
    const message = typeof record.message === "string" ? record.message : "";
    throw mapApiError(record.code, message, model);
  }

  const data = record.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw providerError(
      "MODEL_UNAVAILABLE",
      "模型没有返回任何向量",
      `模型 ${model} 的 embeddings 响应缺少 data`,
    );
  }

  const vectors: number[][] = new Array(expectedCount);
  for (const item of data) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const raw = entry.embedding;
    const index = typeof entry.index === "number" ? entry.index : null;

    if (!Array.isArray(raw)) {
      throw providerError(
        "MODEL_UNAVAILABLE",
        "模型返回的向量结构异常",
        `模型 ${model} 的 data[].embedding 不是数组`,
      );
    }
    if (raw.length !== EMBEDDING_DIMENSIONS) {
      throw providerError(
        "VALIDATION_FAILED",
        `模型返回的向量维度不是 ${EMBEDDING_DIMENSIONS}`,
        `模型 ${model} 返回了 ${raw.length} 维向量，而数据库列是 vector(${EMBEDDING_DIMENSIONS})。` +
          "请把 AI_MODEL_EMBEDDING 换成本项目支持的模型，或把该模型的 dimensions 参数设为 " +
          `${EMBEDDING_DIMENSIONS}。**不做截断或补齐**：截断/补出来的向量语义已经错位，` +
          "写进库里只会让检索悄悄变差。",
      );
    }
    const vector = raw.map((value) => (typeof value === "number" ? value : Number.NaN));
    if (vector.some((value) => !Number.isFinite(value))) {
      throw providerError(
        "MODEL_UNAVAILABLE",
        "模型返回的向量包含非法数值",
        `模型 ${model} 的向量里出现了非有限数`,
      );
    }

    if (index !== null && index >= 0 && index < expectedCount) {
      vectors[index] = vector;
    } else {
      // 没有可用的 index（协议变体）：按到达顺序补空位，至少不丢数据
      const slot = vectors.findIndex((item) => item === undefined);
      vectors[slot === -1 ? 0 : slot] = vector;
    }
  }

  const missing = vectors.findIndex((item) => item === undefined);
  if (missing !== -1) {
    throw providerError(
      "MODEL_UNAVAILABLE",
      "模型返回的向量数量不足",
      `模型 ${model} 提交了 ${expectedCount} 条文本，只取回 ${data.length} 条向量`,
    );
  }

  return vectors;
}

/** 单行 SSE：`data: {...}` / `data: [DONE]`，解析出增量文本 */
function parseStreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const choices = (parsed as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return null;
    }
    const delta = (choices[0] as Record<string, unknown> | undefined)?.delta;
    if (typeof delta !== "object" || delta === null) {
      return null;
    }
    const content = (delta as Record<string, unknown>).content;
    return typeof content === "string" && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

/**
 * 创建 DashScope Provider。
 *
 * 配置在**创建时**校验（缺 Key 立即抛出），而不是等到第一次调用 ——
 * 这样「AI_PROVIDER=dashscope 但没配 key」会在流程一开始就暴露，
 * 不会出现「任务建了、商品状态改成 analyzing 了，然后才失败」的尴尬。
 */
export function createDashScopeProvider(
  options: DashScopeProviderOptions = {},
): AIProvider {
  const config = resolveConfig(options);
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  function modelFor(tier: ModelTier): string {
    return config.models[tier];
  }

  /**
   * 发起一次 chat/completions 调用（非流式）。
   * 返回纯文本；失败一律抛 AppError。
   */
  async function callChat(
    request: ChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);

    // 调用方的取消信号要能穿透进来（页面切走、请求超时等）
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    try {
      const url = `${config.baseUrl}/chat/completions`;
      const init: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      };

      let response: Response;
      try {
        response = await doFetch(url, init);
      } catch (cause) {
        // 瞬时断连只重试一次；取消或超时仍立即交给外层处理。
        if (controller.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) {
          throw cause;
        }
        // 进程被禁止联网时重试也无法成功，直接给出明确原因。
        if (networkPermissionCode(cause)) throw cause;
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        if (controller.signal.aborted) {
          throw cause;
        }
        response = await doFetch(url, init);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw mapHttpError(response.status, body, request.model);
      }

      const payload: unknown = await response.json();
      return readCompletionText(payload, request.model);
    } catch (cause) {
      if (cause instanceof AppError) {
        throw cause;
      }
      if (timedOut) {
        throw providerError(
          "MODEL_TIMEOUT",
          "模型响应超时，请稍后重试",
          `模型 ${request.model} 超过 ${config.timeoutMs}ms 未返回`,
        );
      }
      if (signal?.aborted) {
        throw providerError(
          "MODEL_TIMEOUT",
          "模型调用已被取消",
          `模型 ${request.model} 的请求被调用方中止`,
        );
      }
      const permissionCode = networkPermissionCode(cause);
      if (permissionCode) {
        throw new AppError({
          code: "MODEL_UNAVAILABLE",
          message: "当前服务进程无法访问模型网络，请在允许联网的终端重新启动项目",
          detail: `模型 ${request.model} 的网络访问被系统拒绝（${permissionCode}）`,
          retryable: false,
        });
      }
      throw providerError(
        "MODEL_UNAVAILABLE",
        "模型服务暂时不可用，请稍后重试",
        `模型 ${request.model} 请求失败：${describe(cause)}`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** 纯文本生成；抽成局部函数是为了让 generateObject 复用而不依赖 this 绑定 */
  async function generateTextImpl(input: GenerateTextInput): Promise<string> {
    const model = modelFor(input.tier ?? "fast");
    return callChat(
      buildChatRequest(
        model,
        [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        {
          temperature: input.temperature,
          maxOutputTokens: input.maxOutputTokens,
        },
      ),
      input.signal,
    );
  }

  /**
   * 发起一次 embeddings 调用（单批，不超过 `DASHSCOPE_EMBEDDING_MAX_BATCH`）。
   *
   * 显式传 `dimensions: EMBEDDING_DIMENSIONS`：text-embedding-v3 支持自定义维度，
   * 不传的话拿到的是模型默认维度 —— 一旦默认值不是 1024，写库就会被数据库拒绝
   * （列是定长 vector(1024)），而错误信息会指向数据库而不是这里的参数缺失，
   * 排查起来要多绕一圈。
   */
  async function callEmbeddings(
    values: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<number[][]> {
    const model = modelFor("embedding");
    const body = {
      model,
      input: values,
      dimensions: EMBEDDING_DIMENSIONS,
      encoding_format: "float",
    };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);

    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    try {
      const url = `${config.baseUrl}/embeddings`;
      const init: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      };
      let response: Response;
      try {
        response = await doFetch(url, init);
      } catch (cause) {
        // Only retry a transport failure once, within the original timeout budget.
        // Permissions, cancellation and HTTP errors cannot be repaired by retrying.
        if (controller.signal.aborted || networkPermissionCode(cause) ||
            (cause instanceof Error && cause.name === "AbortError")) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 250));
        response = await doFetch(url, init);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw mapHttpError(response.status, text, model);
      }

      const payload: unknown = await response.json();
      return readEmbeddings(payload, model, values.length);
    } catch (cause) {
      if (cause instanceof AppError) {
        throw cause;
      }
      if (timedOut) {
        throw providerError(
          "MODEL_TIMEOUT",
          "向量化响应超时，请稍后重试",
          `模型 ${model} 超过 ${config.timeoutMs}ms 未返回`,
        );
      }
      if (signal?.aborted) {
        throw providerError(
          "MODEL_TIMEOUT",
          "向量化调用已被取消",
          `模型 ${model} 的请求被调用方中止`,
        );
      }
      const permissionCode = networkPermissionCode(cause);
      if (permissionCode) {
        throw new AppError({
          code: "MODEL_UNAVAILABLE",
          message: "当前服务进程无法访问模型网络，请在允许联网的终端重新启动项目",
          detail: `模型 ${model} 的向量请求被运行环境拦截：${permissionCode}`,
          retryable: false,
        });
      }
      throw providerError(
        "MODEL_UNAVAILABLE",
        "向量化服务暂时不可用，请稍后重试",
        `模型 ${model} 请求失败：${describe(cause)}`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  return {
    id: options.id ?? DASHSCOPE_PROVIDER_ID,

    generateText: generateTextImpl,

    /**
     * 结构化输出。
     * 这里**不重复实现纠错逻辑** —— 那是 `agent-output.ts` 的职责；
     * 本方法只负责「拿到文本 → 提取 JSON → 校验」，失败就抛 SCHEMA_INVALID，
     * 由调用链决定是否回喂重试（Agent 走的就是那条路）。
     */
    async generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
      const raw = await generateTextImpl({
        system: input.system,
        prompt: input.prompt,
        ...(input.tier === undefined ? {} : { tier: input.tier }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: input.maxOutputTokens }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      const parsed = parseAgentObject(raw, input.schema);
      if (!parsed.ok) {
        throw new AppError(parsed.error);
      }
      return parsed.data;
    },

    async streamText(input: StreamTextInput): Promise<ReadableStream<string>> {
      const model = modelFor(input.tier ?? "fast");
      const request = buildChatRequest(
        model,
        [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
        {
          temperature: input.temperature,
          maxOutputTokens: input.maxOutputTokens,
          stream: true,
        },
      );

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs);
      const onCallerAbort = () => controller.abort();
      if (input.signal) {
        if (input.signal.aborted) {
          controller.abort();
        } else {
          input.signal.addEventListener("abort", onCallerAbort, { once: true });
        }
      }

      const cleanup = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onCallerAbort);
      };

      let response: Response;
      try {
        response = await doFetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (cause) {
        cleanup();
        if (timedOut) {
          throw providerError(
            "MODEL_TIMEOUT",
            "模型响应超时，请稍后重试",
            `模型 ${model} 超过 ${config.timeoutMs}ms 未返回`,
          );
        }
        throw providerError(
          "MODEL_UNAVAILABLE",
          "模型服务暂时不可用，请稍后重试",
          `模型 ${model} 流式请求失败：${describe(cause)}`,
        );
      }

      if (!response.ok) {
        cleanup();
        const body = await response.text().catch(() => "");
        throw mapHttpError(response.status, body, model);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        cleanup();
        throw providerError(
          "MODEL_UNAVAILABLE",
          "模型未返回可读的流式响应",
          `模型 ${model} 的响应 body 为空`,
        );
      }

      const decoder = new TextDecoder();
      let buffer = "";

      return new ReadableStream<string>({
        async pull(streamController) {
          for (;;) {
            const { done, value } = await reader.read();

            if (done) {
              // 收尾：把 buffer 里残留的最后一行也处理掉
              const tail = parseStreamLine(buffer);
              if (tail) {
                streamController.enqueue(tail);
              }
              cleanup();
              streamController.close();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            let emitted = false;
            for (const line of lines) {
              const piece = parseStreamLine(line);
              if (piece) {
                streamController.enqueue(piece);
                input.onChunk?.(piece);
                emitted = true;
              }
            }
            // 有产出就先交还给消费者，避免一直读到流结束
            if (emitted) {
              return;
            }
          }
        },
        cancel() {
          cleanup();
          void reader.cancel();
        },
      });
    },

    /** 图像理解：商品图片分析的入口（Product Agent 的第一步） */
    async analyzeImage(input: AnalyzeImageInput): Promise<string> {
      if (input.imageUrls.length === 0) {
        throw providerError(
          "VALIDATION_FAILED",
          "没有可分析的图片",
          "imageUrls 为空，调用方应先判断商品是否已上传图片",
        );
      }

      const model = modelFor(input.tier ?? "vision");
      const content: Array<ChatTextPart | ChatImagePart> = [
        { type: "text", text: input.prompt },
        ...input.imageUrls.map<ChatImagePart>((url) => ({
          type: "image_url",
          image_url: { url: toImageUrl(url) },
        })),
      ];

      return callChat(
        buildChatRequest(
          model,
          [
            { role: "system", content: input.system },
            { role: "user", content },
          ],
          // 视觉描述是自由文本，给一点温度让表述更自然
          { temperature: 0.3 },
        ),
        input.signal,
      );
    },

    /**
     * 文本向量化（RAG 检索的入口）。
     *
     * 批处理分两层：
     * - **本方法内部**按 `DASHSCOPE_EMBEDDING_MAX_BATCH` 切分（协议硬限制，超限 400）；
     * - **调用方（索引服务）**控制并发上限（3~5），避免把配额瞬间打满变成一串 429。
     * 两层各管各的，不互相代劳。
     *
     * 空文本直接拒绝而不是返回零向量：空串的向量在检索里会随机命中，
     * 那比「报错」糟糕得多 —— 它会让一次本该失败的索引看起来成功了。
     */
    async embed(input: EmbedInput): Promise<number[][]> {
      if (input.values.length === 0) {
        return [];
      }

      const emptyIndex = input.values.findIndex((value) => value.trim().length === 0);
      if (emptyIndex !== -1) {
        throw providerError(
          "VALIDATION_FAILED",
          "存在空文本，无法向量化",
          `第 ${emptyIndex + 1} 条文本为空。切片阶段应保证每段都非空。`,
        );
      }

      const results: number[][] = [];
      for (
        let start = 0;
        start < input.values.length;
        start += DASHSCOPE_EMBEDDING_MAX_BATCH
      ) {
        const batch = input.values.slice(
          start,
          start + DASHSCOPE_EMBEDDING_MAX_BATCH,
        );
        const vectors = await callEmbeddings(batch, input.signal);
        results.push(...vectors);
      }
      return results;
    },
  };
}
