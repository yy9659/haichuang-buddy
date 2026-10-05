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
 * 内容区外壳：承接登录页的深海氛围 ——
 * 深色基底上铺两层极淡的青蓝光晕，玻璃卡片浮在上面才有「水下」层次。
 */
export function AppContent({ children, shell, user }: AppContentProps) {
  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-gradient-to-b from-[#0a2544] via-[#071c34] to-[#051324]">
      {/* 装饰光晕：不参与交互，纯粹提供纵深 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(720px_320px_at_78%_-80px,oklch(0.8_0.12_210_/_0.16),transparent_70%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[360px] bg-[radial-gradient(640px_300px_at_12%_110%,oklch(0.68_0.16_243_/_0.1),transparent_70%)]"
      />
      <TopBar shell={shell} user={user} />
      <main className="relative mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-5 px-4 py-5 sm:px-5 lg:px-8 lg:py-6">
        {children}
      </main>
    </div>
  );
}
