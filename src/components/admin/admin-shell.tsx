"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, BookOpen, LayoutDashboard, LogOut, Maximize2, RefreshCw, ShieldCheck } from "lucide-react";
import { logoutAction } from "@/actions/auth";
import { BrandMark } from "@/components/layout/brand-mark";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const links = [{ href: "/admin", title: "指挥大屏", icon: LayoutDashboard }, { href: "/admin/monitor", title: "AI 运行监控", icon: Activity }, { href: "/admin/knowledge", title: "海产公共知识库", icon: BookOpen }];
export function AdminShell({ children, user }: { children: ReactNode; user: { name: string; email: string } }) {
  const pathname = usePathname(), router = useRouter();
  const [clock, setClock] = useState("北京时间"), [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();
  useEffect(() => { const update = () => setClock(new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())); update(); const timer = setInterval(update, 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === "visible" && pathname !== "/admin/knowledge") startTransition(() => router.refresh()); }, 30000); return () => clearInterval(timer); }, [pathname, router]);
  async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { setNotice("当前浏览器未开启全屏，可按 F11 查看大屏。"); } }
  return <div className="relative min-h-screen overflow-x-clip bg-[#040f20] text-slate-100">
    <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(14,165,233,0.18),transparent_65%)]" />
    <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.035] [background-image:linear-gradient(#38bdf8_1px,transparent_1px),linear-gradient(90deg,#38bdf8_1px,transparent_1px)] [background-size:40px_40px]" />
    <header className="relative flex flex-wrap items-center justify-between gap-4 border-b border-cyan-400/15 bg-[#07182c]/85 px-5 py-5 xl:px-8">
      <Link href="/admin" className="shrink-0"><BrandMark onDark showSubtitle={false} /><span className="mt-1.5 flex items-center gap-1 text-[10px] tracking-[0.15em] text-cyan-300/70"><ShieldCheck className="size-3" />平台管理中心</span></Link>
      <div className="order-3 w-full text-center md:order-none md:w-auto"><p className="text-[9px] tracking-[0.4em] text-cyan-400/60">HAICHUANG · OCEAN INTELLIGENCE</p><h1 className="mt-1.5 bg-gradient-to-r from-blue-100 via-cyan-100 to-blue-200 bg-clip-text text-xl font-bold tracking-[0.12em] text-transparent lg:text-2xl">连江海洋经济 · OPC 赋能指挥中心</h1><div className="mx-auto mt-3 h-px w-3/4 bg-gradient-to-r from-transparent via-cyan-400/70 to-transparent" /></div>
      <div className="text-right"><p className="font-mono text-xs tracking-wider text-cyan-100">{clock}</p><p className="mt-2 text-[11px] text-slate-400">管理员 · {user.name || user.email}</p></div>
    </header>
    <div className="relative mx-auto max-w-[1920px] px-4 pb-6 sm:px-6 xl:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <nav aria-label="管理端导航" className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-cyan-500/15 bg-[#0b243c] p-1">{links.map(({ href, title, icon: Icon }) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className={cn("flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-xs transition-colors sm:px-5", pathname === href ? "bg-gradient-to-r from-blue-600/70 to-cyan-600/50 text-white shadow-[0_0_18px_rgba(14,165,233,0.15)]" : "text-slate-400 hover:bg-white/5 hover:text-cyan-100")}><Icon className="size-4" />{title}</Link>)}</nav>
        <div className="flex items-center gap-1"><Button aria-label="刷新管理端" variant="ghost" size="icon" disabled={pending} onClick={() => startTransition(() => router.refresh())}><RefreshCw className={cn(pending && "animate-spin")} /></Button><Button aria-label="全屏展示" variant="ghost" size="icon" onClick={fullscreen}><Maximize2 /></Button><Button aria-label="退出管理员账号" variant="ghost" size="icon" disabled={pending} onClick={() => startTransition(async () => { await logoutAction(); router.replace("/login"); router.refresh(); })}><LogOut /></Button></div>
      </div>
      {notice && <p role="status" className="mb-3 text-sm text-cyan-200">{notice}</p>}
      <main className="relative">{children}</main>
      <footer className="mt-5 flex flex-wrap justify-between gap-2 border-t border-cyan-400/10 pt-4 text-[10px] text-slate-500"><span>海创Buddy · 连江海产 OPC 服务平台</span><span>管理员专属空间 · 任务监控每 30 秒刷新</span></footer>
    </div>
  </div>;
}
