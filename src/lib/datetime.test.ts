import { describe, expect, it } from "vitest";

import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatDurationMs,
  formatRelativeTime,
  formatTime,
  toDate,
} from "./datetime";
import { createLocalId, isUuid } from "./id";

describe("toDate", () => {
  it("接受 Date / ISO 字符串 / 时间戳", () => {
    const date = new Date("2026-09-25T10:24:00");
    expect(toDate(date)?.getTime()).toBe(date.getTime());
    expect(toDate(date.toISOString())?.getTime()).toBe(date.getTime());
    expect(toDate(date.getTime())?.getTime()).toBe(date.getTime());
  });

  it("空值与非法值返回 null", () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("not-a-date")).toBeNull();
  });
});

describe("时间格式化", () => {
  const date = new Date(2026, 8, 25, 10, 24);

  it("formatDateTime 与 Mock 数据格式一致（YYYY-MM-DD HH:mm）", () => {
    expect(formatDateTime(date)).toBe("2026-09-25 10:24");
  });

  it("formatDate / formatTime 拆分", () => {
    expect(formatDate(date)).toBe("2026-09-25");
    expect(formatTime(date)).toBe("10:24");
  });

  it("个位数月份与分钟补零", () => {
    expect(formatDateTime(new Date(2026, 0, 5, 9, 7))).toBe("2026-01-05 09:07");
  });

  it("非法值返回空字符串而不是 Invalid Date", () => {
    expect(formatDateTime(null)).toBe("");
    expect(formatDate("bad")).toBe("");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date(2026, 8, 25, 12, 0, 0);

  it("一分钟内显示「刚刚」", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 30 * 1000), now)).toBe("刚刚");
  });

  it("分钟 / 小时 / 天 分档", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 60 * 1000), now)).toBe(
      "3 分钟前",
    );
    expect(formatRelativeTime(new Date(now.getTime() - 2 * 3600 * 1000), now)).toBe(
      "2 小时前",
    );
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 86400 * 1000), now)).toBe(
      "3 天前",
    );
  });

  it("超过 7 天回退为绝对时间", () => {
    expect(formatRelativeTime(new Date(now.getTime() - 10 * 86400 * 1000), now)).toBe(
      "2026-09-15 12:00",
    );
  });

  it("未来时间不显示负数（时钟漂移防护）", () => {
    expect(formatRelativeTime(new Date(now.getTime() + 60 * 1000), now)).toBe("刚刚");
  });
});

describe("formatDuration", () => {
  it("输出 HH:mm:ss", () => {
    expect(formatDuration(1458)).toBe("00:24:18");
    expect(formatDuration(3661)).toBe("01:01:01");
  });

  it("非法或负数归零", () => {
    expect(formatDuration(-5)).toBe("00:00:00");
    expect(formatDuration(Number.NaN)).toBe("00:00:00");
  });
});

describe("id 工具", () => {
  it("isUuid 只接受标准 uuid", () => {
    expect(isUuid("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
    expect(isUuid("PROD_001")).toBe(false);
    expect(isUuid("none")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid("3f2504e0-4f89-11d3-9a0c")).toBe(false);
  });

  it("createLocalId 带前缀且互不重复", () => {
    const first = createLocalId("prod");
    const second = createLocalId("prod");
    expect(first.startsWith("prod_")).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe("formatDurationMs（Agent 任务耗时）", () => {
  it("毫秒 / 秒 / 分钟三档切换", () => {
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(320)).toBe("320ms");
    expect(formatDurationMs(999)).toBe("999ms");
    expect(formatDurationMs(1200)).toBe("1.2s");
    expect(formatDurationMs(59_400)).toBe("59.4s");
    expect(formatDurationMs(65_000)).toBe("1m 05s");
  });

  it("未完成 / 非法值统一显示为占位符，不给界面留 NaN", () => {
    expect(formatDurationMs(null)).toBe("—");
    expect(formatDurationMs(undefined)).toBe("—");
    expect(formatDurationMs(Number.NaN)).toBe("—");
    expect(formatDurationMs(-1)).toBe("—");
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
