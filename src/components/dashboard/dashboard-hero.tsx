import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LaunchDailyButton } from "@/components/dashboard/launch-daily-button";
import { SITE } from "@/lib/navigation";

/** 驾驶舱顶部品牌区 + 核心 CTA */
export function DashboardHero() {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-blue-200/60 bg-gradient-to-br from-blue-700 via-blue-600 to-cyan-500 px-6 py-6 text-white shadow-card">
      {/* 海洋氛围层（纯 CSS，无 3D / 无粒子） */}
      <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:radial-gradient(120%_80%_at_85%_-10%,white,transparent_55%)]" />
      <div className="pointer-events-none absolute -right-8 -bottom-16 size-64 rounded-full bg-cyan-300/25 blur-3xl" />
      <div className="pointer-events-none absolute -top-14 left-1/3 size-56 rounded-full bg-blue-300/20 blur-3xl" />

      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium backdrop-blur-sm">
              连江海产 · AI 一人公司
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium backdrop-blur-sm">
              Demo 数据
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl leading-9 font-semibold tracking-tight">
              {SITE.name}
            </h1>
            <p className="text-[13px] leading-5 text-white/85">{SITE.tagline}</p>
          </div>
          <p className="max-w-xl text-[15px] leading-6 font-medium">
            {SITE.heroTitle}
            <span className="mt-1 block text-[12px] leading-5 font-normal text-white/80">
              让 AI 成为你的数字经营团队，从商品到直播、从内容到数据，全流程助力连江海产品经营。
            </span>
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <LaunchDailyButton />
          <Button
            size="lg"
            variant="secondary"
            className="min-w-36 bg-white/95 text-blue-700 hover:bg-white"
          >
            <Upload />
            上传商品，开始经营
          </Button>
        </div>
      </div>
    </section>
  );
}
