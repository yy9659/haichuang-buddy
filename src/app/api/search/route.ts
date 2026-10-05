import { normalizeSearchQuery, SEARCH_MAX_LENGTH } from "@/lib/dashboard-search";
import { getCurrentAuthUser } from "@/services/auth.service";
import { searchDashboard } from "@/services/search.service";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await getCurrentAuthUser();
    if (!user) return Response.json({ message: "登录已过期，请重新登录后搜索" }, { status: 401, headers });
    const raw = new URL(request.url).searchParams.get("q") ?? "";
    if (raw.length > 200 || normalizeSearchQuery(raw).length > SEARCH_MAX_LENGTH) {
      return Response.json({ message: `关键词最多 ${SEARCH_MAX_LENGTH} 个字` }, { status: 400, headers });
    }
    return Response.json(await searchDashboard(user.businessId, raw), { headers });
  } catch {
    return Response.json({ message: "暂时无法搜索，请稍后重试" }, { status: 503, headers });
  }
}
