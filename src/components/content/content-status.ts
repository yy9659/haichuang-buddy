import type { ContentGenerationStatus } from "@/services/content-agent.service";
import type { StatusTone } from "@/types";

interface ContentGenerationStatusMeta {
  label: string;
  tone: StatusTone;
}

/**
 * 内容生成状态 → 界面文案。
 *
 * 刻意**不复用** `CONTENT_STATUS_META`（draft / reviewing / approved / published / failed）：
 * 那套词表描述的是**内容条目自身**的生命周期（商家确认到哪一步了），
 * 而这里要表达的是**生成动作**的状态（这个槽位有没有内容、正在不在生成）。
 * 两者语义不同 ——
 * - `failed` 在条目上应显示「生成失败」（说明这条内容有问题），
 *   在生成状态上也是「生成失败」，但含义是「这次生成没成，槽位里可能还是旧内容」；
 * - `completed` 在条目上要落到 draft / approved 之一，而生成状态只说明「内容已经产出了」，
 *   商家还没有确认（`status` 仍是 draft）。
 * 混用会让界面出现「已完成」这种看不出到底完成了什么的词。
 */
export const CONTENT_GENERATION_STATUS_META: Readonly<
  Record<ContentGenerationStatus, ContentGenerationStatusMeta>
> = {
  empty: { label: "尚未生成", tone: "neutral" },
  generating: { label: "生成中", tone: "primary" },
  completed: { label: "已生成", tone: "success" },
  failed: { label: "生成失败", tone: "danger" },
};
