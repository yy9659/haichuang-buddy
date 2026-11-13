import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { lockLocalDirectory } from "@/db/local-lock";

const sections = ["pgdata", "product-images", "poster-backgrounds"] as const;
type Entry = { path: string; bytes: number; sha256: string };
const marker = "buddy-backup.json";

async function directory(input: string) {
  const resolved = path.resolve(input);
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("仅支持普通目录");
  const actual = await realpath(resolved);
  if (path.parse(actual).root === actual) throw new Error("不能使用磁盘根目录");
  return actual;
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

async function freshPath(input: string, sources: string[]) {
  const resolved = path.resolve(input);
  const name = path.basename(resolved);
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name) || /[. ]$/.test(name)) throw new Error("目标名称无效");
  const parent = await realpath(path.dirname(resolved));
  const target = path.join(parent, name);
  const protectedPaths = await Promise.all([...sources, path.resolve("public")].map(async (source) =>
    realpath(source).catch(() => path.resolve(source))));
  if (protectedPaths.some((source) => contains(source, target) || contains(target, source))) throw new Error("目标与源或公开目录重叠");
  // No recursive creation and no overwrite. Existing folders and symlinks are refused atomically.
  await mkdir(target, { mode: 0o700 });
  return target;
}

async function entries(root: string): Promise<Entry[]> {
  const files: Entry[] = [];
  async function walk(relative: string) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (name === marker && !relative) continue;
      const item = relative ? relative + "/" + name : name;
      const file = path.join(root, item);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error("备份不接受符号链接或目录联接");
      if (stat.isDirectory()) { await walk(item); continue; }
      if (!stat.isFile()) throw new Error("备份不接受特殊文件");
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(file)) digest.update(chunk);
      files.push({ path: item, bytes: stat.size, sha256: digest.digest("hex") });
    }
  }
  await walk("");
  return files;
}

async function checkDatabase(db: string) {
  const version = (await readFile(path.join(db, "PG_VERSION"), "utf8")).trim();
  if (!/^\d{2}$/.test(version) || !(await lstat(path.join(db, "global/pg_control"))).isFile()) throw new Error("不是有效数据库目录");
}

async function copyTree(source: string, target: string) {
  // Validate every directory entry before copying, while the source is offline.
  await entries(source);
  await cp(source, target, { recursive: true, dereference: false, errorOnExist: true, force: false });
}

export async function backupLocalData(dbDir: string, assetRoot: string, destination: string) {
  const sourceDb = await directory(dbDir);
  await checkDatabase(sourceDb);
  const unlock = lockLocalDirectory(sourceDb);
  try {
    const assetPaths = await Promise.all(sections.slice(1).map(async (name) => {
      const root = path.resolve(assetRoot, name);
      try { return await directory(root); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
    }));
    const target = await freshPath(destination, [sourceDb, ...assetPaths.filter((x): x is string => !!x)]);
    await copyTree(sourceDb, path.join(target, "pgdata"));
    for (const [index, name] of sections.slice(1).entries()) {
      const source = assetPaths[index];
      if (source) await copyTree(source, path.join(target, name));
      else await mkdir(path.join(target, name), { mode: 0o700 });
    }
    await writeFile(path.join(target, marker), JSON.stringify({ version: 1, files: await entries(target) }), { flag: "wx", mode: 0o600 });
  } finally { unlock(); }
}

export async function restoreLocalData(bundleDir: string, destination: string, protectedPaths: string[] = []) {
  const bundle = await directory(bundleDir);
  const manifestPath = path.join(bundle, marker);
  if (!(await lstat(manifestPath)).isFile()) throw new Error("找不到备份清单");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const listing = await entries(bundle);
  if (manifest.version !== 1 || JSON.stringify(manifest.files) !== JSON.stringify(listing)) throw new Error("备份校验失败");
  if (JSON.stringify((await readdir(bundle)).sort()) !== JSON.stringify([...sections, marker].sort())) throw new Error("备份目录结构无效");
  await checkDatabase(path.join(bundle, "pgdata"));
  const target = await freshPath(destination, [bundle, ...protectedPaths.map((value) => path.resolve(value))]);
  for (const name of sections) await copyTree(await directory(path.join(bundle, name)), path.join(target, name));
  if (JSON.stringify(await entries(target)) !== JSON.stringify(listing)) throw new Error("恢复文件校验失败");
  await writeFile(path.join(target, ".buddy-restored"), "validated-restore-v1\n", { flag: "wx", mode: 0o600 });
}
