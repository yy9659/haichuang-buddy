import Link from "next/link";
import { ArrowRight, Clock, PlugZap } from "lucide-react";

import { AgentStatusBadge } from "@/components/common/agent-status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ACCENT_CLASSES } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { DashboardAgentState } from "@/services/dashboard";

/**
 * 单个 AI 员工卡片。
 *
 * S4-2 的关键改动：**未接入的员工绝不显示状态徽标**。
 *
 * 旧实现给所有员工都渲染 `AgentStatusBadge`，而状态来自一份演示常量 ——
 * 于是「智能客服」会顶着一个「已完成」的绿标，可它根本没有实现。
 * 那是这个项目最不能接受的失败模式：**看起来专业，其实是假的**。
 * 现在 `available=false` 的卡片只显示一个中性的「待接入」标签与一句说明，
 * 并且在服务层状态已被强制为 `idle`（能力不存在，就没有「在忙」这回事）。
 *
 * Task 81 起新增两块客服专属内容（其它员工不受影响）：
 * - 三格经营指标（今日已回答 / 待人工 / 知识缺口）—— 读取失败时
 *   显示「指标暂不可用」，绝不用 0 冒充；
 * - 整卡可点进 /customer-service 工作台。
 */
export function AgentCard({ agent }: { agent: DashboardAgentState }) {
  const accent = ACCENT_CLASSES[agent.accent];
  const Icon = agent.icon;
  const showMetrics =
    agent.id === "customer_service_agent" && agent.available === true;

  const content = (
    <Card
      className={cn(
        "group h-full transition-all",
        agent.available
          ? cn("hover:-translate-y-0.5 hover:shadow-float", accent.hoverBorder)
          : "border-dashed bg-muted/20",
        agent.href && "cursor-pointer",
      )}
    >
      <CardContent className="flex h-full flex-col gap-3 pt-4">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl shadow-sm",
              agent.available ? accent.avatar : "bg-muted text-muted-foreground",
            )}
          >
            <Icon className="size-5" strokeWidth={1.8} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "truncate text-[14px] leading-5 font-semibold",
                  !agent.available && "text-muted-foreground",
                )}
              >
                {agent.name}
              </span>
              {agent.supervisor ? (
                <span className="rounded-md bg-primary px-1.5 py-0.5 text-[10px] leading-4 font-medium text-primary-foreground">
                  调度中枢
                </span>
              ) : null}
            </div>
            <span className="truncate text-[12px] leading-4 text-muted-foreground">
              {agent.role}
            </span>
          </div>
          {agent.available ? (
            <AgentStatusBadge status={agent.status} label={agent.statusLabel} />
          ) : (
            <Badge variant="neutral" className="shrink-0 gap-1">
              <PlugZap className="size-3" />
              待接入
            </Badge>
          )}
        </div>

        {agent.available ? (
          <div className="rounded-lg bg-muted/60 px-3 py-2">
            <span className="text-[11px] leading-4 text-muted-foreground">
              最近任务
            </span>
            <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 font-medium">
              {agent.currentTask ?? "暂无任务，启动一次经营即可看到真实记录"}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border px-3 py-2">
            <p className="text-[11px] leading-4 text-muted-foreground">
              {agent.unavailableNote}
            </p>
          </div>
        )}

        {showMetrics ? (
          agent.customerServiceMetrics ? (
            <div className="grid grid-cols-3 gap-1.5">
              <div className="rounded-lg bg-muted/60 px-2 py-1.5 text-center">
                <p className="text-[15px] leading-5 font-semibold tabular-nums">
                  {agent.customerServiceMetrics.todayAnsweredCount}
                </p>
                <p className="mt-0.5 text-[10px] leading-3 text-muted-foreground">
                  今日已回答
                </p>
              </div>
              <div className="rounded-lg bg-muted/60 px-2 py-1.5 text-center">
                <p className="text-[15px] leading-5 font-semibold tabular-nums">
                  {agent.customerServiceMetrics.needsHumanConversationCount}
                </p>
                <p className="mt-0.5 text-[10px] leading-3 text-muted-foreground">
                  待人工
                </p>
              </div>
              <div className="rounded-lg bg-muted/60 px-2 py-1.5 text-center">
                <p className="text-[15px] leading-5 font-semibold tabular-nums">
                  {agent.customerServiceMetrics.openKnowledgeGapCount}
                </p>
                <p className="mt-0.5 text-[10px] leading-3 text-muted-foreground">
                  知识缺口
                </p>
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[11px] leading-4 text-muted-foreground">
              客服经营指标暂不可用，可稍后刷新重试。
            </p>
          )
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {agent.available ? (
            <>
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                {agent.lastRunAt ? `最近执行 ${agent.lastRunAt}` : "尚未执行过"}
              </span>
              {agent.lastRunSummary ? (
                <span className="truncate">{agent.lastRunSummary}</span>
              ) : null}
            </>
          ) : (
            <span className="truncate">
              能力标签：{agent.skills.join(" · ")}
            </span>
          )}
        </div>

        {agent.href ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary">
            查看客服工作台
            <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
          </span>
        ) : null}
      </CardContent>
    </Card>
  );

  /** 整卡可点进工作台（任务书第九 / 二十五节）；无入口的员工保持纯展示 */
  if (agent.href) {
    return (
      <Link href={agent.href} className="block h-full focus-visible:outline-none">
        {content}
      </Link>
    );
  }
  return content;
}
