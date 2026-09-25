"use client";

import {
  Bot,
  Check,
  ChevronDown,
  LogOut,
  Search,
  Settings,
  Store,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";

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
import { Input } from "@/components/ui/input";
import { BrandMark } from "@/components/layout/brand-mark";
import { MOCK_AGENT_NOTIFICATIONS, MOCK_BUSINESS, MOCK_OWNER_TWIN } from "@/lib/mock";
import { cn } from "@/lib/utils";

const BRAND_OPTIONS = [
  { id: MOCK_BUSINESS.id, name: MOCK_BUSINESS.name, meta: "默认品牌" },
  { id: "biz_demo_002", name: "海创海产 · 礼盒专线", meta: "副品牌" },
];

/** 顶部栏：当前品牌 / AI 任务通知 / 用户头像 */
export function TopBar() {
  const unreadCount = MOCK_AGENT_NOTIFICATIONS.filter((item) => !item.read).length;
  const [activeBrandId, setActiveBrandId] = React.useState(MOCK_BUSINESS.id);
  const activeBrand =
    BRAND_OPTIONS.find((brand) => brand.id === activeBrandId) ?? BRAND_OPTIONS[0];

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-card/85 px-4 backdrop-blur-md">
      <div className="lg:hidden">
        <BrandMark showSubtitle={false} />
      </div>

      <div className="relative hidden max-w-sm flex-1 md:block">
        <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="搜索商品、任务、内容…"
          className="border-transparent bg-muted/70 pl-8 focus-visible:bg-card"
          aria-label="全局搜索"
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* 当前品牌 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <Store className="size-3.5 text-primary" />
              <span className="max-w-40 truncate font-medium">
                {activeBrand.name}
              </span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64">
            <DropdownMenuLabel>切换当前品牌</DropdownMenuLabel>
            {BRAND_OPTIONS.map((brand) => (
              <DropdownMenuItem
                key={brand.id}
                onSelect={() => setActiveBrandId(brand.id)}
                className="items-start gap-2.5"
              >
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                  <Store className="size-3.5" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-medium">{brand.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {brand.meta}
                  </span>
                </span>
                {brand.id === activeBrandId ? (
                  <Check className="ml-auto size-3.5 shrink-0 text-primary" />
                ) : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/brand">
                <Settings />
                管理品牌资料
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* AI 任务通知 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              aria-label="AI 任务通知"
            >
              <Bot className="size-4" />
              {unreadCount > 0 ? (
                <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] leading-none font-medium text-destructive-foreground">
                  {unreadCount}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-80">
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>AI 任务通知</span>
              <Badge variant="soft">{unreadCount} 条未读</Badge>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="flex flex-col">
              {MOCK_AGENT_NOTIFICATIONS.map((item) => (
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
              ))}
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
                  {MOCK_OWNER_TWIN.avatarLabel}
                </AvatarFallback>
              </Avatar>
              <span className="hidden text-[13px] font-medium sm:inline">
                {MOCK_OWNER_TWIN.displayName}
              </span>
              <ChevronDown className="hidden size-3.5 text-muted-foreground sm:inline" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-60">
            <DropdownMenuLabel>当前登录</DropdownMenuLabel>
            <div className="flex items-center gap-2.5 px-2.5 pb-2">
              <Avatar className="size-8">
                <AvatarFallback>{MOCK_OWNER_TWIN.avatarLabel}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-medium">
                  {MOCK_OWNER_TWIN.displayName}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {MOCK_BUSINESS.location}
                </span>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <UserRound />
              老板数字分身
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Settings />
              账号设置
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-muted-foreground">
              <LogOut />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
