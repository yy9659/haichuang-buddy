import { Inbox } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { SectionCard } from "@/components/common/section-card";

interface DataFallbackProps {
  /** 卡片标题，与被替代的区块保持一致 */
  title: string;
  description?: string;
  className?: string;
}

/**
 * 数据缺失时的统一占位卡片。
 * 对应技术文档第 21 章「错误与降级策略」：单个区块数据缺失不应让整页崩溃。
 */
export function DataFallback({
  title,
  description,
  className,
}: DataFallbackProps) {
  return (
    <SectionCard title={title} className={className}>
      <EmptyState
        title="暂无数据"
        description={description ?? "该数据尚未生成或当前不可用。"}
        icon={<Inbox className="size-4" />}
      />
    </SectionCard>
  );
}
