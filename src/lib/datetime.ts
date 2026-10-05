/**
 * 时间格式化的纯函数集合
 *
 * 为什么单独抽出来：
 * - 领域类型（src/types）里的时间字段是**展示用字符串**，如 "2026-09-25 10:24"，
 *   数据库里存的是 timestamptz。两者之间的转换必须统一，否则 DB / Mock 两种
 *   数据源会出现格式不一致（页面视觉回归）。
 * - 顶部栏通知、Agent 最近执行时间需要「x 分钟前」这类相对时间，同样要可测试。
 *
 * 全部为纯函数，`now` 可注入，便于单测。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 把数据库/JSON 里的时间值统一成 Date；非法值返回 null */
export function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 「今天」的起点：`date` 所在自然日的 00:00:00.000。
 *
 * ## 为什么把它单独封成一个函数
 *
 * 「今日指标」是这个项目里最容易长出第二套口径的东西：会话仓储、消息仓储、
 * 指标层各自 `new Date()` 再 `setHours(0,0,0,0)`，看起来一样，
 * 但任一处写成「最近 24 小时」或忘了清零，驾驶舱上的数字就会互相对不上，
 * 而且**不会有任何报错**。边界只在这里定义一次，谁要算「今日」都调它。
 *
 * ## 时区策略（明确写下来，因为它是个决策而不是疏忽）
 *
 * 用**服务器本地时区**的自然日，不引入业务时区配置：
 * 这个项目的商家、数据源与时区都是单一的，为「今日」造一套
 * 时区解析 + 夏令时处理，收益是零，换来的是又一处可能算错的地方。
 * 将来真的要多时区经营时，**只改这一个函数**即可（调用方全部传 Date 进来，
 * 拿到的都是一个明确的瞬间）。
 */
export function startOfDay(date: Date = new Date()): Date {
  const start = new Date(date.getTime());
  start.setHours(0, 0, 0, 0);
  return start;
}

/** "2026-09-25 10:24"（本地时区），与 Phase 0 Mock 数据格式保持一致 */
export function formatDateTime(
  value: Date | string | number | null | undefined,
): string {
  const date = toDate(value);
  if (!date) {
    return "";
  }
  return `${formatDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "2026-09-25" */
export function formatDate(value: Date | string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) {
    return "";
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 两个时间是否落在**同一个本地自然日**。
 *
 * 与 `startOfDay` 共用同一条时区口径（服务器本地时区），
 * 因此「今日 AI 任务」这类统计不会出现「一处按 00:00 切、另一处按最近 24 小时切」
 * 的口径漂移。非法时间返回 `false`（无法判定就不算今天，而不是当成今天）。
 */
export function isSameLocalDay(
  value: Date | string | number | null | undefined,
  reference: Date,
): boolean {
  const date = toDate(value);
  if (!date) {
    return false;
  }
  return (
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  );
}

/** "10:24" */
export function formatTime(value: Date | string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) {
    return "";
  }
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 相对时间文案："刚刚" / "3 分钟前" / "2 小时前" / "3 天前"，
 * 超过 7 天回退为绝对时间。
 */
export function formatRelativeTime(
  value: Date | string | number | null | undefined,
  now: Date = new Date(),
): string {
  const date = toDate(value);
  if (!date) {
    return "";
  }

  const diff = now.getTime() - date.getTime();
  // 未来时间（时钟漂移 / 数据异常）不显示负数，统一按「刚刚」处理
  if (diff < MINUTE) {
    return "刚刚";
  }
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)} 分钟前`;
  }
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)} 小时前`;
  }
  if (diff < 7 * DAY) {
    return `${Math.floor(diff / DAY)} 天前`;
  }
  return formatDateTime(date);
}

/** 直播时长 / 任务耗时展示："00:24:18" */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(rest)}`;
}

/**
 * Agent 任务耗时展示（入参为毫秒）："—" / "320ms" / "1.2s" / "1m 05s"。
 * 非法值（未完成、负数、NaN）统一显示 "—"，避免界面出现 "NaNms" 这类噪声。
 */
export function formatDurationMs(milliseconds: number | null | undefined): string {
  if (
    milliseconds === null ||
    milliseconds === undefined ||
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  ) {
    return "—";
  }
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${pad2(Math.round(seconds % 60))}s`;
}
