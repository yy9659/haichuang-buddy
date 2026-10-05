import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerEnvCache } from "@/lib/env";
import { createWanxiangImageProvider, getWanxiangStatus } from "./wanxiang";

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "dashscope");
  vi.stubEnv("WANXIANG_API_KEY", "test-image-key");
  vi.stubEnv("WANXIANG_BASE_URL", "");
  vi.stubEnv("WANXIANG_MODEL", "wan2.6-t2i");
  vi.stubEnv("DASHSCOPE_BASE_URL", "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  resetServerEnvCache();
});
afterEach(() => { vi.unstubAllEnvs(); resetServerEnvCache(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("通义万相创意背景", () => {
  it("现代异步接口保留凭证地域，只生成一张无商品无字的背景", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ output: { task_id: "task-background-123" } }));
    await expect(createWanxiangImageProvider(fetcher).create("暖色餐桌留白", "portrait")).resolves.toBe("task-background-123");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/image-generation/generation");
    expect(init.headers.Authorization).toBe("Bearer test-image-key");
    expect(init.headers["X-DashScope-Async"]).toBe("enable");
    const body = JSON.parse(init.body);
    expect(body.parameters.n).toBe(1);
    expect(body.parameters.size).toBe("1104*1472");
    expect(body.input.messages[0].content[0].text).toContain("不含商品");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("支持较早的图像模型及其结果格式", async () => {
    vi.stubEnv("WANXIANG_MODEL", "wan2.2-t2i-flash"); resetServerEnvCache();
    const fetcher = vi.fn().mockResolvedValueOnce(response({ output: { task_id: "task-background-123" } })).mockResolvedValueOnce(response({ output: { task_status: "SUCCEEDED", results: [{ url: "https://assets.oss-cn-beijing.aliyuncs.com/a.png" }] } }));
    const provider = createWanxiangImageProvider(fetcher);
    await provider.create("海洋纹理", "square");
    expect(fetcher.mock.calls[0][0]).toContain("text2image/image-synthesis");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).parameters.size).toBe("1024*1024");
    expect((await provider.poll("task-background-123")).imageUrl).toContain("a.png");
  });
  it("查询进行中及现代成功响应，不重复创建任务", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ output: { task_status: "RUNNING" } })).mockResolvedValueOnce(response({ output: { task_status: "SUCCEEDED", choices: [{ message: { content: [{ image: "https://x.aliyuncs.com/bg.png" }] } }] } }));
    const provider = createWanxiangImageProvider(fetcher);
    expect((await provider.poll("task-background-123")).status).toBe("running");
    expect((await provider.poll("task-background-123")).imageUrl).toContain("bg.png");
    expect(fetcher.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
  it("凭证与终止任务错误使用商户可理解的提示", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ code: "InvalidApiKey", message: "raw private detail" }, 401)).mockResolvedValueOnce(response({ output: { task_status: "FAILED" } }));
    const provider = createWanxiangImageProvider(fetcher);
    await expect(provider.create("留白", "square")).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("凭证或权限") });
    await expect(provider.poll("task-background-123")).rejects.toMatchObject({ retryable: false });
  });
  it("演示模式禁止真实文生图，非法接口地址不发送请求", () => {
    vi.stubEnv("AI_PROVIDER", "mock"); resetServerEnvCache();
    expect(getWanxiangStatus().available).toBe(false);
    expect(() => createWanxiangImageProvider()).toThrow("演示模式");
    vi.stubEnv("AI_PROVIDER", "dashscope"); vi.stubEnv("WANXIANG_BASE_URL", "http://localhost/private"); resetServerEnvCache();
    expect(() => createWanxiangImageProvider()).toThrow("接口地址");
  });
});
