import { SectionCard } from "@/components/common/section-card";
import { AgentCard } from "@/components/dashboard/agent-card";
import { StaggerItem, StaggerList } from "@/components/motion/fade-in";
import type { AgentEmployee } from "@/types";
import { Bot } from "lucide-react";

/** AI 数字员工区（6 张卡片） */
export function AgentGrid({ agents }: { agents: AgentEmployee[] }) {
  return (
    <SectionCard
      title="AI 数字员工"
      description={`${agents.length} 位 AI 员工在线，按经营目标协同工作`}
      icon={<Bot className="size-4 text-primary" />}
      action={
        <span className="inline-flex items-center gap-1.5 rounded-md bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
          <span className="size-1.5 animate-pulse-soft rounded-full bg-success" />
          团队在线
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
