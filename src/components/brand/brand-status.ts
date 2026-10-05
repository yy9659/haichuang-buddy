import type { BrandGenerationStatus } from "@/services/brand-agent.service";
import type { StatusTone } from "@/types";

interface BrandStatusMeta {
  label: string;
  tone: StatusTone;
}

/**
 * 品牌档案状态 → 界面文案。
 *
 * 刻意不复用 `AGENT_STATUS_META`：那是**任务**状态的词表（running / completed…），
 * 而这里要表达的是**品牌档案**的状态（还没生成 / 生成中 / 已生成 / 生成失败），
 * 两者语义不同 —— 例如 `completed` 在档案上应显示「已生成」，而不是「已完成」，
 * 因为档案的生成过程结束了，但商家还没有确认（approved 仍为 false）。
 */
export const BRAND_STATUS_META: Readonly<
  Record<BrandGenerationStatus, BrandStatusMeta>
> = {
  empty: { label: "尚未生成", tone: "neutral" },
  generating: { label: "生成中", tone: "primary" },
  completed: { label: "已生成", tone: "success" },
  failed: { label: "生成失败", tone: "danger" },
};
