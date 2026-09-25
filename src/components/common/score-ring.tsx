import { cn } from "@/lib/utils";
import type { StatusTone } from "@/types";

const STROKE_COLOR: Record<StatusTone, string> = {
  neutral: "var(--muted-foreground)",
  primary: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--destructive)",
  info: "var(--info)",
};

interface ScoreRingProps {
  /** 0 ~ 100 */
  value: number;
  label?: string;
  caption?: string;
  tone?: StatusTone;
  size?: number;
  className?: string;
}

/** 环形评分（经营评分 / 目标进度），纯 SVG 实现 */
export function ScoreRing({
  value,
  label,
  caption,
  tone = "primary",
  size = 108,
  className,
}: ScoreRingProps) {
  const safeValue = Math.min(100, Math.max(0, value));
  const strokeWidth = 9;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (safeValue / 100) * circumference;

  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={STROKE_COLOR[tone]}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg leading-6 font-semibold tabular-nums">
          {label ?? safeValue}
        </span>
        {caption ? (
          <span className="text-[11px] leading-4 text-muted-foreground">
            {caption}
          </span>
        ) : null}
      </div>
    </div>
  );
}
