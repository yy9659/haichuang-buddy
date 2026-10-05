import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { findPendingPosterBackground, readPosterBackgroundImage, readPosterBackgroundJob, savePosterBackgroundImage, savePosterBackgroundJob } from "./poster-background";

const workspace = process.cwd();
let directory: string;
const id = "a".repeat(32);
const job = { id, businessId: "b1", productId: "p1", contentId: "c1", taskId: "task-123", model: "wan2.6-t2i", status: "pending" as const, createdAt: Date.now(), requestKey: "design-key" };
beforeEach(async () => {
  await mkdir(path.join(workspace, ".data"), { recursive: true });
  directory = await mkdtemp(path.join(workspace, ".data", "poster-storage-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  const root = path.resolve(workspace, ".data") + path.sep;
  if (!path.resolve(directory).startsWith(root)) throw new Error("Unexpected test directory");
  await rm(directory, { recursive: true, force: true });
});
describe("背景文件存储", () => {
  it("持久化任务、原子更新和商户隔离", async () => {
    await savePosterBackgroundJob(job);
    await savePosterBackgroundJob({ ...job, status: "running" });
    expect((await readPosterBackgroundJob(id, "b1")).status).toBe("running");
    expect((await findPendingPosterBackground("b1", "design-key"))?.id).toBe(id);
    expect(await findPendingPosterBackground("b2", "design-key")).toBeUndefined();
    await expect(readPosterBackgroundJob(id, "b2")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readPosterBackgroundJob("../outside", "b1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readPosterBackgroundImage(id, "b1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("只接受百炼 PNG，阻止跳转和过大的下载", async () => {
    const fetcher = vi.fn();
    await expect(savePosterBackgroundImage(id, "http://127.0.0.1/private", fetcher)).rejects.toThrow("无效的背景地址");
    await expect(savePosterBackgroundImage(id, "https://evil.com/image.png", fetcher)).rejects.toThrow("无效的背景地址");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response("bad", { headers: { "Content-Length": String(11 * 1024 * 1024) } }));
    await expect(savePosterBackgroundImage(id, "https://x.aliyuncs.com/bg.png", fetcher)).rejects.toThrow("未能保存");
    fetcher.mockResolvedValue(new Response("not an image"));
    await expect(savePosterBackgroundImage(id, "https://x.aliyuncs.com/bg.png", fetcher)).rejects.toThrow("格式不正确");
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
  });
  it("成功图片转存到本站，并且只能由原商户读取", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
    const fetcher = vi.fn().mockResolvedValue(new Response(png));
    const imageUrl = await savePosterBackgroundImage(id, "https://x.aliyuncs.com/bg.png", fetcher);
    await savePosterBackgroundJob({ ...job, status: "completed", imageUrl });
    expect(imageUrl).toBe(`/api/poster-backgrounds/${id}`);
    expect(Buffer.from(await readPosterBackgroundImage(id, "b1"))).toEqual(png);
    await expect(readPosterBackgroundImage(id, "b2")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
