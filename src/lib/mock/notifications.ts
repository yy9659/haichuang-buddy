import type { AgentNotification } from "@/types";

/**
 * AI 任务通知（顶部栏消息中心，Mock）
 *
 * S4-2：原本它与 `MOCK_WORKFLOW` / `MOCK_TODAY_TASKS` 一起放在 `lib/mock/workflow.ts`。
 * 后两者是驾驶舱的**演示工作流**，本轮已删除（驾驶舱改读真实的 `agent_workflows`）。
 * 通知属于消息中心，其真实数据源（`agent_tasks` 派生）尚未接入，
 * 因此在 db 模式下也由 `BusinessRepository.listNotifications` 明确抛 NOT_IMPLEMENTED ——
 * 这里保留演示数据，是为了让顶部栏在 mock 数据源下仍有内容，不是为了伪装工作流。
 */
export const MOCK_AGENT_NOTIFICATIONS: AgentNotification[] = [
  {
    id: "notif_001",
    title: "内容运营已完成 2 条家庭场景内容",
    description: "剩余 1 条预计 3 分钟内产出",
    timeText: "3 分钟前",
    read: false,
  },
  {
    id: "notif_002",
    title: "商品经理生成商品理解",
    description: "连江鲜活鲍鱼，置信度 92%",
    timeText: "1 小时前",
    read: false,
  },
  {
    id: "notif_003",
    title: "手工鱼丸内容生成失败",
    description: "建议重新执行该任务",
    timeText: "昨天 20:10",
    read: true,
  },
  {
    id: "notif_004",
    title: "智能客服发现 3 条知识缺口",
    description: "发票与运费相关问题需要补充资料",
    timeText: "昨天 18:32",
    read: true,
  },
];
