import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerEnvCache } from "@/lib/env";
import { deletePublicKnowledge, getAdminOverview, listPublicKnowledgeForAdmin, listPublishedPublicKnowledge, savePublicKnowledge } from "./admin.service";

const state = vi.hoisted(() => ({ email: "admin@example.test" as string | null, repo: { snapshot: vi.fn(), listKnowledge: vi.fn(), saveKnowledge: vi.fn(), deleteKnowledge: vi.fn() } }));
vi.mock("./auth.service", () => ({ getCurrentAuthUser: async () => state.email ? { id: "current-admin", email: state.email } : null }));
vi.mock("@/repositories/platform", () => ({ getPlatformRepository: () => state.repo }));
const input = { title: "测试品质规范", category: "品质规范" as const, content: "由商户核对检测资料及适用的品质规范。", sourceName: "测试来源", sourceUrl: "", tags: ["测试"], verified: true, status: "published" as const };
const id = "81111111-1111-4111-8111-111111111111";
beforeEach(() => { process.env.ADMIN_EMAILS = "admin@example.test"; process.env.DATA_SOURCE = "mock"; resetServerEnvCache(); state.email = "admin@example.test"; vi.clearAllMocks(); });
describe("管理端服务必须在服务端校验身份", () => {
  it.each([null, "merchant@example.test"])("身份 %s 无法跨商户读取或改写", async email => {
    state.email = email;
    await expect(getAdminOverview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(listPublicKnowledgeForAdmin()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await savePublicKnowledge(null, input)).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(await deletePublicKnowledge(id)).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    for (const operation of Object.values(state.repo)) expect(operation).not.toHaveBeenCalled();
  });
  it("管理员可保存，更新人取自当前会话而非客户端输入", async () => {
    state.repo.saveKnowledge.mockResolvedValue({ ...input, id });
    expect(await savePublicKnowledge(null, input)).toMatchObject({ ok: true });
    expect(state.repo.saveKnowledge).toHaveBeenCalledWith(null, input, "current-admin");
  });
  it("未核验发布、非法编号与伪造字段不触发仓储写入", async () => {
    expect(await savePublicKnowledge(null, { ...input, verified: false })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await savePublicKnowledge("bad-id", input)).toMatchObject({ ok: false });
    expect(await savePublicKnowledge(null, { ...input, updatedBy: "forged" } as typeof input)).toMatchObject({ ok: false });
    expect(state.repo.saveKnowledge).not.toHaveBeenCalled();
    expect(await deletePublicKnowledge("bad-id")).toMatchObject({ ok: false }); expect(state.repo.deleteKnowledge).not.toHaveBeenCalled();
  });
  it("普通商户仅能通过公开读取入口访问已发布资料，未登录拒绝读取", async () => {
    state.email = "merchant@example.test"; state.repo.listKnowledge.mockResolvedValue([]);
    await expect(listPublishedPublicKnowledge()).resolves.toEqual([]); expect(state.repo.listKnowledge).toHaveBeenCalledWith(true);
    vi.clearAllMocks(); state.email = null;
    await expect(listPublishedPublicKnowledge()).rejects.toMatchObject({ code: "UNAUTHORIZED" }); expect(state.repo.listKnowledge).not.toHaveBeenCalled();
  });
});
