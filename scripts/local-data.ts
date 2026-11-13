import "./lib/load-env";
import { resolve } from "node:path";
import { resolveLocalDbDir } from "@/db/local";
import { getDataSource } from "@/lib/env";
import { assetDataDirectory } from "@/storage/asset-directory";
import { backupLocalData, restoreLocalData } from "./lib/local-backup";

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "backup" && args.length === 2 && args[1] === "--offline" && getDataSource() === "local") {
    await backupLocalData(resolveLocalDbDir(), assetDataDirectory(), args[0]);
  } else if (mode === "restore" && args.length === 2) {
    await restoreLocalData(args[0], args[1], [resolveLocalDbDir(), resolve(assetDataDirectory(), "product-images"), resolve(assetDataDirectory(), "poster-backgrounds")]);
  } else throw new Error("invalid arguments");
  console.log("已完成。请在隔离配置下检查恢复目录，不要直接覆盖现有数据。");
}
main().catch(() => {
  console.error("操作未完成。请检查独占锁、源目录、目标是否全新和备份校验。部分输出可能保留，勿用作恢复源。");
  process.exitCode = 1;
});
