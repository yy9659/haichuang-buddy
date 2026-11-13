import path from "node:path";
import { getServerEnv } from "@/lib/env";

export function assetDataDirectory() {
  const directory = path.resolve(/* turbopackIgnore: true */ process.cwd(), getServerEnv().ASSET_DATA_DIR ?? ".data");
  const relative = path.relative(path.resolve(process.cwd(), "public"), directory);
  if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep)) {
    throw new Error("ASSET_DATA_DIR 不能设置在公开静态资源目录内");
  }
  return directory;
}
