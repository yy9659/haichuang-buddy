/**
 * Agent 结构化输出的**字段级共用规则**（S3-2 抽出）
 *
 * 为什么要有这个模块：
 * Product DNA（S2-1）、Brand Profile（S3-1）、Content Asset（S3-2）三份 Schema 都要处理
 * 同一批「模型的坏习惯」——把数组写成 `"A、B；C"` 这种分隔符字符串、把 confidence 写成
 * `"85%"` 或 `85`、给列表塞空字符串或非字符串项。
 * 这些**规则本身完全一样**，差别只在限制值（条数上限、单条字数）与字段标签，
 * 因此把函数抽到这里共用，各 Schema 只保留自己的常量。
 *
 * 说明：S3-1 时曾刻意重复实现（当时只有两处，且判断「两处都可能各自演进」）。
 * 到 S3-2 出现第三处时这个判断不再成立 —— 三份副本意味着修一次 bug 要改三个地方，
 * 所以在此收敛。各 Schema 的**对外契约与行为保持不变**，仅去掉了重复代码。
 *
 * 不放进 `agent-output.ts`：那个模块负责「整份输出的提取 / 校验 / 纠错通道」，是流程级的；
 * 这里是单字段级的，职责不同。
 */

import { z } from "zod";

/** 小于该值的「大于 1」数值更像误写的小数（如 1.8），按越界夹取处理而非当成百分数 */
const PERCENT_DETECTION_THRESHOLD = 5;

/** 把数值夹取到 0 ~ 1 */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 把模型可能给出的各种 confidence 写法归一为 0~1：
 * - `0.85` → 0.85；`85` / `"85"` / `"85%"` → 0.85（百分制）
 * - `1.8` / `-0.5` 这类越界小数 → 夹取到 1 / 0
 *   （**不能**按百分制除以 100，否则 1.8 会变成 0.018 这种荒谬值）
 * - 非数值 → 返回原值，由 `.catch(0.5)` 兜底
 */
export function normalizeConfidenceValue(value: unknown): unknown {
  const isPercentString = typeof value === "string" && value.includes("%");
  const numeric =
    typeof value === "string" ? Number(value.replace("%", "").trim()) : value;

  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    return numeric;
  }
  if (isPercentString) {
    return clamp01(numeric / 100);
  }
  if (numeric >= 0 && numeric <= 1) {
    return numeric;
  }
  if (numeric > 1 && numeric >= PERCENT_DETECTION_THRESHOLD) {
    return clamp01(numeric / 100);
  }
  return clamp01(numeric);
}

/**
 * 置信度字段：归一化到 0 ~ 1，非数值兜底 0.5。
 * 刻意用 `.catch()` 而不是让校验失败 —— 单个置信度写错不该拖垮整份产出，
 * 其它关键字段（定位 / 正文…）仍会严格失败以触发纠错。
 */
export const confidenceSchema = z
  .preprocess(normalizeConfidenceValue, z.number().min(0).max(1))
  .catch(0.5);

/**
 * 把模型可能给出的各种形状归一成「字符串数组」，供数组 Schema 继续校验。
 * - `undefined` / `null` → 原样透传，交给数组 Schema 报错（触发纠错）
 * - 字符串 → 按中英文顿号、逗号、分号、换行切分
 * - 数组 → 逐项转字符串并去掉空条目
 */
export function normalizeRawList(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item === null || item === undefined) {
          return "";
        }
        return String(item);
      })
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[、,，;；\n\r]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return value;
}

/** 短文本字段：必填、去空白、限长（内部换行会被保留，正文类字段也能用） */
export function textField(label: string, maxLength: number) {
  return z
    .string()
    .trim()
    .min(1, `${label}不能为空`)
    .max(maxLength, `${label}不能超过 ${maxLength} 字`);
}

export interface TextListOptions {
  /** 单条字数上限 */
  maxItemLength: number;
  /**
   * 最少条数。默认 1 —— 关键列表为空**必须失败**以触发纠错，
   * 而不是静默补空数组让脏结果蒙混过关。
   * 只有「无内容是合法结论」的字段（如风险提示）才传 0。
   */
  minItems?: number;
  /** 条数上限，防止模型灌入超长内容 */
  maxItems?: number;
}

/**
 * 列表字段：至少 minItems 条、最多 maxItems 条、单条不超过 maxItemLength 字。
 * @param label 中文标签，用于生成模型看得懂的纠错提示
 */
export function textListField(label: string, options: TextListOptions) {
  const { maxItemLength, minItems = 1, maxItems = 8 } = options;
  return z.preprocess(
    normalizeRawList,
    z
      .array(
        z
          .string()
          .trim()
          .min(1, `${label}不能包含空条目`)
          .max(maxItemLength, `${label}单条不能超过 ${maxItemLength} 字`),
      )
      .min(minItems, `${label}至少需要 ${minItems} 条`)
      .max(maxItems, `${label}最多 ${maxItems} 条`),
  );
}

/**
 * 按「忽略大小写 + 去首尾空白」的方式去重，保持首次出现顺序。
 *
 * 为什么放在 Schema 之外调用：去重属于**业务归一**而不是格式校验，
 * 若放进 Schema，同一份输出在去重前后会得到不同的校验结论，行为会抖动。
 */
export function dedupeStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item.trim());
  }
  return result;
}
