import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { lockLocalDirectory } from "@/db/local-lock";

const testDirectories: string[] = [];

function createDirectory(): { parent: string; database: string; marker: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-local-lock-"));
  testDirectories.push(parent);
  const database = path.join(parent, "pgdata");
  fs.mkdirSync(database);
  return { parent, database, marker: fs.realpathSync(database) + ".buddy.lock" };
}

afterEach(() => {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  for (const directory of testDirectories.splice(0)) {
    const target = path.resolve(directory);
    if (!target.startsWith(tempRoot) || !path.basename(target).startsWith("buddy-local-lock-")) {
      throw new Error(`Refusing to remove unexpected test directory: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

it("keeps an active owner's lock intact", () => {
  const { database, marker } = createDirectory();
  const unlock = lockLocalDirectory(database);
  try {
    const first = fs.readFileSync(marker, "utf8");
    expect(() => lockLocalDirectory(database)).toThrow(`进程 ${process.pid} 使用`);
    expect(fs.readFileSync(marker, "utf8")).toBe(first);
  } finally { unlock(); }
  expect(fs.existsSync(marker)).toBe(false);
});

it("archives a stale lock and starts with a new marker", () => {
  const { parent, database, marker } = createDirectory();
  const stale = JSON.stringify({ pid: 2147483647, host: os.hostname(), id: "old-process" });
  fs.writeFileSync(marker, stale);
  const unlock = lockLocalDirectory(database);
  try {
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).pid).toBe(process.pid);
    const archive = fs.readdirSync(parent).find((name) => name.startsWith("pgdata.buddy.lock.stale-"));
    expect(archive).toBeDefined();
    expect(fs.readFileSync(path.join(parent, archive!), "utf8")).toBe(stale);
    expect(fs.existsSync(marker + ".recovery")).toBe(false);
  } finally { unlock(); }
});

it("does not replace an unrecognizable lock", () => {
  const { database, marker } = createDirectory();
  fs.writeFileSync(marker, "not a Buddy lock");
  expect(() => lockLocalDirectory(database)).toThrow("锁内容无法识别");
  expect(fs.readFileSync(marker, "utf8")).toBe("not a Buddy lock");
  expect(fs.existsSync(marker + ".recovery")).toBe(false);
});

it("does not reclaim a lock from an unknown host", () => {
  const { database, marker } = createDirectory();
  const legacy = JSON.stringify({ pid: 2147483647, id: "legacy-lock" });
  fs.writeFileSync(marker, legacy);
  expect(() => lockLocalDirectory(database)).toThrow("未知或其他主机");
  expect(fs.readFileSync(marker, "utf8")).toBe(legacy);
});
