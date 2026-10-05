"use client";

import { BookOpen, MessageCircleQuestion } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { BrandMark } from "@/components/layout/brand-mark";
import { NAV_ITEMS } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/** 统一左侧导航栏（深海主题，与登录页同色系） */
export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col border-r border-white/8 bg-[#04101f] lg:flex">
      <div className="flex h-14 items-center border-b border-white/8 px-4">
        <Link href="/dashboard" className="outline-none">
          <BrandMark showSubtitle={false} onDark />
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-[color,background-color,transform,box-shadow] outline-none active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-cyan-400/60",
                active
                  ? "bg-gradient-to-r from-blue-600 to-cyan-500 text-white shadow-lg shadow-blue-500/25"
                  : "text-slate-400 hover:bg-white/8 hover:text-white",
              )}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0 transition-colors",
                  active
                    ? "text-white"
                    : "text-slate-500 group-hover:text-cyan-300",
                )}
                strokeWidth={1.9}
              />
              <span className="truncate">{item.title}</span>
              {active ? (
                <span className="ml-auto size-1.5 rounded-full bg-white" />
              ) : null}
            </Link>
          );
        })}
        <Link href="/public-knowledge" className="mt-3 flex items-center gap-2.5 rounded-xl border-t border-white/8 px-3 py-2.5 text-sm text-slate-400 hover:bg-white/8 hover:text-cyan-200"><BookOpen className="size-4" />海产公共知识库</Link>
      </nav>

      <div className="px-3 pb-4">
        <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-blue-600/80 via-blue-700/70 to-cyan-600/70 p-4 text-white shadow-lg shadow-blue-950/40 backdrop-blur-sm">
          <Image
            src="/assets/buddy-mascot.png"
            alt="海创Buddy 机器人助手"
            width={1312}
            height={1199}
            className="h-auto w-28 object-contain drop-shadow-[0_8px_16px_rgba(34,211,238,0.3)]"
          />
          <p className="mt-2.5 text-[13px] leading-5 font-semibold">
            有问题？
            <br />
            问海创Buddy
          </p>
          <Link
            href="/customer-service"
            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3.5 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          >
            <MessageCircleQuestion className="size-3.5" />
            立即对话
          </Link>
        </div>
        <p className="mt-3 px-2 text-xs text-slate-500">海创Buddy · 本地运行</p>
      </div>
    </aside>
  );
}
