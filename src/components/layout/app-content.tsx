"use client";

import type { ReactNode } from "react";

import { TopBar } from "@/components/layout/top-bar";
import type { ShellView } from "@/services";

interface AppContentProps {
  children: ReactNode;
  shell: ShellView;
  user: { name: string; email: string };
}

/**
 * 内容区外壳：承接「深海夜航 / 海岸白昼」双主题氛围 ——
 * 表面渐变与两端光晕由 .app-surface 按主题变量渲染，
 * 玻璃卡片浮在上面才有「通透、有深度」的层次。
 */
export function AppContent({ children, shell, user }: AppContentProps) {
  return (
    <div className="app-surface relative flex min-w-0 flex-1 flex-col">
      <TopBar shell={shell} user={user} />
      <main className="relative mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-5 px-4 py-5 sm:px-5 lg:px-8 lg:py-6">
        {children}
      </main>
    </div>
  );
}
