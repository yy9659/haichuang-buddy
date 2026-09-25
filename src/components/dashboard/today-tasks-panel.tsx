import { ListChecks } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { TodayTasks } from "@/components/dashboard/today-tasks";
import type { AgentTask } from "@/types";

/** 今日任务面板 */
export function TodayTasksPanel({ tasks }: { tasks: AgentTask[] }) {
  return (
    <SectionCard
      title="今日任务"
      icon={<ListChecks className="size-4 text-primary" />}
      moreHref="/dashboard"
    >
      <TodayTasks tasks={tasks} />
    </SectionCard>
  );
}
