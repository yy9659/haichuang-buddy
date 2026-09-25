import { Badge } from "@/components/ui/badge";
import { AGENT_STATUS_META } from "@/lib/status-meta";
import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/types";

interface AgentStatusBadgeProps {
  status: AgentStatus;
  /** 是否显示状态圆点 */
  withDot?: boolean;
  className?: string;
}

/** AI 员工 / 任务状态徽标 */
export function AgentStatusBadge({
  status,
  withDot = true,
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
      {meta.label}
    </Badge>
  );
}
