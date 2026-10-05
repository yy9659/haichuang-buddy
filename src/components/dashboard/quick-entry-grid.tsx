import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { NAV_ITEMS } from "@/lib/navigation";

const DASHBOARD_ROLE_TITLES: Readonly<Record<string, string>> = {
  "/products": "商品经理",
  "/brand": "品牌经理",
  "/content": "内容运营",
  "/live": "直播导演",
  "/customer-service": "智能客服",
  "/analytics": "经营分析师",
};

/** 与侧栏共用模块目录，首页的每个入口都落到现有工作区。 */
export function QuickEntryGrid() {
  return (
    <section aria-labelledby="module-entry-title">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="module-entry-title" className="text-lg font-semibold text-white">开始今天的工作</h2>
        <p className="text-[13px] text-slate-400">选一个模块，把想法变成下一步行动</p>
      </div>
      <div className="min-w-0 overflow-x-auto pb-2 xl:overflow-visible xl:pb-0">
        <div className="grid w-full min-w-[900px] grid-cols-6 gap-3">
          {NAV_ITEMS.filter((item) => item.href !== "/dashboard").map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} className="group min-w-0 rounded-2xl border border-white/10 bg-white/[0.05] p-4 shadow-md shadow-black/20 backdrop-blur-md transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-cyan-400/30 hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400">
                <div className="mb-3 flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-400/20 to-cyan-400/15 text-cyan-300">
                    <Icon className="size-5" strokeWidth={1.8} />
                  </span>
                  <ArrowUpRight className="size-4 text-slate-500 transition-colors group-hover:text-cyan-300" />
                </div>
                <h3 className="text-sm font-semibold text-slate-100">
                  {DASHBOARD_ROLE_TITLES[item.href] ?? item.title}
                </h3>
                <p className="mt-1 text-[13px] leading-5 text-slate-400">{item.description}</p>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
