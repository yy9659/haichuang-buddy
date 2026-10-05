import { createHash, randomUUID } from "node:crypto";
import { runPosterDesignAgent } from "@/ai/agents/poster-design-agent";
import { getAIProviderStatus, createWanxiangImageProvider, getWanxiangStatus } from "@/ai/provider";
import { PosterDesignRequestSchema, type PosterDesignRequest, type PosterDesignResult } from "@/lib/poster-design";
import { getPosterIssue } from "@/lib/product-poster";
import { AppError, attempt, toAppError, type Result } from "@/lib/result";
import { getRepositories } from "@/repositories";
import { findPendingPosterBackground, readPosterBackgroundJob, savePosterBackgroundImage, savePosterBackgroundJob, type PosterBackgroundJob } from "@/storage/poster-background";
import { getCurrentAuthUser } from "./auth.service";

async function authenticated() {
  const user = await getCurrentAuthUser();
  if (!user) throw new AppError({ code: "UNAUTHORIZED", message: "请先登录后再设计海报。" });
  return user;
}
async function context(input: PosterDesignRequest) {
  const user = await authenticated();
  const request = PosterDesignRequestSchema.parse(input);
  if (request.slot.format !== "poster-copy") throw new AppError({ code: "VALIDATION_FAILED", message: "请选择海报文案，再设计营销海报。" });
  const repositories = getRepositories();
  const [product, content, brand, dna] = await Promise.all([repositories.products.getById(request.slot.productId), repositories.content.findBySlot(request.slot), repositories.brand.getProfile(), repositories.productDna.getByProductId(request.slot.productId)]);
  if (!product || !content || !await repositories.products.belongsToBusiness(user.businessId, request.slot.productId)) throw new AppError({ code: "NOT_FOUND", message: "商品或素材已不存在，请刷新页面。" });
  const issue = getPosterIssue(product, request.copy);
  if (issue) throw new AppError({ code: "VALIDATION_FAILED", message: issue });
  request.sourceCopy ??= { title: content.title, hook: content.hook, body: content.body, cta: content.cta };
  return { user, request, product, content, brand, dna };
}
export async function getPosterDesignCapabilities() {
  await authenticated();
  const text = getAIProviderStatus();
  return { designAvailable: text.usable, isMock: text.isMock, background: getWanxiangStatus() };
}
export async function designPoster(input: PosterDesignRequest): Promise<Result<PosterDesignResult>> {
  return attempt(async () => {
    const { request, product, content, brand, dna } = await context(input);
    const outcome = await runPosterDesignAgent({ request, product: { name: product.name, category: product.category, specification: product.specification, price: product.price, unit: product.unit, tags: product.tags, visualFeatures: dna?.visualFeatures ?? [], targetUsers: dna?.targetUsers ?? [] }, brand: brand ? { positioning: brand.positioning, audience: brand.targetAudience, visualKeywords: brand.visualKeywords } : null, visualSuggestions: content.visualSuggestions, layoutSuggestions: content.shotList });
    if (!outcome.ok) throw new AppError(outcome.error);
    return outcome.data;
  }, (cause) => toAppError(cause, "VALIDATION_FAILED", "海报设计未完成，请检查输入并重试。"));
}

export interface PosterBackgroundView { id: string; status: "pending" | "running" | "completed"; imageUrl?: string }
const working = new Set<string>();
export async function startPosterBackground(input: PosterDesignRequest): Promise<Result<PosterBackgroundView>> {
  return attempt(async () => {
    const { user, request, content } = await context(input);
    if (!request.previous) throw new AppError({ code: "VALIDATION_FAILED", message: "请先让 AI 设计海报，再生成背景。" });
    const lock = `${user.businessId}:${content.id}`;
    if (working.has(lock)) throw new AppError({ code: "RATE_LIMITED", message: "正在提交背景生成，请稍候。" });
    working.add(lock);
    try {
      const requestKey = createHash("sha256").update(JSON.stringify([content.id, request.size, request.previous.backgroundPrompt])).digest("hex");
      const existing = await findPendingPosterBackground(user.businessId, requestKey);
      if (existing) return { id: existing.id, status: existing.status as "pending" | "running" };
      const provider = createWanxiangImageProvider();
      const taskId = await provider.create(request.previous.backgroundPrompt, request.size);
      const job: PosterBackgroundJob = { id: randomUUID().replaceAll("-", ""), businessId: user.businessId, contentId: content.id, productId: request.slot.productId, taskId, model: provider.model, requestKey, status: "pending", createdAt: Date.now() };
      await savePosterBackgroundJob(job);
      return { id: job.id, status: "pending" };
    } finally { working.delete(lock); }
  }, (cause) => toAppError(cause, "MODEL_UNAVAILABLE", "创意背景暂时未生成，当前海报仍可使用。"));
}
export async function pollPosterBackground(id: string): Promise<Result<PosterBackgroundView>> {
  return attempt(async () => {
    const user = await authenticated();
    const job = await readPosterBackgroundJob(id, user.businessId);
    const product = await getRepositories().products.getById(job.productId);
    if (!product || !await getRepositories().products.belongsToBusiness(user.businessId, job.productId)) throw new AppError({ code: "NOT_FOUND", message: "关联商品已不存在。" });
    if (job.status === "completed") return { id, status: "completed", imageUrl: job.imageUrl };
    if (job.status === "error" || Date.now() - job.createdAt > 24 * 60 * 60 * 1000) throw new AppError({ code: "MODEL_UNAVAILABLE", message: "本次背景任务已结束或过期，请重新生成。" });
    let result: Awaited<ReturnType<ReturnType<typeof createWanxiangImageProvider>["poll"]>>;
    try { result = await createWanxiangImageProvider().poll(job.taskId); }
    catch (cause) {
      if (cause instanceof AppError && !cause.retryable) await savePosterBackgroundJob({ ...job, status: "error" });
      throw cause;
    }
    let imageUrl: string | undefined;
    if (result.status === "completed" && result.imageUrl) imageUrl = await savePosterBackgroundImage(id, result.imageUrl);
    await savePosterBackgroundJob({ ...job, status: result.status, ...(imageUrl ? { imageUrl } : {}) });
    return { id, status: result.status, ...(imageUrl ? { imageUrl } : {}) };
  }, (cause) => toAppError(cause, "MODEL_UNAVAILABLE", "背景查询未完成，请稍后继续查询。"));
}
