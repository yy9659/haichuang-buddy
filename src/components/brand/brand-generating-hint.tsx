"use client";

/**
 * 「生成中」状态的轻量轮询提示（客户端组件）
 *
 * 与商品分析的同名组件同一套做法：挂载期间周期性调用 `router.refresh()`，
 * 让 RSC 重新取数；一旦状态变成 completed / failed，本组件随父级一起卸载，轮询自动停止。
 *
 * 与商品分析的差异：品牌策略走 reasoning 档位，单次耗时更长，
 * 因此把间隔放宽到 4 秒、上限提到 25 次（约 100 秒），避免用户以为页面卡住。
 * 刻意设了次数上限：宁可停在「请手动刷新」，也不做一个永不停止的轮询。
 */

import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

/** 轮询间隔与次数上限（约 100 秒） */
const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 25;

export function BrandGeneratingHint() {
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
      正在等待品牌经理 Agent 返回结果，本页会自动更新（也可手动刷新）。
    </p>
  );
}
