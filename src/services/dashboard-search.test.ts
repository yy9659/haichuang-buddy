import { beforeEach, expect, it, vi } from "vitest";
import { getDashboardWorkflow } from "./dashboard";

const state = vi.hoisted(() => ({ user: { businessId: "own" } as { businessId: string } | null, find: vi.fn(), products: vi.fn() }));
vi.mock("./auth.service", () => ({ getCurrentAuthUser: async () => state.user }));
vi.mock("@/repositories", async importOriginal => ({ ...await importOriginal<typeof import("@/repositories")>(), getRepositories: () => ({ agentWorkflows: { findById: state.find }, products: { list: state.products } }) }));
beforeEach(() => { state.user = { businessId: "own" }; vi.resetAllMocks(); state.products.mockResolvedValue([]); });

it("历史任务不依赖最近列表窗口，能单独查看原记录", async () => {
  state.find.mockResolvedValue({ id: "old", businessId: "own", goal: "去年准备的海报", status: "completed", createdAt: "2025-01-01 10:00", completedAt: "2025-01-01 10:01", plan: null, summary: null, errorMessage: null });
  expect(await getDashboardWorkflow("old")).toMatchObject({ ok: true, data: { id: "old", goal: "去年准备的海报" } });
});
it("他人的任务、不存在的任务和未登录用户均不会读到详情", async () => {
  state.find.mockResolvedValue({ id: "other", businessId: "foreign" });
  expect(await getDashboardWorkflow("other")).toEqual({ ok: true, data: null }); expect(state.products).not.toHaveBeenCalled();
  state.find.mockResolvedValue(null); expect(await getDashboardWorkflow("deleted")).toEqual({ ok: true, data: null });
  state.user = null; vi.clearAllMocks(); expect(await getDashboardWorkflow("old")).toEqual({ ok: true, data: null }); expect(state.find).not.toHaveBeenCalled();
});
