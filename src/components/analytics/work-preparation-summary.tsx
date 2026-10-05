import Link from "next/link";
import { ArrowUpRight, ClipboardCheck, FileText, Headphones, Package } from "lucide-react";

import type { AnalyticsSnapshot } from "@/types";

/** 用商户熟悉的工作事项解释站内记录，不把它当成销售成绩。 */
export function WorkPreparationSummary({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const items = [
    {
      title: "商品资料",
      value: snapshot.product.totalProducts === 0
        ? "还未添加"
        : `${snapshot.product.analyzedProducts} / ${snapshot.product.totalProducts} 件`,
      detail:
        snapshot.product.totalProducts === 0
          ? "还没有商品，先添加一件主推商品。"
          : snapshot.product.analyzedProducts < snapshot.product.totalProducts
            ? "已有商品完成 AI 分析；其余商品还可以继续整理卖点。"
            : "已录入商品均完成 AI 分析，记得核对商品信息。",
      href: "/products",
      link: "查看商品",
      icon: Package,
    },
    {
      title: "推广内容",
      value: `${snapshot.content.totalAssets} 条`,
      detail: snapshot.content.totalAssets === 0
        ? "还没有推广草稿，可以先从主推商品开始。"
        : `已生成的内容草稿，今天新增 ${snapshot.content.generatedToday} 条；发布前请先确认。`,
      href: "/content",
      link: "查看内容",
      icon: FileText,
    },
    {
      title: "待补的答疑资料",
      value: `${snapshot.customerService.openKnowledgeGapCount} 个问题`,
      detail: snapshot.customerService.openKnowledgeGapCount === 0
        ? "站内模拟答疑中暂时没有发现待补的问题。"
        : "来自站内模拟答疑；补充可靠资料后，回答会更有依据。",
      href: "/customer-service",
      link: "查看问题",
      icon: Headphones,
    },
    {
      title: "工作计划",
      value: snapshot.workflow.totalRuns === 0
        ? "还未开始"
        : `${snapshot.workflow.completedRuns} / ${snapshot.workflow.totalRuns} 次完成`,
      detail: "这里统计在工作台执行的计划，不代表商品已售出。",
      href: "/dashboard",
      link: "返回工作台",
      icon: ClipboardCheck,
    },
  ];

  return (
    <section aria-labelledby="work-preparation-title" className="space-y-3">
      <div>
        <h2 id="work-preparation-title" className="text-base font-semibold text-slate-100">
          店里的准备工作
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          看看商品、推广和答疑准备到了哪一步。数字来自海创Buddy内的操作记录。
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <article key={item.title} className="flex flex-col rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <span className="flex size-9 items-center justify-center rounded-xl bg-primary-soft text-primary">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                {item.title}
              </div>
              <p className="mt-3 text-xl font-semibold tabular-nums text-white">{item.value}</p>
              <p className="mt-1 flex-1 text-xs leading-5 text-slate-400">{item.detail}</p>
              <Link href={item.href} className="mt-3 inline-flex w-fit items-center gap-1 text-xs font-medium text-cyan-300 hover:text-cyan-200">
                {item.link}<ArrowUpRight className="size-3.5" aria-hidden="true" />
              </Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}
