import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

/** The marker is shared by every Buddy process opening this PGlite directory. */
export function lockLocalDirectory(directory: string): () => void {
  const marker = fs.realpathSync(directory) + ".buddy.lock";
  const value = JSON.stringify({ pid: process.pid, host: os.hostname(), id: randomUUID() });
  let descriptor: number;

  try { descriptor = fs.openSync(marker, "wx", 0o600); }
  catch (cause) {
    if (!isFileExists(cause)) throw cause;
    descriptor = recoverStaleLockAndOpen(marker);
  }
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

function isFileExists(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === "EEXIST";
}

/** Signal 0 only checks existence; permission errors are treated as a live owner. */
function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return (cause as NodeJS.ErrnoException)?.code !== "ESRCH"; }
}

/**
 * A forced termination can skip the exit handler and leave the marker behind.
 * The recovery marker serializes competing starters before either moves a stale
 * lock. An active or unreadable owner's lock is never removed automatically.
 */
function recoverStaleLockAndOpen(marker: string): number {
  const recoveryMarker = marker + ".recovery";
  let recoveryDescriptor: number;
  try { recoveryDescriptor = fs.openSync(recoveryMarker, "wx", 0o600); }
  catch { throw new Error(`本地数据库锁正在被检查，或恢复锁仍存在：${recoveryMarker}`); }

  try {
    let raw: string;
    try { raw = fs.readFileSync(marker, "utf8"); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return fs.openSync(marker, "wx", 0o600);
      throw cause;
    }

    let owner: { pid: number; host?: string; id: string };
    try { owner = JSON.parse(raw) as { pid: number; host?: string; id: string }; }
    catch { throw new Error(`本地数据库锁内容无法识别，请人工检查：${marker}`); }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.id !== "string") {
      throw new Error(`本地数据库锁内容无法识别，请人工检查：${marker}`);
    }
    if (!owner.host || owner.host.toLowerCase() !== os.hostname().toLowerCase()) {
      throw new Error(`本地数据库锁来自未知或其他主机，不能自动恢复，请人工检查：${marker}`);
    }
    if (isProcessRunning(owner.pid)) {
      throw new Error(`本地数据库目录无法独占：正由进程 ${owner.pid} 使用，请先停止该进程。锁文件：${marker}`);
    }

    const archived = `${marker}.stale-${Date.now()}-${randomUUID()}`;
    let archivedLock = false;
    try { fs.renameSync(marker, archived); archivedLock = true; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
    }
    if (archivedLock) console.warn(`[haichuang] 已保留并移开失效的数据库锁：${archived}`);
    return fs.openSync(marker, "wx", 0o600);
  } finally {
    fs.closeSync(recoveryDescriptor);
    try { fs.unlinkSync(recoveryMarker); } catch { /* Preserve the original error. */ }
  }
}
