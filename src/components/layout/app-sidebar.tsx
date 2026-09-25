"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { BrandMark } from "@/components/layout/brand-mark";
import { NAV_ITEMS } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/** 统一左侧导航栏 */
export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <Link href="/dashboard" className="outline-none">
          <BrandMark />
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-3">
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
                "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-secondary/70",
              )}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0 transition-colors",
                  active
                    ? "text-sidebar-primary"
                    : "text-muted-foreground group-hover:text-foreground",
                )}
                strokeWidth={1.9}
              />
              <span className="truncate">{item.title}</span>
              {active ? (
                <span className="ml-auto size-1.5 rounded-full bg-sidebar-primary" />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="p-3">
        <div className="relative overflow-hidden rounded-xl border border-sidebar-border bg-gradient-to-b from-sky-50 to-blue-100/70 p-3.5">
          <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-blue-200/60 to-transparent" />
          <div className="relative flex flex-col gap-1.5">
            <span className="text-[12px] leading-5 font-semibold text-blue-900">
              一个人，也可以拥有一支
              <br />
              AI 经营团队。
            </span>
            <span className="text-[11px] leading-4 text-blue-800/70">
              6 个 AI 数字员工 + 1 套经营闭环
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
