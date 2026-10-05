import { describe, expect, it } from "vitest";
import { buildPlatformTrend, isAdminEmail, publicKnowledgeSchema, redactTaskError } from "./admin";
import type { PlatformTask } from "@/types/admin";

const task = (changes: Partial<PlatformTask>): PlatformTask => ({ id: "test", title: "分析商品", agentType: "product_agent", status: "completed", businessName: "测试商户", createdAt: "2026-10-03T00:00:00+08:00", completedAt: "2026-10-03T00:00:10+08:00", durationMs: 10000, errorSummary: null, providerId: null, ...changes });
describe("管理员权限与公共资料校验", () => {
  it("只有明确列入白名单的完整邮箱通过，不接受相似后缀或空白名单", () => {
    expect(isAdminEmail("ADMIN@example.com", "admin@example.com; second@example.com")).toBe(true);
    expect(isAdminEmail("xadmin@example.com", "admin@example.com")).toBe(false);
    expect(isAdminEmail("admin@example.com.attacker.test", "admin@example.com")).toBe(false);
    expect(isAdminEmail("admin@example.com", "")).toBe(false);
  });
  it("发布须核验并记录来源；草稿可以留待核对；禁止脚本链接及多余字段", () => {
    const draft = { title: "测试冷链资料", category: "冷链与售后", content: "根据实际合同核对冷链运输与售后范围。", tags: [], sourceName: "", sourceUrl: "", status: "draft", verified: false };
    expect(publicKnowledgeSchema.safeParse(draft).success).toBe(true);
    expect(publicKnowledgeSchema.safeParse({ ...draft, status: "published" }).success).toBe(false);
    expect(publicKnowledgeSchema.safeParse({ ...draft, status: "published", verified: true, sourceName: "测试合同" }).success).toBe(true);
    expect(publicKnowledgeSchema.safeParse({ ...draft, sourceUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(publicKnowledgeSchema.safeParse({ ...draft, updatedBy: "伪造管理员" }).success).toBe(false);
  });
  it("错误摘要隐藏凭据、接口地址，限制输出长度", () => {
    const message = redactTaskError("Bearer secret-token api_key=private-key https://api.test/model?key=hidden sk-testsecret" + "x".repeat(300))!;
    expect(message).not.toContain("secret-token"); expect(message).not.toContain("private-key"); expect(message).not.toContain("https:"); expect(message).not.toContain("sk-test"); expect(message.length).toBeLessThanOrEqual(220);
    expect(redactTaskError('{"apiKey":"private-secret","token":"hidden-secret"}')).not.toContain("private-secret");
    expect(redactTaskError('{"apiKey":"private-secret","token":"hidden-secret"}')).not.toContain("hidden-secret");
  });
});
describe("平台趋势根据任务记录计算", () => {
  const now = new Date("2026-10-03T12:00:00+08:00");
  it("以北京时间划分 7 天，空数据不虚构平均耗时", () => {
    const points = buildPlatformTrend([], now);
    expect(points).toHaveLength(7); expect(points[0].date).toBe("2026-09-27"); expect(points[6]).toMatchObject({ date: "2026-10-03", peak: 0, responseSeconds: null });
  });
  it("同时执行计算并发；相邻任务不重叠；排队和跳过不计入执行", () => {
    const rows = [task({}), task({ id: "second", createdAt: "2026-10-03T00:00:10+08:00", completedAt: "2026-10-03T00:00:20+08:00" }), task({ id: "queued", status: "queued", completedAt: null, durationMs: null }), task({ id: "skipped", status: "skipped", completedAt: null, durationMs: null })];
    expect(buildPlatformTrend(rows, now)[6]).toMatchObject({ peak: 1, tasks: 4, responseSeconds: 10 });
    rows.push(task({ id: "overlap", completedAt: "2026-10-03T00:00:15+08:00" }));
    expect(buildPlatformTrend(rows, now)[6].peak).toBe(2);
  });
  it("跨零点任务计入两天并发，失败任务耗时也纳入统计", () => {
    const row = task({ status: "failed", createdAt: "2026-10-02T23:59:55+08:00", completedAt: "2026-10-03T00:00:05+08:00" });
    const points = buildPlatformTrend([row], now);
    expect(points[5]).toMatchObject({ peak: 1, responseSeconds: 10 }); expect(points[6]).toMatchObject({ peak: 1, responseSeconds: null });
  });
});
