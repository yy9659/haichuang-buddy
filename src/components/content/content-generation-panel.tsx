import {
  CircleSlash,
  Loader2,
  Repeat2,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { ContentGeneratingHint } from "@/components/content/content-generation-hint";
import { EmptyState } from "@/components/common/empty-state";
import { SectionCard } from "@/components/common/section-card";
import { TagSection, TagSectionCard } from "@/components/common/tag-section";
import { Badge } from "@/components/ui/badge";
import { formatDurationMs, formatRelativeTime } from "@/lib/datetime";
import {
  AGENT_STATUS_META,
  CONTENT_FORMAT_LABEL,
  CONTENT_PLATFORM_LABEL,
} from "@/lib/status-meta";
import type { ContentView } from "@/services/content";

/** 模型通道状态（从槽位状态视图里取，避免为拿一个类型而 import 服务端模块） */
type ContentProviderStatus = NonNullable<
  ContentView["slotState"]
>["generation"]["provider"];

/** 模型通道提示：如实告知当前是 Mock 占位还是真实模型 */
function ContentProviderNotice({ provider }: { provider: ContentProviderStatus }) {
  if (!provider.usable) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2.5 text-[12px] leading-5 text-destructive"
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          内容生成服务暂时不可用：{provider.reason ?? "请稍后重试"}。
        </span>
      </div>
    );
  }

  if (provider.isMock) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/12 px-3 py-2.5 text-[12px] leading-5 text-warning">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          当前为演示模式，生成内容请确认后再发布。
        </span>
      </div>
    );
  }

  return null;
}

/** 生成中：展示 Agent 运行状态，并附带自动刷新提示 */
function GeneratingCard({ view }: { view: ContentView }) {
  const { slot } = view;
  const target = slot
    ? `${CONTENT_PLATFORM_LABEL[slot.platform]} · ${CONTENT_FORMAT_LABEL[slot.format]}`
    : "当前内容";

  return (
    <SectionCard
      title="内容生成中"
      description="内容运营 Agent 正在按平台调性撰写"
      action={<Badge variant="primary">生成中</Badge>}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Loader2 className="size-4 animate-spin text-primary" />
          正在撰写「{target}」…
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10" aria-label="内容正在生成，完成时间暂不确定">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-gradient-to-r from-blue-500 to-cyan-400" />
        </div>
        <ContentGeneratingHint />
      </div>
    </SectionCard>
  );
}

