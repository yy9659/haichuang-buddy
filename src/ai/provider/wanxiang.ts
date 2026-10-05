import { getServerEnv, resolveDashScopeApiKey } from "@/lib/env";
import { AppError } from "@/lib/result";
import type { PosterSize } from "@/lib/product-poster";

type TaskStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";
interface TaskResponse { code?: string; message?: string; output?: { task_id?: string; task_status?: TaskStatus; code?: string; message?: string; choices?: { message?: { content?: { image?: string }[] } }[]; results?: { url?: string }[] } }

export function getWanxiangStatus(): { available: boolean; reason?: string } {
  const env = getServerEnv();
  if (env.AI_PROVIDER === "mock") return { available: false, reason: "当前为演示模式，可体验设计变化；创意背景需要真实图像模型。" };
  if (!(env.WANXIANG_API_KEY || resolveDashScopeApiKey())) return { available: false, reason: "创意背景尚未配置图像模型。" };
  return { available: true };
}

function configuration() {
  const env = getServerEnv();
  if (!getWanxiangStatus().available) throw new AppError({ code: "VALIDATION_FAILED", message: getWanxiangStatus().reason ?? "创意背景不可用" });
  const source = env.WANXIANG_BASE_URL ?? env.DASHSCOPE_BASE_URL ?? env.AI_BASE_URL ?? "https://dashscope.aliyuncs.com";
  const base = new URL(source);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new AppError({ code: "VALIDATION_FAILED", message: "图像模型接口地址不正确，请检查配置。" });
  // 文本接口末尾的 compatible-mode/v1 不能用于文生图；保留配置的地域和业务空间。
  const root = env.WANXIANG_BASE_URL ? source.replace(/\/$/, "").replace(/\/api\/v1$/, "") : base.origin;
  return { root, model: env.WANXIANG_MODEL, key: env.WANXIANG_API_KEY ?? resolveDashScopeApiKey()! };
}

function responseError(status: number, code?: string): AppError {
  if (status === 401 || status === 403 || code === "InvalidApiKey") return new AppError({ code: "MODEL_UNAVAILABLE", message: "图像模型凭证或权限不可用，请检查百炼配置。", retryable: false });
  if (status === 429) return new AppError({ code: "RATE_LIMITED", message: "图像生成请求较多，请稍后重试。" });
  if (code && /Quota|Balance|Arrear|Limit/i.test(code)) return new AppError({ code: "QUOTA_EXCEEDED", message: "图像模型额度不足，请检查百炼账户。" });
  return new AppError({ code: "MODEL_UNAVAILABLE", message: "创意背景暂时未生成，请稍后重试；当前海报仍可使用。" });
}

export function createWanxiangImageProvider(fetcher: typeof fetch = fetch) {
  const config = configuration();
  async function call(path: string, init: RequestInit): Promise<TaskResponse> {
    try {
      const response = await fetcher(`${config.root}/api/v1/${path}`, { ...init, headers: { Authorization: `Bearer ${config.key}`, ...init.headers }, signal: AbortSignal.timeout(15_000) });
      const data = await response.json() as TaskResponse;
      if (!response.ok || data.code) throw responseError(response.status, data.code);
      return data;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError({ code: "MODEL_UNAVAILABLE", message: "图像服务连接失败，请稍后重试；当前海报仍可使用。" });
    }
  }
  return {
    model: config.model,
    async create(prompt: string, size: PosterSize): Promise<string> {
      const modern = config.model === "wan2.6-t2i";
      const text = `只生成一张纯环境背景照片或抽象纹理，不做海报、不做广告、不做文字排版。不含商品、不含食物、不含人物、不含任何汉字、英文字母、数字、标志或二维码。保持大面积干净留白。以下仅描述环境氛围：${prompt}`;
      const data = await call(modern ? "services/aigc/image-generation/generation" : "services/aigc/text2image/image-synthesis", {
        method: "POST", headers: { "Content-Type": "application/json", "X-DashScope-Async": "enable" },
        body: JSON.stringify({ model: config.model, input: modern ? { messages: [{ role: "user", content: [{ text }] }] } : { prompt: text }, parameters: { n: 1, size: config.model === "wan2.2-t2i-flash" ? (size === "square" ? "1024*1024" : "1024*1360") : (size === "square" ? "1280*1280" : "1104*1472"), prompt_extend: false, watermark: false, negative_prompt: "文字，汉字，英文字母，标语，标题，广告，数字，价格，商品，食物，人物，标志，二维码，拥挤的构图" } }),
      });
      const taskId = data.output?.task_id;
      if (!taskId || !/^[a-zA-Z0-9-]{10,100}$/.test(taskId)) throw responseError(502);
      return taskId;
    },
    async poll(taskId: string): Promise<{ status: "pending" | "running" | "completed"; imageUrl?: string }> {
      if (!/^[a-zA-Z0-9-]{10,100}$/.test(taskId)) throw responseError(400);
      const data = await call(`tasks/${taskId}`, { method: "GET" });
      const status = data.output?.task_status;
      if (status === "SUCCEEDED") {
        const imageUrl = data.output?.choices?.flatMap((choice) => choice.message?.content ?? []).find((c) => c.image)?.image ?? data.output?.results?.[0]?.url;
        if (!imageUrl) throw responseError(502);
        return { status: "completed", imageUrl };
      }
      if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") throw new AppError({ code: "MODEL_UNAVAILABLE", message: "本次创意背景未生成，请调整要求后重新生成；当前海报仍可使用。", retryable: false });
      if (status !== "PENDING" && status !== "RUNNING") throw responseError(502, data.output?.code);
      return { status: status === "PENDING" ? "pending" : "running" };
    },
  };
}
