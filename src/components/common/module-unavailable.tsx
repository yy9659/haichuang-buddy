import { PlugZap } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { SectionCard } from "@/components/common/section-card";

interface ModuleUnavailableProps {
  /** 卡片标题，与被替代的区块保持一致 */
  title: string;
  /** 不可用的原因（来自服务层 NOT_IMPLEMENTED 的 message） */
  reason: string;
  className?: string;
}

/**
 * 「这个模块在当前数据源下还没接上」的占位卡片。
 *
 * 与 `DataFallback`（「暂无数据」）刻意分开，因为两者对用户的含义完全不同：
 * - `DataFallback` → 功能是通的，只是还没有数据。用户知道「用起来就会有」；
 * - `ModuleUnavailable` → 功能还没接到这个数据源上。用户知道「怎么点都不会有」。
 *
 * 混用会让人对着一个永远出不来数据的按钮反复点 —— 那比直接说「没接」更糟。
 * 这也是任务书里「宁可报错，也不要让界面假装正常」的同一条原则：
 * 降级是允许的，**不告诉用户**才是不允许的。
 */
export function ModuleUnavailable({
  title,
  reason,
  className,
}: ModuleUnavailableProps) {
  return (
    <SectionCard title={title} className={className}>
      <EmptyState
        title="该模块在当前数据源下尚未启用"
        description={`${reason}。已落地的模块（商品 / 内容 / 客服 / 品牌 / 知识库 / 账号）不受影响。`}
        icon={<PlugZap className="size-4" />}
      />
    </SectionCard>
  );
}
