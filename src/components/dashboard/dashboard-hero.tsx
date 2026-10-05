import { PlayCircle, Waves } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

/** 按服务器当前时段给出英文问候（页面 force-dynamic，每次请求实时渲染）。 */
function greetingByHour(hour: number): string {
  if (hour < 5) return "Good Night";
  if (hour < 12) return "Good Morning";
  if (hour < 18) return "Good Afternoon";
  return "Good Evening";
}

/**
 * 首页航海横幅（图一构图）：
 * 左侧深蓝渐变上排文案与双 CTA，右侧保留渔船画面，右上角手写体标语。
 */
export function DashboardHero({ cta }: { cta?: ReactNode }) {
  const greeting = greetingByHour(new Date().getHours());

  return (
    <section className="relative isolate overflow-hidden rounded-3xl bg-[#0a2248] text-white shadow-lg shadow-blue-950/10">
      <Image
        src="/assets/dashboard-ocean.png"
        alt=""
        fill
        priority
        sizes="(min-width: 1440px) 1200px, (min-width: 1024px) calc(100vw - 296px), 100vw"
        className="object-cover object-[72%_center]"
      />
      {/* 左侧压暗保证文字可读，右侧透出渔船与海面 */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-r from-[#081c3a]/95 via-[#0a2a56]/60 to-transparent"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-t from-[#081c3a]/35 via-transparent to-transparent"
      />

      {/* 右上角手写体标语 */}
      <p
        aria-hidden="true"
        className="absolute top-5 right-7 hidden rotate-[-2deg] text-right text-[15px] leading-6 font-medium text-white/90 italic drop-shadow-md md:block"
        style={{ fontFamily: "'Segoe Script', 'Ma Shan Zheng', cursive" }}
      >
        让中国的海产生意
        <br />
        更简单，更赚钱！
      </p>

      <div className="relative flex min-h-[232px] flex-col justify-center px-6 py-8 sm:px-9 lg:px-11">
        <span className="mb-2 inline-flex items-center gap-2 text-xs font-medium tracking-wider text-cyan-200">
          <Waves className="size-4" /> 海创Buddy · 连江海产经营伙伴
        </span>
        <h1 className="max-w-xl text-[26px] leading-tight font-semibold tracking-tight sm:text-[32px]">
          {greeting}，连江海产经营者！
        </h1>
        <p className="mt-2 max-w-lg text-[13px] leading-5 text-blue-100/90 sm:text-sm">
          我是海创Buddy，你的 AI 海洋商业助手。
          <br />
          从商品、品牌到推广、直播与答疑，助你把握每一个蓝色机遇。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 sm:gap-4">
          {cta}
          <Link
            href="/analytics"
            className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-4 py-2.5 text-sm font-medium backdrop-blur-sm transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
          >
            <PlayCircle className="size-4" />
            查看工作复盘
          </Link>
        </div>
      </div>
    </section>
  );
}
