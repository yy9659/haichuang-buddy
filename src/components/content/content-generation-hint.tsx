"use client";

/**
 * 「生成中」状态的轻量轮询提示（客户端组件）
 *
 * 与商品分析、品牌中心的同名组件同一套做法：挂载期间周期性调用 `router.refresh()`，
 * 让 RSC 重新取数；一旦状态变成 completed / failed，本组件随父级一起卸载，轮询自动停止。
 *
 * 间隔与上限的取值依据：内容生产走 `fast` 档位（见 Content Agent 的 ModelTier），
 * 比品牌策略快，因此间隔比品牌中心（4 秒 / 25 次）更密、上限更短 ——
 * 3 秒 × 20 次 ≈ 60 秒，已经远超一次 fast 档生成的正常耗时，
 * 再久就是模型侧出了问题，与其让页面默默转下去，不如停下来请用户手动刷新。
 * 刻意设上限：宁可停在「请手动刷新」，也不做一个永不停止的轮询。
 */

import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

/** 轮询间隔与次数上限（约 60 秒） */
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 20;

export function ContentGeneratingHint() {
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
      正在等待内容运营 Agent 返回结果，本页会自动更新（也可手动刷新）。
    </p>
  );
}
