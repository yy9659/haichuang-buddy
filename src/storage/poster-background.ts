import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AppError } from "@/lib/result";

export const POSTER_ASSET_ID = /^[a-f0-9]{32}$/;
const root = () => path.join(process.cwd(), ".data", "poster-backgrounds");
const JobSchema = z.object({ id: z.string().regex(POSTER_ASSET_ID), businessId: z.string(), contentId: z.string(), productId: z.string(), taskId: z.string(), createdAt: z.number(), model: z.string(), requestKey: z.string().optional(), status: z.enum(["pending", "running", "completed", "error"]), imageUrl: z.string().optional() });
export type PosterBackgroundJob = z.infer<typeof JobSchema>;

export async function savePosterBackgroundJob(job: PosterBackgroundJob): Promise<void> {
  const data = JobSchema.parse(job);
  await mkdir(root(), { recursive: true });
  const temporary = path.join(root(), `${data.id}-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(data), { flag: "wx" });
  await rename(temporary, path.join(root(), `${data.id}.json`));
}
export async function readPosterBackgroundJob(id: string, businessId: string): Promise<PosterBackgroundJob> {
  if (!POSTER_ASSET_ID.test(id)) throw new AppError({ code: "NOT_FOUND", message: "没有找到这次背景生成记录。" });
  let data: PosterBackgroundJob;
  try { data = JobSchema.parse(JSON.parse(await readFile(path.join(root(), `${id}.json`), "utf8"))); }
  catch { throw new AppError({ code: "NOT_FOUND", message: "没有找到这次背景生成记录。" }); }
  if (data.id !== id || data.businessId !== businessId) throw new AppError({ code: "NOT_FOUND", message: "没有找到这次背景生成记录。" });
  return data;
}

/** 对同一商户、同一设计尚未完成的提交复用任务，避免重复点击再次计费。 */
export async function findPendingPosterBackground(businessId: string, requestKey: string): Promise<PosterBackgroundJob | undefined> {
  const files = await readdir(root()).catch(() => [] as string[]);
  for (const file of files) {
    const id = file.replace(/\.json$/, "");
    if (!file.endsWith(".json") || !POSTER_ASSET_ID.test(id)) continue;
    try {
      const job = await readPosterBackgroundJob(id, businessId);
      if (job.requestKey === requestKey && (job.status === "pending" || job.status === "running") && Date.now() - job.createdAt < 24 * 60 * 60 * 1000) return job;
    } catch { /* 其他商户或未完成写入的记录不参与复用。 */ }
  }
}

/** 只转存百炼结果域名的 PNG；浏览器从本站读取，避免跨域和临时链接失效。 */
export async function savePosterBackgroundImage(id: string, url: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!POSTER_ASSET_ID.test(id)) throw new AppError({ code: "VALIDATION_FAILED", message: "背景记录无效。" });
  const source = new URL(url);
  if (source.protocol !== "https:" || source.username || source.password || !source.hostname.endsWith(".aliyuncs.com")) throw new AppError({ code: "MODEL_UNAVAILABLE", message: "图像模型返回了无效的背景地址。" });
  const response = await fetcher(source, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  const limit = 10 * 1024 * 1024;
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) throw new AppError({ code: "STORAGE_ERROR", message: "背景图片未能保存，请重新查询结果。" });
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new AppError({ code: "STORAGE_ERROR", message: "背景图片过大，无法使用。" });
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const image = Buffer.concat(chunks);
  if (image.length < 24 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || image.readUInt32BE(16) < 1 || image.readUInt32BE(20) < 1 || image.readUInt32BE(16) > 4096 || image.readUInt32BE(20) > 4096) throw new AppError({ code: "STORAGE_ERROR", message: "背景图片格式不正确，无法使用。" });
  await mkdir(root(), { recursive: true });
  const temporary = path.join(root(), `${id}-${randomUUID()}.tmp`);
  await writeFile(temporary, image, { flag: "wx" });
  await rename(temporary, path.join(root(), `${id}.png`));
  return `/api/poster-backgrounds/${id}`;
}
export async function readPosterBackgroundImage(id: string, businessId: string): Promise<Uint8Array> {
  const job = await readPosterBackgroundJob(id, businessId);
  if (job.status !== "completed") throw new AppError({ code: "NOT_FOUND", message: "背景图片还未准备好。" });
  return new Uint8Array(await readFile(path.join(root(), `${id}.png`)));
}
