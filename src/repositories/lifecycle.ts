/**
 * 记录生命周期规则（任务 / 工作流共用）
 *
 * 为什么单独成文件而不是塞进 `agent-task.ts`：
 * 任务与工作流的**终态集合不同**（工作流多了 `partially_completed` / `cancelled`），
 * 所以「哪些状态算终态」这件事必须由各自定义、作为参数传进来；
 * 但「终态时间怎么定」这条规则必须**完全一致** —— 它决定界面上那句
 * 「耗时 12s」的口径，两边各写一份迟早会漂。
 *
 * 也就是说：变的部分参数化，不变的部分在这里定义唯一实现。
 * 这与 `product-query.ts` / `content-item.ts` 是同一套做法。
 */

import { toDate } from "@/lib/datetime";

/**
 * 计算下一次的完成时间（**以 Date 表达，避免各自的格式化精度损失**）：
 * - 非终态 → null（重新跑时清空）
 * - 终态且原本没有完成时间 → now
 * - 终态且已有完成时间 → 保留原值
 *
 * 最后一条是关键：同一次执行里若状态被写两次终态，
 * 保留**最早**那次，避免耗时口径被后一次写覆盖。
 *
 * 数据库实现直接拿这个 Date 写库（保留毫秒精度），
 * Mock 实现再用 formatDateTime 转成展示字符串。
 */
export function resolveCompletedAt(params: {
  isTerminal: boolean;
  /** 当前已记录的完成时间（Date / 展示字符串 / null） */
  current: Date | string | null;
  now: Date;
}): Date | null {
  if (!params.isTerminal) {
    return null;
  }
  if (params.current === null) {
    return params.now;
  }
  return toDate(params.current) ?? params.now;
}
