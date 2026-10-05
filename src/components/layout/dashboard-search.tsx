"use client";

import { ArrowUpRight, FileText, GitBranch, LoaderCircle, Package, Search, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { normalizeSearchQuery, SEARCH_MAX_LENGTH, searchShortcuts, searchTokens } from "@/lib/dashboard-search";
import { cn } from "@/lib/utils";
import type { DashboardSearchResponse, SearchGroup, SearchKind } from "@/types/search";

const icons = { product: Package, content: FileText, workflow: GitBranch, action: Sparkles } satisfies Record<SearchKind, typeof Search>;

function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = searchTokens(query).sort((a, b) => b.length - a.length);
  if (!tokens.length) return text;
  const escaped = tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.split(new RegExp(`(${escaped.join("|")})`, "giu")).map((part, index) => tokens.includes(part.toLocaleLowerCase())
    ? <mark key={index} className="bg-transparent font-semibold text-cyan-300">{part}</mark>
    : part);
}

interface SearchState {
  query: string;
  phase: "loading" | "ready" | "error";
  data?: DashboardSearchResponse;
  message?: string;
}

export function DashboardSearch() {
  const router = useRouter();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<SearchState>({ query: "", phase: "ready" });
  const query = normalizeSearchQuery(value);
  const waiting = !!query && (composing || state.query !== query || state.phase === "loading");
  const error = !waiting && state.phase === "error" && state.query === query ? state.message : null;
  const groups: SearchGroup[] = !query
    ? [{ kind: "action", label: "常用操作", items: searchShortcuts(), hasMore: false }]
    : !waiting && !error ? state.data?.groups ?? [] : [];
  const items = groups.flatMap(group => group.items);

  useEffect(() => {
    if (!open || !query || composing) return;
    const controller = new AbortController();
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const debounce = setTimeout(async () => {
      setState({ query, phase: "loading" });
      timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`/api/search?${new URLSearchParams({ q: query })}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? "暂时无法搜索，请稍后重试");
        if (!disposed) {
          setState({ query, phase: "ready", data });
          setActiveIndex(-1);
        }
      } catch (cause) {
        if (!disposed) setState({ query, phase: "error", message: controller.signal.aborted ? "搜索超时，请重试" : cause instanceof TypeError ? "网络连接异常，请重试" : cause instanceof Error ? cause.message : "暂时无法搜索，请稍后重试" });
      } finally {
        clearTimeout(timeout);
      }
    }, 250);
    return () => { disposed = true; clearTimeout(debounce); clearTimeout(timeout); controller.abort(); };
  }, [query, open, composing, retry]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, id]);

  function closeSearch() {
    setOpen(false);
    setActiveIndex(-1);
  }

  return (
    <div ref={root} role="search" className="relative order-3 w-full md:absolute md:top-1/2 md:left-1/2 md:order-none md:w-[min(520px,calc(100%_-_540px))] md:-translate-x-1/2 md:-translate-y-1/2"
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeSearch(); }}>
      <label htmlFor="dashboard-header-search" className="sr-only">搜索经营任务、商品档案或营销指令</label>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-cyan-300" />
        <input ref={input} id="dashboard-header-search" type="text" role="combobox" autoComplete="off" spellCheck={false}
          aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-results`} aria-activedescendant={open && activeIndex >= 0 && items[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
          placeholder="搜索经营任务、商品档案或营销指令..." maxLength={SEARCH_MAX_LENGTH} value={value}
          onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
          onChange={event => { setValue(event.target.value); setOpen(true); setActiveIndex(-1); }}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={event => { setComposing(false); setValue(event.currentTarget.value); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return;
            if (event.key === "Escape") { event.preventDefault(); closeSearch(); }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); setOpen(true);
              if (items.length) setActiveIndex(index => event.key === "ArrowDown" ? (index + 1) % items.length : (index <= 0 ? items.length - 1 : index - 1));
            }
            if (event.key === "Enter" && open) {
              event.preventDefault();
              const item = items[Math.max(activeIndex, 0)];
              if (item && !waiting) { closeSearch(); input.current?.blur(); router.push(item.href); }
            }
          }}
          className="h-10 w-full rounded-full border border-white/15 bg-white/8 pr-10 pl-10 text-sm text-white shadow-inner shadow-black/20 outline-none placeholder:text-slate-400 focus:border-cyan-400/60 focus:bg-white/12 focus:ring-2 focus:ring-cyan-400/25" />
        {value ? <button type="button" aria-label="清空搜索" onMouseDown={event => event.preventDefault()} onClick={() => { setValue(""); setActiveIndex(-1); setOpen(true); input.current?.focus(); }} className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:bg-white/10 hover:text-white"><X className="size-4" /></button> : null}
      </div>

      {open ? <div className="absolute top-full right-0 left-0 z-50 mt-2 overflow-hidden rounded-2xl border border-cyan-300/20 bg-[#102a44] text-slate-100 shadow-2xl shadow-black/40 md:left-1/2 md:w-[max(100%,400px)] md:max-w-[calc(100vw-2rem)] md:-translate-x-1/2">
        <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
          <span className="text-xs font-medium text-cyan-200">{query ? "搜索结果" : "快捷入口"}</span>
          <span className="text-[11px] text-slate-400">{query ? "当前商户的商品、素材和任务" : "输入商品名、任务目标或操作关键词"}</span>
        </div>
        <div id={`${id}-results`} role="listbox" aria-label="首页搜索结果" aria-busy={waiting} className="max-h-[min(480px,60dvh)] overflow-y-auto p-2">
          {waiting ? <div role="status" className="flex items-center justify-center gap-2 px-4 py-9 text-sm text-slate-300"><LoaderCircle className="size-4 animate-spin text-cyan-300" />正在查找…</div> : null}
          {error ? <div role="alert" className="px-4 py-6 text-center text-sm"><p className="text-slate-300">{error}</p><button type="button" onClick={() => { setState({ query, phase: "loading" }); setRetry(index => index + 1); }} className="mt-3 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-1.5 text-cyan-200 hover:bg-cyan-400/20">重新搜索</button></div> : null}
          {!waiting && !error && !groups.length ? <div role="status" className="px-5 py-7 text-center"><Search className="mx-auto mb-3 size-7 text-cyan-400/60" /><p className="text-sm font-medium">没有找到相关记录</p><p className="mt-2 text-xs leading-5 text-slate-400">试试更短的商品名、任务目标，或“海报”“销售”等关键词。</p></div> : null}
          {groups.map(group => <div key={group.kind} role="group" aria-label={group.label}>
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1 text-[11px] text-slate-400"><span>{group.label}</span>{group.hasMore ? <span>还有匹配，试试更具体的关键词</span> : null}</div>
            {group.items.map(item => {
              const index = items.indexOf(item), Icon = icons[item.kind];
              return <Link key={`${item.kind}-${item.id}`} id={`${id}-option-${index}`} href={item.href} prefetch={false} role="option" aria-selected={activeIndex === index}
                onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={closeSearch}
                className={cn("flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 outline-none transition-colors focus-visible:border-cyan-400/50 focus-visible:bg-cyan-400/10", activeIndex === index ? "border-cyan-400/20 bg-cyan-400/10" : "hover:bg-white/5")}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300"><Icon className="size-4" /></span>
                <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-[13px] font-medium"><Highlight text={item.title} query={query} /></span>{item.badge ? <span className="shrink-0 rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-slate-300">{item.badge}</span> : null}</span><span className="mt-0.5 block truncate text-[11px] text-slate-400"><Highlight text={item.description} query={query} /></span></span>
                <ArrowUpRight className="size-3.5 shrink-0 text-slate-500" />
              </Link>;
            })}
          </div>)}
        </div>
        <div className="flex items-center justify-between border-t border-white/8 px-4 py-2 text-[10px] text-slate-400"><span>↑ ↓ 选择 · Enter 打开 · Esc 收起</span><span>操作入口点击后自行确认</span></div>
      </div> : null}
    </div>
  );
}
