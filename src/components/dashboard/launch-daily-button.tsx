"use client";

import { LoaderCircle, Play, Sparkles } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type LaunchState = "idle" | "launching" | "launched";

/**
 * 核心 CTA：启动今日经营。
 * 本轮仅做前端交互反馈（Mock），不触达任何 Agent 逻辑或接口。
 */
export function LaunchDailyButton({ className }: { className?: string }) {
  const [state, setState] = React.useState<LaunchState>("idle");

  const handleLaunch = () => {
    if (state !== "idle") return;
    setState("launching");
    window.setTimeout(() => setState("launched"), 1200);
  };

  return (
    <div className={cn("flex flex-col items-start gap-1.5", className)}>
      <Button
        size="lg"
        onClick={handleLaunch}
        disabled={state !== "idle"}
        className="min-w-40 shadow-sm"
      >
        {state === "idle" ? (
          <>
            <Play />
            启动今日经营
          </>
        ) : null}
        {state === "launching" ? (
          <>
            <LoaderCircle className="animate-spin" />
            AI 经营大脑规划中
          </>
        ) : null}
        {state === "launched" ? (
          <>
            <Sparkles />
            今日经营已启动
          </>
        ) : null}
      </Button>
      <span className="text-[11px] leading-4 text-white/80">
        {state === "launched"
          ? "Demo Mock：已模拟下发今日任务链，接入 Agent 后此处将展示真实执行进度"
          : "AI 经营大脑将拆解目标，并调度 6 个 AI 数字员工协同执行"}
      </span>
    </div>
  );
}