/** 生成记录：最近一次 Agent 任务的运行元数据 */
function GenerationRecordCard({ view }: { view: ContentView }) {
  const task = view.slotState?.generation.latestTask;
  if (!task) {
    return null;
  }

  const statusMeta = AGENT_STATUS_META[task.status];
  const target = task.platform
    ? `${CONTENT_PLATFORM_LABEL[task.platform]} · ${
        task.format ? CONTENT_FORMAT_LABEL[task.format] : "—"
      }`
    : "—";
  const rows = [
    { id: "platform", label: "平台 / 形态", value: target },
    { id: "duration", label: "耗时", value: formatDurationMs(task.durationMs) },
    { id: "created", label: "开始时间", value: task.createdAt || "—" },
    { id: "completed", label: "完成时间", value: task.completedAt ?? "—" },
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
            <dd className="text-[12px] leading-5 font-medium break-all">
              {row.value}
            </dd>
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

/**
 * 内容自带的合规 / 事实风险提示。
 *
 * 这些提示由 Agent 在生成后扫描写入内容记录（随内容留痕），
 * 因此**重新生成会覆盖**——旧内容的风险提示不会残留到新内容上。
 */
function ContentRiskNotesCard({ view }: { view: ContentView }) {
  const content = view.slotState?.content ?? null;
  const notes = (content?.riskNotes ?? []).filter(
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
        内容风险提示（{notes.length}）
      </span>
      <ul className="flex flex-col gap-1.5">
        {notes.map((note) => (
          <li key={note} className="text-[12px] leading-5 text-muted-foreground">
            · {note}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 内容生成面板：把「当前槽位的生成状态」翻译成界面。
 *
 * 分支顺序刻意这样排：
 *   1. 没有任何商品 → 提示先去添加商品（此时连槽位都不存在）
 *   2. 生成中       → 运行卡片（此时不渲染既有内容，避免用户以为新结论已经出来了）
 *   3. 已生成       → 生成记录 + 风险提示（内容本体由页面用内容资产视图渲染）
 *   4. 生成失败     → 失败卡片 + 重试
 *   5. 其余         → 尚未生成（empty）
 */
export function ContentGenerationPanel({ view }: { view: ContentView }) {
  const { slot, slotState, basis, sourceProducts } = view;
  const provider = slotState?.generation.provider ?? null;

  /**
   * 禁用原因按「先看通道、再看依据」的顺序给：
   * 通道不可用是环境问题（用户改不了业务数据就能解决），依据缺失是数据问题，
   * 一次只提示最靠前的那一个，避免按钮上挂三行字没人看完。
   */
  const disabledReason = (() => {
    if (provider && !provider.usable) {
      return provider.reason ?? "模型通道不可用";
    }
    if (sourceProducts.length === 0) {
      return "还没有商品可作为内容依据，请先添加商品";
    }
    if (basis && !basis.hasDna && !basis.hasBrandProfile) {
      return "请先分析这件商品，或建立品牌档案，再生成推广内容";
    }
    return undefined;
  })();

  // 1. 一件商品都没有：槽位不存在，任何生成都无从谈起
  if (!slot || !slotState) {
    return (
      <SectionCard
        title="内容资产状态"
        description="标题、正文与发布建议"
        icon={<Sparkles className="size-4 text-primary" />}
      >
        <EmptyState
          title="还没有任何商品"
          description="请先到商品中心添加商品并完善商品资料。"
          icon={<CircleSlash className="size-4" />}
        />
      </SectionCard>
    );
  }

  const status = slotState.generation.status;

  // 2. 生成中
  if (status === "generating") {
    return (
      <div className="flex flex-col gap-3">
        <ContentProviderNotice provider={slotState.generation.provider} />
        <GeneratingCard view={view} />
      </div>
    );
  }

  // 3. 已生成
  if (status === "completed") {
    const content = slotState.content;
    const grounded = basis !== null && (basis.hasDna || basis.hasBrandProfile);

    return (
      <div className="flex flex-col gap-3">
        <ContentProviderNotice provider={slotState.generation.provider} />

        {slotState.generation.lastRunFailed ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2.5 text-[12px] leading-5 text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              本次重新生成失败，该平台仍是<strong>上一次成功生成</strong>的版本
              {slotState.generation.latestTask?.errorMessage
                ? `：${slotState.generation.latestTask.errorMessage}`
                : ""}
            </span>
          </div>
        ) : null}

        {content ? (
          <SectionCard
            title="本次生成依据"
            description="根据系统中的商品资料与品牌档案生成；发布前请核对事实"
            icon={<Sparkles className="size-4 text-primary" />}
            action={
              <Badge variant={grounded ? "success" : "warning"}>
                {grounded ? "已读取资料" : "资料较少"}
              </Badge>
            }
          >
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                <span>
                  内容更新时间：{content.updatedAt ?? content.createdAt}
                  {content.updatedAt
                    ? `（${formatRelativeTime(content.updatedAt)}）`
                    : ""}
                </span>
                <span>
                  · 确认状态：
                  {content.status === "draft"
                    ? "草稿，待你核对"
                    : "已进入内容流程"}
                </span>
              </div>

              <TagSection
                title="已读取的材料"
                items={[
                  basis?.hasDna ? "商品理解" : "商品理解：未生成",
                  basis?.hasBrandProfile ? "品牌档案" : "品牌档案：未生成",
                  basis?.hasOwnerTwin ? "品牌语气" : "品牌语气：未设置",
                ]}
                showCount={false}
              />
            </div>
          </SectionCard>
        ) : null}

        <GenerationRecordCard view={view} />
        <ContentRiskNotesCard view={view} />
      </div>
    );
  }

  // 4. 生成失败
  if (status === "failed") {
    const task = slotState.generation.latestTask;
    return (
      <div className="flex flex-col gap-3">
        <ContentProviderNotice provider={slotState.generation.provider} />
        <SectionCard
          title="内容生成"
          description="内容运营 Agent 的结构化输出"
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
                {task?.errorMessage ? `：${task.errorMessage}` : "，未产出内容。"}
                {task?.durationMs !== null && task?.durationMs !== undefined
                  ? `（耗时 ${formatDurationMs(task.durationMs)}）`
                  : ""}
              </span>
            </div>
            <p className="flex items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
              <Repeat2 className="size-3" />
              可以直接重试；若连续失败，请检查模型配置，以及该商品是否已完成「AI 分析商品」。
            </p>
            <p className="text-xs text-muted-foreground">可在上方调整推广重点后重新生成。</p>
          </div>
        </SectionCard>
        <GenerationRecordCard view={view} />
      </div>
    );
  }

  // 5. empty —— 尚未生成
  return (
    <div className="flex flex-col gap-3">
      <ContentProviderNotice provider={slotState.generation.provider} />
      <SectionCard
        title="内容资产状态"
        description="该平台还没有内容"
        icon={<Sparkles className="size-4 text-primary" />}
      >
        <EmptyState
          title={`尚未生成「${CONTENT_PLATFORM_LABEL[slot.platform]} · ${CONTENT_FORMAT_LABEL[slot.format]}」的内容`}
          description="系统会结合商品资料和品牌表达，生成标题、正文、分镜与旁白。结果为草稿，请确认后发布。"
          icon={<Sparkles className="size-4" />}
          action={
            <p className="text-xs text-muted-foreground">
              {disabledReason ?? "在上方选择推广重点后生成草稿"}
            </p>
          }
        />
      </SectionCard>
    </div>
  );
}
