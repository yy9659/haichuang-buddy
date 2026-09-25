"use client";

import * as React from "react";

import { TooltipProvider } from "@/components/ui/tooltip";

/** 全局 Provider 集合（当前仅 Tooltip） */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}
