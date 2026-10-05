import { Bot } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { AgentCard } from "@/components/dashboard/agent-card";
import { StaggerItem, StaggerList } from "@/components/motion/fade-in";
import type { DashboardAgentState } from "@/services/dashboard";

/**
 * AI 数字员工区（6 张卡片）。
 *
 * 顶部那颗「团队在线」的绿灯**已删除**：它原本是个纯装饰的动画点，
 * 与任何真实数据无关 —— 六个员工里有三个还没实现，却显示「团队在线」，
 * 这正是任务书第十九条禁止的假 Agent。
 * 现在换成一条**真实计数**：已接入几位、几位待接入。
 * 计数来自服务层的 `available` 标记，商家一眼就能知道哪些能力现在真的能用。
 */
export function AgentGrid({ agents }: { agents: DashboardAgentState[] }) {
  const availableCount = agents.filter((agent) => agent.available).length;
  const pendingCount = agents.length - availableCount;

  return (
    <SectionCard
      title="六个协同岗位"
      description={
        pendingCount > 0
          ? `${availableCount} 位已接入真实能力，${pendingCount} 位待接入`
          : `${availableCount} 个岗位已就绪`
      }
      icon={<Bot className="size-4 text-primary" />}
      action={
        <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {availableCount} / {agents.length} 已接入
        </span>
      }
      className="h-full"
    >
      <StaggerList className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {agents.map((agent) => (
          <StaggerItem key={agent.id} className="h-full">
            <AgentCard agent={agent} />
          </StaggerItem>
        ))}
      </StaggerList>
    </SectionCard>
  );
}
