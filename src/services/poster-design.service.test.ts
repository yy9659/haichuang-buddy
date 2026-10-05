import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/result";
import { buildMockPosterDesign, buildPosterDesignPrompt } from "@/ai/prompts/poster-design";
import type { PosterDesignRequest } from "@/lib/poster-design";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), product: vi.fn(), owns: vi.fn(), content: vi.fn(), agent: vi.fn(), create: vi.fn(), poll: vi.fn(), read: vi.fn(), save: vi.fn(), image: vi.fn(), pending: vi.fn() }));
vi.mock("./auth.service", () => ({ getCurrentAuthUser: mocks.auth }));
vi.mock("@/repositories", () => ({ getRepositories: () => ({ products: { getById: mocks.product, belongsToBusiness: mocks.owns }, content: { findBySlot: mocks.content }, brand: { getProfile: async () => null }, productDna: { getByProductId: async () => null } }) }));
vi.mock("@/ai/agents/poster-design-agent", () => ({ runPosterDesignAgent: mocks.agent }));
vi.mock("@/ai/provider", () => ({ createWanxiangImageProvider: () => ({ model: "wan2.6-t2i", create: mocks.create, poll: mocks.poll }), getAIProviderStatus: () => ({ usable: true, isMock: false }), getWanxiangStatus: () => ({ available: true }) }));
vi.mock("@/storage/poster-background", () => ({ findPendingPosterBackground: mocks.pending, readPosterBackgroundJob: mocks.read, savePosterBackgroundJob: mocks.save, savePosterBackgroundImage: mocks.image }));
import { designPoster, startPosterBackground, pollPosterBackground } from "./poster-design.service";

const design = buildMockPosterDesign(buildPosterDesignPrompt({ request: { instruction: "温馨", previous: null } }));
const request: PosterDesignRequest = { slot: { productId: "p1", platform: "wechat", format: "poster-copy" }, copy: { title: "今日鱼丸", subtitle: "晚餐好选择", sellingPoints: ["500g家庭装"], cta: "来店选购" }, instruction: "更温馨", previous: design, size: "portrait" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "u1", businessId: "b1" });
  mocks.owns.mockResolvedValue(true);
  mocks.product.mockResolvedValue({ id: "p1", name: "鱼丸", price: 45, unit: "袋", tags: [], imageUrl: "/api/product-images/p.png" });
  mocks.content.mockResolvedValue({ id: "c1", title: "已保存标题", hook: "已保存开头", body: "已保存正文", cta: "来店看看", visualSuggestions: ["商品实拍"], shotList: [] });
  mocks.agent.mockResolvedValue({ ok: true, data: { design, isMock: false, providerLabel: "通义千问" } });
  mocks.create.mockResolvedValue("task-background-123");
});
describe("海报设计服务", () => {
  it("未登录不能调用模型或提交图像任务", async () => {
    mocks.auth.mockResolvedValue(null);
    const result = await designPoster(request);
    expect(!result.ok && result.error.code).toBe("UNAUTHORIZED");
    expect((await startPosterBackground(request)).ok).toBe(false);
    expect(mocks.agent).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("模型使用服务端商品事实和当前编辑文案", async () => {
    const sourceCopy = { title: "家常鱼丸", hook: "全家围坐的晚餐", body: "新编辑但尚未保存的正文：暖色家常餐桌，重点介绍煮汤吃法。", cta: "今晚来店选购" };
    expect((await designPoster({ ...request, sourceCopy })).ok).toBe(true);
    expect(mocks.agent.mock.calls[0][0].product.price).toBe(45);
    expect(mocks.agent.mock.calls[0][0].request.copy.title).toBe("今日鱼丸");
    expect(mocks.agent.mock.calls[0][0].request.sourceCopy).toEqual(sourceCopy);
    expect(mocks.agent.mock.calls[0][0].visualSuggestions).toEqual(["商品实拍"]);
  });
  it("旧请求没有完整文案时读取保存的正文作为设计依据", async () => {
    expect((await designPoster(request)).ok).toBe(true);
    expect(mocks.agent.mock.calls[0][0].request.sourceCopy).toEqual({ title: "已保存标题", hook: "已保存开头", body: "已保存正文", cta: "来店看看" });
  });
  it("非海报素材和过长正文不会消耗模型或图像请求", async () => {
    const video = { ...request, slot: { ...request.slot, format: "short-video" as const } };
    expect((await designPoster(video)).ok).toBe(false);
    expect((await startPosterBackground(video)).ok).toBe(false);
    expect((await designPoster({ ...request, sourceCopy: { title: "鱼丸", hook: "好好吃饭", body: "字".repeat(5001), cta: "来选购" } })).ok).toBe(false);
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("无商品照片或丢失素材时不消耗模型请求", async () => {
    mocks.product.mockResolvedValue({ price: 45, unit: "袋", imageUrl: null });
    expect((await designPoster(request)).ok).toBe(false);
    mocks.content.mockResolvedValue(null);
    expect((await designPoster(request)).ok).toBe(false);
    expect(mocks.agent).not.toHaveBeenCalled();
  });
  it("已有相同设计的任务时复用，不重复创建付费图像", async () => {
    mocks.pending.mockResolvedValue({ id: "existing", status: "running" });
    const result = await startPosterBackground(request);
    expect(result).toMatchObject({ ok: true, data: { id: "existing", status: "running" } });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("成功结果存到本站，查询不再次提交文生图", async () => {
    mocks.read.mockResolvedValue({ id: "job", businessId: "b1", productId: "p1", status: "running", taskId: "task-background-123", createdAt: Date.now() });
    mocks.poll.mockResolvedValue({ status: "completed", imageUrl: "https://x.aliyuncs.com/bg.png" });
    mocks.image.mockResolvedValue("/api/poster-backgrounds/job");
    const result = await pollPosterBackground("job");
    expect(mocks.read).toHaveBeenCalledWith("job", "b1");
    expect(result).toMatchObject({ ok: true, data: { imageUrl: "/api/poster-backgrounds/job" } });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0][0].status).toBe("completed");
  });
  it("跨商户任务和终止任务不会继续查询模型", async () => {
    mocks.read.mockRejectedValue(new AppError({ code: "NOT_FOUND", message: "没有记录" }));
    expect((await pollPosterBackground("foreign")).ok).toBe(false);
    expect(mocks.poll).not.toHaveBeenCalled();
    mocks.owns.mockResolvedValue(false);
    expect((await designPoster(request)).ok).toBe(false);
    expect(mocks.agent).not.toHaveBeenCalled();
  });
});
