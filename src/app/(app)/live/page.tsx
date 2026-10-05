import type { Metadata } from "next";

import { DataFallback } from "@/components/common/data-fallback";
import { ModuleUnavailable } from "@/components/common/module-unavailable";
import { PageHeader } from "@/components/common/page-header";
import { LiveSessionControls } from "@/components/live/live-session-controls";
import { LiveRehearsalPanel } from "@/components/live/live-rehearsal-panel";
import { Badge } from "@/components/ui/badge";
import { unwrapOrThrow } from "@/lib/result";
import { getLiveView } from "@/services";

export const metadata: Metadata = {
  title: "直播彩排 · 海创Buddy",
};

/**
 * AI 直播间：左（直播数据 + 评论）/ 中（主播提词器 + 当前商品）/ 右（AI 直播导演）。
 *
 * 页面本身**不含任何业务逻辑**，只做两件事：取一份 `LiveView`、按三栏铺开。
 * 三栏的数据都来自同一次 `getLiveView()`，因此「录入一条评论」后整页刷新，
 * 评论流、真实指标、热点、提词器、AI 建议会一起更新 —— 不会出现左栏已加、
 * 右栏还是旧建议这种半新半旧的错位。
 *
 * ## 为什么先判 `unavailableReason`
 *
 * `local` / `db` 数据源下 `live_*` 表还没建（见 `@/repositories/db/index.ts`），
 * 直播仓储会抛 `NOT_IMPLEMENTED`。此时界面**必须**说「这个模块还没启用」，
 * 而不是走进「未开播」态 —— 后者会让商家以为「点一下开始直播就有了」，
 * 然后对着一个永远失败的主播台一直点。
 */
export default async function LivePage() {
  const view = unwrapOrThrow(await getLiveView());
  const {
    session,
    realMetrics,
    comments,
    suggestions,
    hotTopics,
    teleprompter,
    quickComments,
    products,
    unavailableReason,
  } = view;

  if (unavailableReason) {
    return (
      <>
        <PageHeader
          title="直播彩排"
          description="输入模拟观众问题，练习回答并核对依据；不连接真实直播。"
          badge={<Badge variant="soft">当前数据源未启用</Badge>}
        />
        <ModuleUnavailable title="直播彩排" reason={unavailableReason} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="直播彩排"
        description="输入模拟观众问题，练习回答并核对依据；不连接真实直播。"
        badge={
          session && session.status === "live" ? (
            <Badge variant="danger" className="gap-1.5">
              <span className="size-1.5 animate-pulse-soft rounded-full bg-current" />
              彩排中 {session.durationText}
            </Badge>
          ) : (
            <Badge variant="soft">{session ? "已结束" : "未开始彩排"}</Badge>
          )
        }
      />

      <section className="rounded-xl border border-border bg-card px-4 py-3 shadow-card" aria-label="彩排商品与场次操作">
        <LiveSessionControls session={session} products={products} />
      </section>

      {session && teleprompter ? (
        <LiveRehearsalPanel
          key={session.id}
          session={session}
          comments={comments}
          realMetrics={realMetrics}
          quickComments={quickComments}
          teleprompter={teleprompter}
          suggestions={suggestions}
          hotTopics={hotTopics}
        />
      ) : (
        <DataFallback title="准备彩排" description="选择商品并开始彩排，镜头、提问和回答建议会显示在同一个工作区。" />
      )}
    </>
  );
}
