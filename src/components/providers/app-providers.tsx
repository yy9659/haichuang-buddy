"use client";

import * as React from "react";

import { ThemeProvider } from "next-themes";

import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * 全局 Provider 集合。
 *
 * next-themes 负责「深海夜航 / 海岸白昼」双主题：
 * - attribute="class"：在 <html> 上切换 .dark / .light；
 * - defaultTheme="dark"：深海夜航为默认主题；
 * - enableSystem={false}：不跟随系统偏好，商户的选择唯一可信；
 * - 主题类在首屏渲染前由 next-themes 注入的内联脚本写定，无 FOUC。
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      storageKey="haichuang-theme"
    >
      <TooltipProvider>{children}</TooltipProvider>
    </ThemeProvider>
  );
}
