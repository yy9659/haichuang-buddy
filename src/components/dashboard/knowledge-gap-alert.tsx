import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, MessageCircleQuestion } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DashboardCustomerServiceState } from "@/services/dashboard";

/**
 * 知识缺口提醒卡（任务书第十节）。
 *
 * 与客服 Agent 卡片是**两个独立维度**：那张卡说「AI 是否在正常工作」，
 * 这张卡说「有没有客户问题 AI 答不上来」。缺口 > 0 **不**意味着 Agent 失败
 * （Agent 正确识别了不足），所以这里用 warning 而不是 destructive；缺口为 0
 * 时也不显示「全部解决」的庆祝 —— 商家打开驾驶舱是为了看「要做什么」，
 * 不是为了被表扬。
 */
export function KnowledgeGapAlert({ state }: { state: DashboardCustomerServiceState | null }) {
  if (!state) {
    /* 客服区块在当前数据源不可用；驾驶舱其它位置已统一说明，这里不重复 */
    return null;
  }

  if (state.openKnowledgeGapCount === 0) {
    return (
      <Card className="border-success/30 bg-success/8">
        <CardContent className="flex items-center gap-3 py-3">
          <CheckCircle2 className="size-5 shrink-0 text-success" />
          <p className="text-[12px] leading-5 font-medium">
            当前没有待补充知识，AI 客服已能回答全部由近场提问检索到的问题。
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-warning/40 bg-warning/8">
      <CardContent className="flex flex-col gap-2.5 py-3">
        <div className="flex items-center gap-3">
          <AlertTriangle className="size-5 shrink-0 text-warning" />
          <p className="text-[13px] leading-5 font-medium">
            有 {state.openKnowledgeGapCount} 个客户问题需要补充知识
          </p>
          <Link
            href="/customer-service?panel=gaps"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-warning/15 px-2.5 py-1 text-[12px] font-medium text-warning transition-colors hover:bg-warning/25"
          >
            去处理
            <ArrowRight className="size-3" />
          </Link>
        </div>

        {state.topGaps.length > 0 ? (
          <ul className="flex flex-col gap-1.5 pl-1">
            {state.topGaps.map((gap) => (
              <li
                key={gap.id}
                className={cn(
                  "flex items-center gap-2 rounded-md bg-background/60 px-2 py-1",
                )}
              >
                <MessageCircleQuestion className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[12px] leading-4">
                  {gap.question}
                </span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                  {gap.occurrenceCount} 次
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}