"use client";

/**
 * 「分析中」状态的轻量轮询提示（客户端组件）
 *
 * 为什么需要它：Agent 执行可能是异步的（后续接队列后必然如此），
 * 页面在 `analyzing` 状态下如果只是静态文字，用户就得手动刷新才能看到结果。
 * 这里在挂载期间周期性调用 `router.refresh()`，让 RSC 重新取数；
 * 一旦状态变为 analyzed / failed，本组件随父级一起卸载，轮询自动停止。
 *
 * 刻意设了次数上限：宁可停在「请手动刷新」，也不做一个永不停止的轮询。
 */

import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

/** 轮询间隔与次数上限（约 60 秒），避免长时间挂着的标签页一直打数据库 */
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 20;

export function ProductAnalysisRunningHint() {
  const router = useRouter();
  const pollsRef = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      if (pollsRef.current >= MAX_POLLS) {
        return;
      }
      timer = setTimeout(() => {
        pollsRef.current += 1;
        router.refresh();
        scheduleNext();
      }, POLL_INTERVAL_MS);
    };

    scheduleNext();
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [router]);

  return (
    <p className="flex items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
      <Loader2 className="size-3 animate-spin" />
      正在等待 Agent 返回结果，本页会自动更新（也可手动刷新）。
    </p>
  );
}
