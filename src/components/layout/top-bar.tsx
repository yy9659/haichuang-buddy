"use client";

import {
  Bell,
  ChevronDown,
  LogOut,
  Menu,
  Store,
  BookOpen,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";

import { logoutAction } from "@/actions/auth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BrandMark } from "@/components/layout/brand-mark";
import { DashboardSearch } from "@/components/layout/dashboard-search";
import { NAV_ITEMS } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import type { ShellView } from "@/services";

interface TopBarProps {
  /** 由服务端布局取好并传入，客户端组件不自行请求数据 */
  shell: ShellView;
  /**
   * 当前登录账号。刻意只声明用到的两个字段，而不是 import
   * `AuthUserView`：客户端组件不该依赖 `@/services/auth.service`
   * （那个模块会把数据层一起拉进客户端依赖图）。
   */
  user: { name: string; email: string };
}

/** 顶部栏：当前品牌 / AI 任务通知 / 用户头像 */
export function TopBar({ shell, user }: TopBarProps) {
  const { business, notifications, unreadCount } = shell;
  const router = useRouter();
  const pathname = usePathname();
  const isDashboard = pathname === "/dashboard";
  const [signingOut, startSignOut] = React.useTransition();

  /** 账号名的首字作为头像文字；中文取第一个字、英文取首字母大写 */
  const accountLabel = user.name || user.email;
  const avatarLabel = accountLabel.slice(0, 1).toUpperCase();

  function handleSignOut() {
    startSignOut(async () => {
      await logoutAction();
      // replace 而不是 push：退出后不该能「后退」回到已登录的页面
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-white/8 bg-[#071c34]/80 px-3 backdrop-blur-md sm:px-5 lg:px-8",
        isDashboard && "h-auto flex-wrap pb-2 md:h-14 md:flex-nowrap md:pb-0",
      )}
    >
      <div className="flex items-center gap-1 lg:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="打开导航"
            >
              <Menu />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <DropdownMenuItem key={item.href} asChild>
                  <Link href={item.href} className={cn(active && "text-primary")}>
                    <Icon />
                    {item.title}
                  </Link>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuItem asChild><Link href="/public-knowledge"><BookOpen />海产公共知识库</Link></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Link href="/dashboard">
          <BrandMark showSubtitle={false} onDark />
        </Link>
      </div>

      {isDashboard ? <DashboardSearch /> : null}

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="hidden gap-2 sm:inline-flex"
          asChild
        >
          <Link href="/brand">
            <Store className="text-primary" />
            <span className="max-w-40 truncate">{business?.shortName ?? "品牌资料"}</span>
          </Link>
        </Button>

        {/* AI 任务通知 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              aria-label="任务通知"
            >
              <Bell className="size-4" />
              {unreadCount > 0 ? (
                <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] leading-none font-medium text-destructive-foreground">
                  {unreadCount}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-80">
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>任务通知</span>
              <Badge variant="soft">{unreadCount} 条未读</Badge>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="flex flex-col">
              {notifications.length === 0 ? (
                <p className="px-2.5 py-3 text-[12px] text-muted-foreground">
                  暂无任务通知
                </p>
              ) : (
                notifications.map((item) => (
                  <div
                    key={item.id}
                    className="flex gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-secondary/70"
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        item.read ? "bg-border" : "bg-primary",
                      )}
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13px] leading-5 font-medium">
                        {item.title}
                      </span>
                      <span className="text-[12px] leading-5 text-muted-foreground">
                        {item.description}
                      </span>
                      <span className="text-[11px] text-muted-foreground/80">
                        {item.timeText}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 用户头像 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-label="用户菜单"
            >
              <Avatar className="size-8 border border-border">
                <AvatarFallback className="bg-gradient-to-br from-blue-100 to-cyan-100 text-blue-700">
                  {avatarLabel}
                </AvatarFallback>
              </Avatar>
              <span className="hidden text-[13px] font-medium sm:inline">
                {accountLabel}
              </span>
              <ChevronDown className="hidden size-3.5 text-muted-foreground sm:inline" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-60">
            <DropdownMenuLabel>当前登录</DropdownMenuLabel>
            <div className="flex items-center gap-2.5 px-2.5 pb-2">
              <Avatar className="size-8">
                <AvatarFallback>{avatarLabel}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-medium">
                  {accountLabel}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {user.email}
                </span>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-muted-foreground"
              disabled={signingOut}
              onSelect={(event) => {
                // 阻止 Radix 在回调结束后自动关菜单并夺焦 —— 我们要等
                // 退出请求回来再跳转，中途菜单闪一下会让人以为点空了
                event.preventDefault();
                handleSignOut();
              }}
            >
              <LogOut />
              {signingOut ? "正在退出…" : "退出登录"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
