import "./lib/load-env";
import { userInfo } from "node:os";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { closeDb, ensureLocalDatabaseReady, resolveLocalDbDir } from "@/db";
import { getDataSource } from "@/lib/env";
import { isUuid } from "@/lib/id";
import { emailField } from "@/schemas/auth";
import { getRepositories } from "@/repositories";
import { administerAccount, invalidateRestoredCredentials, pruneSecurityRecords } from "@/repositories/db/security.repository";

async function main() {
  const [operation, rawEmail, id, confirmation, ...extra] = process.argv.slice(2);
  if (getDataSource() === "mock") throw new Error("requires persistent DB");
  if (operation === "invalidate-restored") {
    if (getDataSource() !== "local" || rawEmail !== "--confirm-isolated-restore" || id) throw new Error("invalid arguments");
    const db = await realpath(resolveLocalDbDir());
    if (path.basename(db) !== "pgdata" || await readFile(path.join(path.dirname(db), ".buddy-restored"), "utf8") !== "validated-restore-v1\n") {
      throw new Error("requires an isolated restored bundle");
    }
    await ensureLocalDatabaseReady();
    await invalidateRestoredCredentials();
    console.log("已撤销隔离恢复库中的历史会话、邀请和重设凭据。");
    return;
  }
  if (operation === "prune" && !rawEmail) {
    if (getDataSource() === "local") await ensureLocalDatabaseReady();
    await pruneSecurityRecords();
    console.log("已清理到期的安全记录。");
    return;
  }
  const email = emailField.parse(rawEmail);
  if (operation === "lookup" && !id) {
    if (getDataSource() === "local") await ensureLocalDatabaseReady();
    const user = await getRepositories().users.findByEmail(email);
    console.log(user ? `现有账号 ID：${user.id}，角色：${user.role}` : "没有找到该现有账号。");
    return;
  }
  if ((operation !== "grant" && operation !== "revoke" && operation !== "verify") || !id ||
      !isUuid(id) || confirmation !== "--confirm-existing-account" || extra.length) throw new Error("invalid command");
  if (getDataSource() === "local") await ensureLocalDatabaseReady();
  await administerAccount(id, email, operation, userInfo().username);
  console.log("操作已完成，记录已写入 security_role_audit。");
}

main().catch(() => {
  console.error("未完成。请检查部署库和迁移、账号 ID/邮箱、参数以及独占锁；不会输出凭据。");
  process.exitCode = 1;
}).finally(() => closeDb().catch(() => { process.exitCode = 1; }));
