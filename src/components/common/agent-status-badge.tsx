import { Badge } from "@/components/ui/badge";
import { AGENT_STATUS_META } from "@/lib/status-meta";
import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/types";

interface AgentStatusBadgeProps {
  status: AgentStatus;
  /** 是否显示状态圆点 */
  withDot?: boolean;
  /**
   * 覆盖默认状态文案。
   *
   * 用于同一状态在不同员工身上有不同语义的场景：`completed` 对经营类员工
   * 是「已完成」，对客服这种**常驻服务型**员工要说「最近服务正常」——
   * 商家关心的不是那次任务，而是服务现在正不正常。
   */
  label?: string;
  className?: string;
}

/** AI 员工 / 任务状态徽标 */
export function AgentStatusBadge({
  status,
  withDot = true,
  label,
  className,
}: AgentStatusBadgeProps) {
  const meta = AGENT_STATUS_META[status];

  return (
    <Badge variant={meta.tone} className={cn("gap-1.5", className)}>
      {withDot ? (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status === "running"
              ? "animate-pulse-soft bg-current"
              : "bg-current opacity-70",
          )}
        />
      ) : null}
      {label ?? meta.label}
    </Badge>
  );
}
