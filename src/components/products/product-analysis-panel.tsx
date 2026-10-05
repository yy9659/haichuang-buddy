import {
  CircleCheck,
  ImageOff,
  Loader2,
  Repeat2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { SectionCard } from "@/components/common/section-card";
import { TagSectionCard } from "@/components/common/tag-section";
import { ProductAnalysisButton } from "@/components/products/product-analysis-button";
import { ProductAnalysisRunningHint } from "@/components/products/product-analysis-running-hint";
import { ProductDnaPanel } from "@/components/products/product-dna-panel";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { formatDurationMs } from "@/lib/datetime";
import { AGENT_STATUS_META, PRODUCT_ANALYSIS_META } from "@/lib/status-meta";
import type { ProductAnalysisState } from "@/services/product-agent.service";
import type { Product, ProductDNA } from "@/types";

interface ProductAnalysisPanelProps {
  product: Product;
  dna: ProductDNA | null;
  analysis: ProductAnalysisState;
}

function analysisErrorForMerchant(message: string): string {
  // 兼容旧任务记录里保存的底层 fetch 错误，避免把技术细节直接展示给商户。
  if (/fetch failed|ECONNRESET|ENETUNREACH|ETIMEDOUT|UND_ERR_/i.test(message)) {
    return "连接分析服务时中断了，请点击“重新分析”再试。";
  }
  return message;
}

/** 分析中：展示 Agent 运行状态，并附带自动刷新提示 */
function AnalysisRunningCard({ product }: { product: Product }) {
  return (
    <SectionCard
      title="商品理解"
      description="正在分析商品资料"
      action={<Badge variant="primary">分析中</Badge>}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Loader2 className="size-4 animate-spin text-primary" />
          正在阅读商品资料{product.imageUrl ? "与商品图片" : ""}…
        </div>
        {/* 真实进度由 Agent 回传，本阶段为不确定进度，因此只做视觉表达 */}
        <Progress value={66} className="h-1.5" />
        <ProductAnalysisRunningHint />
      </div>
    </SectionCard>
  );
}

/** 模型通道提示：如实告知当前是 Mock 占位还是真实模型 */
function ProviderNotice({ provider }: { provider: ProductAnalysisState["provider"] }) {
  if (!provider.usable) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2.5 text-[12px] leading-5 text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          分析服务暂时不可用：{provider.reason ?? "请稍后重试"}。
        </span>
      </div>
    );
  }

  if (provider.isMock) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/12 px-3 py-2.5 text-[12px] leading-5 text-warning">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          当前为演示模式，分析结果仅用于展示操作流程。
        </span>
      </div>
    );
  }

  return null;
}

/** 分析记录：最近一次 Agent 任务的运行元数据（Task 5 / Task 6） */
function AnalysisRecordCard({
  analysis,
}: {
  analysis: ProductAnalysisState;
}) {
  const task = analysis.latestTask;
  if (!task) {
    return null;
  }

  const statusMeta = AGENT_STATUS_META[task.status];
  const rows = [
    { id: "duration", label: "耗时", value: formatDurationMs(task.durationMs) },
    { id: "created", label: "开始时间", value: task.createdAt || "—" },
    { id: "completed", label: "完成时间", value: task.completedAt ?? "—" },
    { id: "vision", label: "图像理解", value: task.visionUsed ? "已使用" : "未使用（无图片或跳过）" },
  ];

  return (
    <TagSectionCard
      title="分析记录"
      description="最近一次分析状态"
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
          {analysisErrorForMerchant(task.errorMessage)}
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

/**
 * 商品分析面板：把「商品分析状态」翻译成界面。
 *
 * 分支顺序刻意这样排：
 *   1. 运行中 → 运行卡片（此时不展示旧 DNA，避免用户以为新结论已经出来了）
 *   2. 已有 DNA → 展示 DNA（若本次失败，额外提示「下面是上次成功的结果」）
 *   3. 失败且无 DNA → 失败卡片 + 重试
 *   4. 其余 → 等待分析
 */
export function ProductAnalysisPanel({
  product,
  dna,
  analysis,
}: ProductAnalysisPanelProps) {
  const task = analysis.latestTask;
  const running = product.analysisStatus === "analyzing" || task?.status === "running";

  if (running) {
    return (
      <div className="flex flex-col gap-3">
        <ProviderNotice provider={analysis.provider} />
        <AnalysisRunningCard product={product} />
      </div>
    );
  }

  if (dna) {
    const lastRunFailed =
      product.analysisStatus === "failed" || task?.status === "failed";

    return (
      <div className="flex flex-col gap-3">
        <ProviderNotice provider={analysis.provider} />

        {lastRunFailed ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2.5 text-[12px] leading-5 text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              本次重新分析失败，以下仍是<strong>上一次成功生成</strong>的结论：
              {task?.errorMessage ? ` ${analysisErrorForMerchant(task.errorMessage)}` : ""}
            </span>
          </div>
        ) : null}

        <ProductDnaPanel dna={dna} />
        <AnalysisRecordCard analysis={analysis} />
      </div>
    );
  }

  if (product.analysisStatus === "failed") {
    const statusMeta = PRODUCT_ANALYSIS_META.failed;
    return (
      <div className="flex flex-col gap-3">
        <ProviderNotice provider={analysis.provider} />
        <SectionCard
          title="商品理解"
          description="商品卖点、用户与使用场景"
          action={<Badge variant={statusMeta.tone}>{statusMeta.label}</Badge>}
        >
          <div className="flex flex-col gap-3">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-3 text-[12px] leading-5 text-destructive"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <strong>分析失败</strong>
                {task?.errorMessage ? `：${analysisErrorForMerchant(task.errorMessage)}` : "，未生成商品理解。"}
                {task?.durationMs !== null && task?.durationMs !== undefined
                  ? `（耗时 ${formatDurationMs(task.durationMs)}）`
                  : ""}
              </span>
            </div>
            <p className="flex items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
              <Repeat2 className="size-3" />
              可以直接重试；若连续失败，请检查模型配置与商品图片是否可访问。
            </p>
            <ProductAnalysisButton
              productId={product.id}
              analysisStatus="failed"
              hasDna={false}
              size="sm"
              variant="outline"
              className="self-start"
              errorDisplay="inline"
              {...(analysis.provider.usable
                ? {}
                : { disabledReason: analysis.provider.reason ?? "模型通道不可用" })}
            />
          </div>
        </SectionCard>
      </div>
    );
  }

  const noImage = !product.imageUrl;

  return (
    <div className="flex flex-col gap-3">
      <ProviderNotice provider={analysis.provider} />
      <SectionCard title="商品理解" description="商品卖点、用户与使用场景">
        <EmptyState
          title="等待商品分析"
          description={
            noImage
              ? "尚未上传商品图片。仍可分析文字资料，但补充图片后结果会更完整。"
              : "分析商品图片与资料，整理卖点、目标用户、消费场景和营销角度。"
          }
          icon={<Sparkles className="size-4" />}
          action={
            <div className="mt-1 flex flex-col items-center gap-2">
              <ProductAnalysisButton
                productId={product.id}
                analysisStatus={product.analysisStatus}
                hasDna={false}
                size="sm"
                errorDisplay="inline"
                {...(analysis.provider.usable
                  ? {}
                  : { disabledReason: analysis.provider.reason ?? "模型通道不可用" })}
              />
              {noImage ? (
                <p className="flex items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
                  <ImageOff className="size-3" />
                  未上传图片
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
                  <CircleCheck className="size-3" />
                  已就绪，预计数秒内完成
                </p>
              )}
            </div>
          }
        />
      </SectionCard>
    </div>
  );
}
