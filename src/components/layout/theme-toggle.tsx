"use client";

import * as React from "react";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/utils";

/**
 * 「深海夜航 / 海岸白昼」主题切换胶囊。
 *
 * 设计要点：
 * - 胶囊轨道 + 滑动渐变拇指，拇指滑到哪一侧，哪一侧图标点亮；
 * - 图标随切换平滑旋转 / 缩放，杜绝生硬的瞬间替换；
 * - 水合完成前渲染同尺寸占位骨架，避免顶栏布局抖动。
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div
        aria-hidden="true"
        className="h-8 w-[68px] rounded-full border border-border bg-secondary"
      />
    );
  }

  const isDark = resolvedTheme !== "light";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "切换到海岸白昼" : "切换到深海夜航"}
      title={isDark ? "海岸白昼" : "深海夜航"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn(
        "group relative flex h-8 w-[68px] items-center rounded-full border p-0.5 outline-none",
        "border-border bg-[var(--toggle-track)] backdrop-blur-md",
        "transition-all duration-300 ease-out",
        "hover:border-primary/40 hover:shadow-[0_0_16px_-4px_var(--ring)]",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
    >
      {/* 滑动拇指：渐变 + 微光 */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0.5 left-0.5 size-[26px] rounded-full shadow-md",
          "bg-[image:var(--toggle-thumb)]",
          "transition-transform duration-400 ease-[cubic-bezier(0.34,1.4,0.64,1)]",
          isDark ? "translate-x-0" : "translate-x-[36px]",
        )}
      />
      {/* 月亮（深海夜航） */}
      <span className="relative z-10 flex size-[26px] items-center justify-center">
        <Moon
          className={cn(
            "size-3.5 transition-all duration-400",
            isDark
              ? "rotate-0 scale-100 text-slate-950"
              : "-rotate-90 scale-75 text-muted-foreground",
          )}
          strokeWidth={2.2}
        />
      </span>
      {/* 太阳（海岸白昼） */}
      <span className="relative z-10 ml-auto flex size-[26px] items-center justify-center">
        <Sun
          className={cn(
            "size-3.5 transition-all duration-400",
            isDark
              ? "rotate-90 scale-75 text-muted-foreground"
              : "rotate-0 scale-100 text-white",
          )}
          strokeWidth={2.2}
        />
      </span>
    </button>
  );
}
