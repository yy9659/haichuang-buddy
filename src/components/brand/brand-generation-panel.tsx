import {
  Loader2,
  Repeat2,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { BrandGeneratingHint } from "@/components/brand/brand-generating-hint";
import { EmptyState } from "@/components/common/empty-state";
import { SectionCard } from "@/components/common/section-card";
import { TagSectionCard } from "@/components/common/tag-section";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { formatDurationMs } from "@/lib/datetime";
import { AGENT_STATUS_META } from "@/lib/status-meta";
import type { BrandView } from "@/services/brand";

/** 模型通道提示：如实告知当前是 Mock 占位还是真实模型 */
export function BrandProviderNotice({
  provider,
}: {
  provider: BrandView["generation"]["provider"];
}) {
  if (!provider.usable) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2.5 text-[12px] leading-5 text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          品牌生成服务暂时不可用：{provider.reason ?? "请稍后重试"}。
        </span>
      </div>
    );
  }

  if (provider.isMock) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/12 px-3 py-2.5 text-[12px] leading-5 text-warning">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          当前为演示模式，品牌结果仅用于展示操作流程。
        </span>
      </div>
    );
  }

  return null;
}

/** 生成中：展示 Agent 运行状态，并附带自动刷新提示 */
function GeneratingCard({ view }: { view: BrandView }) {
  const analyzed = view.generation.latestTask?.analyzedProductCount ?? 0;
  const source = view.generation.latestTask?.sourceProductCount ?? 0;

  return (
    <SectionCard
      title="品牌档案"
      description="品牌经理 Agent 正在推导"
      action={<Badge variant="primary">生成中</Badge>}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Loader2 className="size-4 animate-spin text-primary" />
          正在阅读 {source} 个商品的理解结论
          {analyzed > 0 ? `（其中 ${analyzed} 个已完成分析）` : ""}与商家表达偏好…
        </div>
        {/* 真实进度由 Agent 回传，本阶段为不确定进度，因此只做视觉表达 */}
        <Progress value={66} className="h-1.5" />
        <BrandGeneratingHint />
      </div>
    </SectionCard>
  );
}

/** 生成记录：最近一次 Agent 任务的运行元数据 */
function GenerationRecordCard({ view }: { view: BrandView }) {
  const task = view.generation.latestTask;
  if (!task) {
    return null;
  }

  const statusMeta = AGENT_STATUS_META[task.status];
  const rows = [
    { id: "duration", label: "耗时", value: formatDurationMs(task.durationMs) },
    { id: "created", label: "开始时间", value: task.createdAt || "—" },
    { id: "completed", label: "完成时间", value: task.completedAt ?? "—" },
    {
      id: "sources",
      label: "品牌依据",
      value: task.sourceProductCount
        ? `${task.sourceProductCount} 个商品（${task.analyzedProductCount} 个已完成分析）`
        : "—",
    },
    { id: "source", label: "主依据商品", value: task.sourceProductName ?? "—" },
  ];

  return (
    <TagSectionCard
      title="生成记录"
      description="最近一次生成状态"
      action={<Badge variant={statusMeta.tone}>{statusMeta.label}</Badge>}
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={row.id} className="flex flex-col gap-0.5">
            <dt className="text-[11px] text-muted-foreground">{row.label}</dt>
            <dd className="text-[12px] leading-5 font-medium break-all">{row.value}</dd>
          </div>
        ))}
      </dl>

      {task.errorMessage ? (
        <p className="mt-2 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2 text-[12px] leading-5 text-destructive">
          {task.errorMessage}
        </p>
      ) : null}

      {task.warnings.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {task.warnings.map((warning) => (
            <li
              key={warning}
              className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground"
            >
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}

    </TagSectionCard>
  );
}

/** 品牌档案自带的合规/事实风险提示（由 Agent 扫描写入档案，随档案留痕） */
function RiskNotesCard({ view }: { view: BrandView }) {
  const notes = (view.brand?.riskNotes ?? []).filter(
    (note) => !note.includes("【Mock】"),
  );
  if (notes.length === 0) {
    return null;
  }

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl border border-warning/25 bg-warning/12 px-4 py-3"
    >
      <span className="flex items-center gap-1.5 text-[12px] font-semibold text-warning">
        <ShieldAlert className="size-3.5" />
        品牌档案风险提示（{notes.length}）
      </span>
      <ul className="flex flex-col gap-1.5">
        {notes.map((note) => (
          <li
            key={note}
            className="text-[12px] leading-5 text-muted-foreground"
          >
            · {note}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 品牌生成面板：把「品牌档案状态」翻译成界面。
 *
 * 分支顺序刻意这样排：
 *   1. 生成中 → 运行卡片（此时不渲染既有档案，避免用户以为新结论已经出来了）
 *   2. 已生成 → 生成记录 + 风险提示（档案本体由页面用品牌卡片渲染）
 *   3. 生成失败且无档案 → 失败卡片 + 重试
 *   4. 其余 → 尚未生成（empty）
 */
export function BrandGenerationPanel({ view }: { view: BrandView }) {
  const { generation, sourceProduct } = view;
  const { status, latestTask } = generation;

  if (status === "generating") {
    return (
      <div className="flex flex-col gap-3">
        <BrandProviderNotice provider={generation.provider} />
        <GeneratingCard view={view} />
      </div>
    );
  }

  if (status === "completed") {
    if (view.brand?.aiVersion === "manual-v1") return null;
    return (
      <div className="flex flex-col gap-3">
        <BrandProviderNotice provider={generation.provider} />

        {generation.lastRunFailed ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2.5 text-[12px] leading-5 text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              本次重新生成失败，品牌档案仍是<strong>上一次成功生成</strong>的版本：
              {latestTask?.errorMessage ? ` ${latestTask.errorMessage}` : ""}
            </span>
          </div>
        ) : null}

        <GenerationRecordCard view={view} />
        <RiskNotesCard view={view} />
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="flex flex-col gap-3">
        <BrandProviderNotice provider={generation.provider} />
        <SectionCard
          title="品牌档案"
          description="品牌经理 Agent 的结构化输出"
          action={<Badge variant="danger">生成失败</Badge>}
        >
          <div className="flex flex-col gap-3">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-3 text-[12px] leading-5 text-destructive"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <strong>生成失败</strong>
                {latestTask?.errorMessage
                  ? `：${latestTask.errorMessage}`
                  : "，未生成品牌档案。"}
                {latestTask?.durationMs !== null && latestTask?.durationMs !== undefined
                  ? `（耗时 ${formatDurationMs(latestTask.durationMs)}）`
                  : ""}
              </span>
            </div>
            <p className="flex items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
              <Repeat2 className="size-3" />
              可用上方的 AI 生成按钮重试；若连续失败，请检查模型配置与商品资料。
            </p>
          </div>
        </SectionCard>
        <GenerationRecordCard view={view} />
      </div>
    );
  }

  // empty
  return (
    <div className="flex flex-col gap-3">
      <BrandProviderNotice provider={generation.provider} />
      <SectionCard title="品牌档案" description="定位、故事与表达方式">
        <EmptyState
          title="尚未生成品牌档案"
          description={
            sourceProduct
              ? `系统会读取商品资料与品牌语气，整理品牌定位、故事、目标客户和视觉方向。本次以「${sourceProduct.name}」为主要依据${
                  sourceProduct.hasDna ? "" : "（建议先完善该商品的分析结果）"
                }。`
              : "还没有可用商品。请先在商品中心添加商品，再回来生成品牌档案。"
          }
          icon={<Sparkles className="size-4" />}
        />
      </SectionCard>
    </div>
  );
}
