import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "./route";

const state = vi.hoisted(() => ({ user: { businessId: "session-business" } as { businessId: string } | null, search: vi.fn() }));
vi.mock("@/services/auth.service", () => ({ getCurrentAuthUser: async () => state.user }));
vi.mock("@/services/search.service", () => ({ searchDashboard: state.search }));
beforeEach(() => { state.user = { businessId: "session-business" }; vi.resetAllMocks(); state.search.mockResolvedValue({ query: "鱼丸", groups: [] }); });

it("未登录返回 JSON 401，不查询商户数据", async () => {
  state.user = null;
  const response = await GET(new Request("http://localhost/api/search?q=鱼丸"));
  expect(response.status).toBe(401); expect(await response.json()).toHaveProperty("message"); expect(state.search).not.toHaveBeenCalled();
});
it("忽略伪造商户编号，使用会话归属，结果不可缓存", async () => {
  const response = await GET(new Request("http://localhost/api/search?q=鱼丸&businessId=foreign"));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store"); expect(state.search).toHaveBeenCalledWith("session-business", "鱼丸");
});
it("超长输入在查询之前拒绝，数据库故障不暴露内部信息", async () => {
  expect((await GET(new Request(`http://localhost/api/search?q=${"鱼".repeat(81)}`))).status).toBe(400); expect(state.search).not.toHaveBeenCalled();
  state.search.mockRejectedValue(new Error("database credentials must stay private"));
  const response = await GET(new Request("http://localhost/api/search?q=鱼丸"));
  expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("credentials");
});
