import { Activity, CircleAlert, Gauge, Timer } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { StatCard } from "@/components/common/stat-card";
import { AGENT_NAME_LABEL } from "@/lib/status-meta";
import { formatDurationMs } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import type { AgentMetrics } from "@/types";

/**
 * 区块 E：Agent 运行概览（**全部来自 `agent_tasks` 的程序统计**）
 *
 * 失败率与平均耗时都由 `computeAgentMetrics()` 算好，这一层只负责摆放。
 *
 * 一个刻意的口径写在界面上：分母只算**走到终态**的任务。
 * 把还在跑的算进分母，失败率会随「此刻有没有任务在飞」上下跳 ——
 * 那不是经营信号，是采样噪声。
 */
function agentLabel(agentType: string): string {
  return AGENT_NAME_LABEL[agentType as keyof typeof AGENT_NAME_LABEL] ?? agentType;
}

export function AgentEfficiencyPanel({ agents }: { agents: AgentMetrics }) {
  const terminalTasks = agents.completedTasks + agents.failedTasks;
  const failureRate =
    terminalTasks > 0 ? agents.failedTasks / terminalTasks : null;

  return (
    <SectionCard
      title="AI 帮忙完成了多少工作"
      description="这里记录 AI 员工是否顺利完成工作；统计只包含已经结束的任务。"
      icon={<Activity className="size-4 text-primary" />}
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="顺利完成"
            value={`${agents.completedTasks}`}
            tone="success"
            icon={<Activity />}
          />
          <StatCard
            label="没能完成"
            value={`${agents.failedTasks}`}
            tone={agents.failedTasks > 0 ? "warning" : "neutral"}
            icon={<CircleAlert />}
          />
          <StatCard
            label="未完成比例"
            value={failureRate === null ? "暂无数据" : `${Math.round(failureRate * 100)}%`}
            tone={
              failureRate === null
                ? "neutral"
                : failureRate >= 0.3
                  ? "danger"
                  : failureRate >= 0.1
                    ? "warning"
                    : "success"
            }
            icon={<Gauge />}
            footer={
              <span className="text-[11px] text-muted-foreground">
                在 {terminalTasks} 次已结束的工作中计算
              </span>
            }
          />
          <StatCard
            label="平均用时"
            value={formatDurationMs(agents.avgDurationMs)}
            tone="neutral"
            icon={<Timer />}
          />
        </div>

        {agents.byAgent.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">AI 员工</th>
                  <th className="px-3 py-2 text-right font-medium">完成</th>
                  <th className="px-3 py-2 text-right font-medium">未完成</th>
                  <th className="px-3 py-2 text-right font-medium">未完成比例</th>
                  <th className="px-3 py-2 text-right font-medium">平均用时</th>
                </tr>
              </thead>
              <tbody>
                {agents.byAgent.map((stat) => (
                  <tr
                    key={stat.agentType}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-3 py-2">{agentLabel(stat.agentType)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {stat.completed}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right tabular-nums",
                        stat.failed > 0 && "font-medium text-warning",
                      )}
                    >
                      {stat.failed}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {stat.failureRate === null
                        ? "—"
                        : `${Math.round(stat.failureRate * 100)}%`}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatDurationMs(stat.avgDurationMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-4 text-center text-[12px] text-muted-foreground">
            还没有已结束的 AI 工作。完成一次经营计划后，这里会显示记录。
          </p>
        )}
      </div>
    </SectionCard>
  );
}
