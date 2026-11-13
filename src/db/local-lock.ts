import fs from "node:fs";
import { randomUUID } from "node:crypto";

/** The marker is shared by every Buddy process opening this PGlite directory. */
export function lockLocalDirectory(directory: string): () => void {
  const marker = fs.realpathSync(directory) + ".buddy.lock";
  const value = JSON.stringify({ pid: process.pid, id: randomUUID() });
  let descriptor: number;
  try { descriptor = fs.openSync(marker, "wx", 0o600); }
  catch { throw new Error("本地数据库目录无法独占：请确认其他进程已停止，并检查 .buddy.lock。"); }
  try { fs.writeFileSync(descriptor, value); }
  finally { fs.closeSync(descriptor); }

  const unlock = () => {
    process.removeListener("exit", unlock);
    try { if (fs.readFileSync(marker, "utf8") === value) fs.unlinkSync(marker); }
    catch { /* A crash may leave a marker; never remove another process's lock. */ }
  };
  process.once("exit", unlock);
  return unlock;
}
