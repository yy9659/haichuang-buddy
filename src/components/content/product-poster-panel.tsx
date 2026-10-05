"use client";

import { Download, ImagePlus, Loader2, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { designPosterAction, posterDesignCapabilitiesAction, startPosterBackgroundAction, pollPosterBackgroundAction } from "@/actions/poster-design";
import { createPosterPreviewDesign, POSTER_LAYOUT_LABELS, posterCopyKey, type PosterDesignResult, type PosterDesignRequest } from "@/lib/poster-design";
import type { PosterBackgroundView } from "@/services/poster-design.service";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getPosterIssue, parsePosterPoints, posterFilename, posterPrice,
  POSTER_SIZES, POSTER_TEMPLATES, type PosterCopy, type PosterSize, type PosterTemplate,
} from "@/lib/product-poster";
import { loadPosterPhoto, posterPngBlob, renderProductPoster } from "@/lib/product-poster-renderer";
import type { ContentDraftCopy, ContentSlot, ProductPosterSource } from "@/types";

const FIELD_CLASS = "w-full rounded-lg border border-white/15 bg-card px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus-visible:ring-2 focus-visible:ring-cyan-400/40";

export function ProductPosterPanel({ product, copy, contentId, isDemo, slot, creativeHints = [] }: {
  product?: ProductPosterSource;
  copy: ContentDraftCopy;
  contentId: string;
  isDemo: boolean;
  slot: ContentSlot;
  creativeHints?: string[];
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const photoRef = React.useRef<{ url: string; image: HTMLImageElement } | null>(null);
  const backgroundRef = React.useRef<{ url: string; image: HTMLImageElement } | null>(null);
  const activeRef = React.useRef(true);
  const requestRevision = React.useRef(0);
  const [size, setSize] = React.useState<PosterSize>("portrait");
  const [template, setTemplate] = React.useState<PosterTemplate>("fresh");
  const [manualPalette, setManualPalette] = React.useState(false);
  const [overrides, setOverrides] = React.useState<Partial<Pick<PosterCopy, "title" | "subtitle" | "cta">>>({});
  const [points, setPoints] = React.useState(() =>
    product?.tags.slice(0, 3).join("\n") || product?.specification || "",
  );
  const [reviewedKey, setReviewedKey] = React.useState<string | null>(null);
  const [rendered, setRendered] = React.useState<{ key: string; error: string | null } | null>(null);
  const [retry, setRetry] = React.useState(0);
  const [downloading, setDownloading] = React.useState(false);
  const [notice, setNotice] = React.useState<{ key: string; text: string } | null>(null);
  const [capabilities, setCapabilities] = React.useState<Awaited<ReturnType<typeof posterDesignCapabilitiesAction>> | null>(null);
  const [design, setDesign] = React.useState<PosterDesignResult | null>(null);
  const [designSourceKey, setDesignSourceKey] = React.useState<string | null>(null);
  const [instruction, setInstruction] = React.useState("");
  const [designing, setDesigning] = React.useState(false);
  const [designError, setDesignError] = React.useState<string | null>(null);
  const [backgroundJob, setBackgroundJob] = React.useState<PosterBackgroundView | null>(null);
  const [backgroundUrl, setBackgroundUrl] = React.useState<string | undefined>();
  const [backgroundStarting, setBackgroundStarting] = React.useState(false);
  const [backgroundPolling, setBackgroundPolling] = React.useState(false);
  const [backgroundError, setBackgroundError] = React.useState<string | null>(null);

  const title = overrides.title ?? copy.title;
  const subtitle = overrides.subtitle ?? copy.hook;
  const cta = overrides.cta ?? copy.cta;
  const draft: PosterCopy = { title, subtitle, sellingPoints: parsePosterPoints(points), cta };
  const copyKey = posterCopyKey(draft);
  const hintsText = [...creativeHints, copy.body].join(" ");
  const initialDesign = React.useMemo(() => createPosterPreviewDesign({ title, subtitle, cta, sellingPoints: parsePosterPoints(points) }, hintsText, manualPalette ? template : undefined), [title, subtitle, cta, points, hintsText, manualPalette, template]);
  const effectiveDesign = design?.design ?? initialDesign;
  const sourceKey = JSON.stringify([contentId, product, copy, copyKey, size]);
  const designStale = !!design && designSourceKey !== sourceKey;
  const pollingBackground = backgroundPolling && !designStale;
  const busy = designing || backgroundStarting || pollingBackground || downloading;
  const previewDemo = isDemo || (design?.isMock ?? false);
  const issue = getPosterIssue(product, draft);
  // 确认与渲染均绑定整份快照，修改内容或版式后都需重新核对。
  const renderKey = JSON.stringify([sourceKey, template, previewDemo, effectiveDesign, backgroundUrl]);
  const reviewed = reviewedKey === renderKey;
  const ready = !issue && rendered?.key === renderKey && !rendered.error;
  const renderError = rendered?.key === renderKey ? rendered.error : null;
  const dimensions = POSTER_SIZES[size];
  const backgroundJobId = backgroundJob?.id;

  React.useEffect(() => {
    activeRef.current = true;
    void posterDesignCapabilitiesAction().then((result) => {
      if (activeRef.current) { setCapabilities(result); if (!result.ok) setDesignError(result.error.message); }
    }).catch(() => {
      if (activeRef.current) setDesignError("暂时无法连接 AI，仍可手动制作海报。");
    });
    return () => { activeRef.current = false; requestRevision.current += 1; };
  }, []);
  React.useEffect(() => { requestRevision.current += 1; }, [sourceKey]);

  // 每次查询是短请求；轮询停止后可继续查询同一任务，不重复提交付费生成。
  React.useEffect(() => {
    if (!pollingBackground || !backgroundJobId) return;
    let cancelled = false;
    let timer: number | undefined;
    const deadline = Date.now() + 180_000;
    async function poll(): Promise<void> {
      try {
        const result = await pollPosterBackgroundAction(backgroundJobId!);
        if (cancelled) return;
        if (!result.ok) {
          setBackgroundError(result.error.message);
          setBackgroundPolling(false);
          return;
        }
        if (result.data.status === "completed" && result.data.imageUrl) {
          // 确认图片可读后再应用；失败时保留当前海报。
          const image = await loadPosterPhoto(result.data.imageUrl);
          if (cancelled) return;
          backgroundRef.current = { url: result.data.imageUrl, image };
          setBackgroundUrl(result.data.imageUrl);
          setBackgroundJob(result.data);
          setBackgroundPolling(false);
          return;
        }
        if (Date.now() >= deadline) {
          setBackgroundError("背景还在生成，可以稍后继续查询；当前海报仍可下载。");
          setBackgroundPolling(false);
          return;
        }
        timer = window.setTimeout(() => void poll(), 10_000);
      } catch {
        if (!cancelled) {
          setBackgroundError("背景暂时未能读取，请继续查询；当前海报仍可使用。");
          setBackgroundPolling(false);
        }
      }
    }
    timer = window.setTimeout(() => void poll(), 10_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [pollingBackground, backgroundJobId]);

  function request(): PosterDesignRequest {
    const photo = photoRef.current?.image;
    return { slot, copy: draft, sourceCopy: copy, instruction, previous: design?.design ?? null, size, ...(photo ? { photoAspectRatio: photo.naturalWidth / photo.naturalHeight } : {}) };
  }
  async function redesign(): Promise<void> {
    if (busy || issue) return;
    const revision = ++requestRevision.current;
    const snapshotSourceKey = sourceKey;
    setDesigning(true);
    setDesignError(null);
    try {
      const result = await designPosterAction(request());
      if (!activeRef.current) return;
      if (requestRevision.current !== revision) { setDesignError("文案或商品资料已变化，请用最新资料重新设计。"); return; }
      if (!result.ok) { setDesignError(result.error.message); return; }
      setDesign(result.data);
      setDesignSourceKey(snapshotSourceKey);
      setBackgroundUrl(undefined);
      setBackgroundJob(null);
      setBackgroundPolling(false);
      setBackgroundError(null);
    } catch {
      if (activeRef.current) setDesignError("AI 设计暂时未完成，请重试；原来的海报仍可使用。");
    } finally { if (activeRef.current) setDesigning(false); }
  }
  async function generateBackground(): Promise<void> {
    if (!design || designStale || busy || issue) return;
    const revision = requestRevision.current;
    setBackgroundStarting(true);
    setBackgroundError(null);
    try {
      const result = await startPosterBackgroundAction(request());
      if (!activeRef.current) return;
      if (!result.ok) { setBackgroundError(result.error.message); return; }
      setBackgroundJob(result.data);
      if (revision !== requestRevision.current) {
        setBackgroundPolling(false);
        setBackgroundError("文案已变化，请先确认最新设计，再查看这张背景。");
        return;
      }
      setBackgroundPolling(true);
    } catch {
      if (activeRef.current) setBackgroundError("背景提交未完成，请稍后重试；原来的海报仍可使用。");
    } finally { if (activeRef.current) setBackgroundStarting(false); }
  }

  React.useEffect(() => {
    if (!product?.imageUrl || issue) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      async function prepare(): Promise<void> {
        try {
          await document.fonts.ready;
          const url = product!.imageUrl!;
          const photo = photoRef.current?.url === url
            ? photoRef.current.image
            : await loadPosterPhoto(url);
          if (cancelled) return;
          photoRef.current = { url, image: photo };
          const background = backgroundUrl ? (backgroundRef.current?.url === backgroundUrl ? backgroundRef.current.image : await loadPosterPhoto(backgroundUrl)) : undefined;
          if (cancelled) return;
          if (background && backgroundUrl) backgroundRef.current = { url: backgroundUrl, image: background };
          // 先在离屏画布完成排版，再一次性替换预览，旧图片不会混入新海报。
          const buffer = document.createElement("canvas");
          renderProductPoster(buffer, photo, product!, {
            title, subtitle, sellingPoints: parsePosterPoints(points), cta,
          }, size, previewDemo, template, { design: effectiveDesign, background });
          const canvas = canvasRef.current;
          if (!canvas || cancelled) return;
          canvas.width = buffer.width;
          canvas.height = buffer.height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("当前浏览器无法生成海报，请更换浏览器重试。");
          context.drawImage(buffer, 0, 0);
          setRendered({ key: renderKey, error: null });
        } catch (cause) {
          if (!cancelled) setRendered({ key: renderKey, error: cause instanceof Error ? cause.message : "海报生成失败，请重试。" });
        }
      }
      void prepare();
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [product, title, subtitle, points, cta, size, template, previewDemo, renderKey, issue, retry, effectiveDesign, backgroundUrl]);

  async function download(): Promise<void> {
    if (!ready || !reviewed || designStale || !product || !canvasRef.current || busy) return;
    setDownloading(true);
    setNotice(null);
    const snapshotKey = renderKey;
    try {
      const blob = await posterPngBlob(canvasRef.current);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = posterFilename(product.name, size);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice({ key: snapshotKey, text: "海报已下载，可发到朋友圈或交给店员使用。" });
    } catch {
      setNotice({ key: snapshotKey, text: "海报下载失败，请重试；也可以重新上传商品照片后再制作。" });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section aria-label="商品营销海报" className="min-w-0 overflow-hidden rounded-2xl border border-cyan-300/20 bg-linear-to-br from-[#123651] via-[#0e2944] to-[#0b223b] shadow-xl shadow-slate-950/15">
      <header className="flex items-center justify-between gap-3 border-b border-cyan-200/10 bg-white/3 px-4 py-3">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-100"><span className="flex size-7 items-center justify-center rounded-lg border border-cyan-300/20 bg-cyan-300/10"><ImagePlus className="size-4 text-cyan-300" /></span>商品营销海报</h4>
        <span className="text-[11px] text-slate-400">预览 · PNG 下载</span>
      </header>

      {!product?.imageUrl ? (
        <div className="space-y-3 p-5">
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 px-4 text-center">
            <ImagePlus className="size-7 text-cyan-300" />
            <p className="text-sm font-medium text-slate-100">先给商品上传一张照片</p>
            <p className="text-xs leading-5 text-slate-400">用商品实拍制作海报，图片和价格来自商品档案。</p>
          </div>
          <Button asChild size="sm"><Link href={product ? "/products/" + encodeURIComponent(product.id) : "/products"}>去上传商品照片</Link></Button>
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-slate-400">{design ? design.isMock ? "演示设计" : "AI 设计预览" : "初始排版预览"}</span>
            <div className="flex gap-1 rounded-lg bg-slate-950/30 p-1" role="group" aria-label="海报尺寸">
              {(Object.keys(POSTER_SIZES) as PosterSize[]).map((option) => (
                <button key={option} type="button" aria-pressed={size === option} disabled={busy} onClick={() => setSize(option)}
                  className={cn("rounded-md px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50", size === option ? "bg-cyan-300/15 text-cyan-100" : "text-slate-400 hover:text-slate-200")}>
                  {POSTER_SIZES[option].label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[radial-gradient(ellipse_at_top,rgba(56,189,248,0.14),transparent_70%)] px-3 py-5">
            <div aria-hidden="true" className="pointer-events-none absolute -bottom-10 -right-10 size-40 rounded-full border border-cyan-300/10" />
            <div aria-hidden="true" className="pointer-events-none absolute -left-12 top-8 size-32 rounded-full border border-blue-300/10" />
            <div className="relative mx-auto w-full overflow-hidden rounded-md border border-white/20 bg-slate-950 shadow-2xl shadow-slate-950/50" style={{ maxWidth: size === "portrait" ? 320 : 350, aspectRatio: dimensions.width + " / " + dimensions.height }}>
              <canvas ref={canvasRef} role="img" aria-label={product.name + "营销海报预览，售价" + posterPrice(product.price) + "元每" + product.unit} width={dimensions.width} height={dimensions.height} className={cn("block h-full w-full", !ready && "invisible")} />
              {!ready ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-5 text-center" role={issue || renderError ? "alert" : "status"}>
                  {issue || renderError ? <ImagePlus className="size-7 text-cyan-300" /> : <Loader2 className="size-7 animate-spin text-cyan-300" />}
                  <p className="text-xs leading-6 text-slate-300">{issue ?? renderError ?? "正在排版海报…"}</p>
                  {renderError ? <Button type="button" size="sm" variant="outline" onClick={() => { setRendered(null); setRetry((value) => value + 1); }}><RotateCcw />重新生成</Button> : null}
                </div>
              ) : null}
              {designing && ready ? <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-950/60 text-xs text-white"><Loader2 className="size-4 animate-spin" />AI 正在重新设计…</div> : null}
            </div>
            <p className="mt-3 text-center text-[11px] text-slate-500">{dimensions.width} × {dimensions.height} · {previewDemo ? "演示素材" : "商品原图与档案价格"}</p>
          </div>

          {designStale ? (
            <div role="status" className="rounded-lg border border-cyan-300/15 bg-cyan-300/5 p-3 text-xs leading-5 text-cyan-100">
              <p>文案或尺寸已修改，请重新设计，或沿用当前版式再核对。</p>
              <button type="button" disabled={busy || !!issue} onClick={() => setDesignSourceKey(sourceKey)} className="mt-1 underline underline-offset-4 disabled:opacity-50">沿用当前版式</button>
            </div>
          ) : null}

          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-5 text-slate-300">
              <input type="checkbox" checked={reviewed} disabled={designStale || busy || !ready} onChange={(event) => setReviewedKey(event.target.checked ? renderKey : null)} className="mt-1 accent-cyan-500" />
              <span><ShieldCheck className="mr-1 inline size-3.5 text-cyan-300" />我已核对照片、文案、卖点和价格，确认可以使用。</span>
            </label>
            <Button type="button" size="sm" className="w-full" disabled={designStale || !ready || !reviewed || busy} onClick={() => void download()}>
              {downloading ? <Loader2 className="animate-spin" /> : <Download />}{downloading ? "正在下载…" : "下载营销海报"}
            </Button>
            {notice?.key === renderKey ? <p role="status" className="text-xs leading-5 text-cyan-200">{notice.text}</p> : null}
          </div>

          <div className="space-y-3 border-t border-white/10 pt-4">
            <div className="flex items-center justify-between gap-2">
              <h5 className="flex items-center gap-1.5 text-xs font-semibold text-cyan-100"><Sparkles className="size-4 text-cyan-300" />AI 设计调整</h5>
              <span className="text-[11px] text-slate-500">{design?.providerLabel ?? (capabilities?.ok ? capabilities.data.isMock ? "演示模式" : "已连接" : capabilities ? "暂不可用" : "正在连接…")}</span>
            </div>
            <label htmlFor={"poster-instruction-" + contentId} className="block text-xs text-slate-300">想换什么感觉？</label>
            <textarea id={"poster-instruction-" + contentId} className={FIELD_CLASS} value={instruction} rows={2} maxLength={240} disabled={busy}
              placeholder="例如：暖色美食海报，精致相框，价格醒目，画面更有层次" onChange={(event) => setInstruction(event.target.value)} />
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: "温暖食欲", value: "暖白与陶橙的美食海报，加入柔和相框和圆形装饰，突出家庭晚餐与商品实拍" },
                { label: "精致层次", value: "精致商业海报，有主次分明的大色块、双层相框和装饰线条，标题与价格醒目，画面丰富协调" },
                { label: "商品大图", value: "以商品实拍大图为主视觉，配精致相框、渐变色块和卖点标签，形成鲜明的画面层次" },
                { label: "深海质感", value: "高级深海蓝配明亮青色，海浪装饰线和渐变色块，照片带精致相框，档案价格用醒目价格卡展示" },
              ].map((suggestion) => (
                <button key={suggestion.label} type="button" disabled={busy} onClick={() => setInstruction(suggestion.value)} className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-slate-400 hover:border-cyan-300/25 hover:text-cyan-100 disabled:opacity-50">{suggestion.label}</button>
              ))}
            </div>
            <Button type="button" size="sm" className="w-full" disabled={busy || !!issue || !capabilities?.ok || !capabilities.data.designAvailable} onClick={() => void redesign()}>
              {designing ? <Loader2 className="animate-spin" /> : <Sparkles />}{designing ? "AI 正在设计…" : designStale ? "按最新文案重新设计" : design ? "按要求重新设计" : "根据文案设计海报"}
            </Button>
            {!design ? <p className="text-[11px] leading-5 text-slate-500">上方为初始排版；点击后由 AI 结合文案与创意建议设计。</p> : null}
            {capabilities?.ok && !capabilities.data.designAvailable ? <p className="text-xs leading-5 text-slate-400">AI 设计暂不可用，可在下方调整配色与卖点。</p> : null}
            {designError ? <p role="alert" className="text-xs leading-5 text-amber-200">{designError}</p> : null}

            {design ? (
              <>
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-300">设计思路 · {design.design.name}</summary>
                  <p className="mt-2 leading-5 text-slate-400">{design.design.rationale}</p>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
                    <span>{design.design.composition ? "自定义画面布局" : POSTER_LAYOUT_LABELS[design.design.layout]}</span>
                    {Object.values(design.design.palette).map((color, i) => <span key={i} className="size-3 rounded-full border border-white/15" style={{ backgroundColor: color }} aria-hidden="true" />)}
                  </div>
                </details>
                <details className="rounded-lg border border-white/10 px-3 py-2.5" open={pollingBackground || backgroundStarting || !!backgroundError ? true : undefined}>
                  <summary className="cursor-pointer text-xs text-slate-300">创意背景 · 可选</summary>
                  <div className="mt-3 space-y-2">
                    <p className="text-[11px] leading-5 text-slate-500">增加一张氛围背景，商品实拍与价格继续保留。</p>
                    <Button type="button" size="sm" variant="outline" className="w-full" disabled={designStale || busy || !capabilities?.ok || !capabilities.data.background.available} onClick={() => void generateBackground()}>
                      {backgroundStarting || pollingBackground ? <Loader2 className="animate-spin" /> : <ImagePlus />}{backgroundStarting ? "正在提交…" : pollingBackground ? "创意背景生成中…" : backgroundUrl ? "重新生成创意背景" : "生成 AI 创意背景"}
                    </Button>
                    {capabilities?.ok && !capabilities.data.background.available ? <p className="text-[11px] leading-5 text-slate-500">{capabilities.data.background.reason}</p> : null}
                    {backgroundError ? <p role="alert" className="text-xs leading-5 text-amber-200">{backgroundError}</p> : null}
                    {backgroundJob && !pollingBackground && !backgroundStarting && !backgroundUrl ? <button type="button" className="text-xs text-cyan-200 underline underline-offset-4" disabled={busy || designStale} onClick={() => { setBackgroundError(null); setBackgroundPolling(true); }}>继续查询这张背景</button> : null}
                    {pollingBackground ? <button type="button" className="text-xs text-slate-300 underline underline-offset-4" onClick={() => { setBackgroundPolling(false); setBackgroundError("已停止等待，稍后可继续查询这张背景。"); }}>稍后再看</button> : null}
                    {backgroundUrl ? <button type="button" disabled={busy} className="text-xs text-slate-300 underline underline-offset-4" onClick={() => setBackgroundUrl(undefined)}>使用纯色背景</button> : null}
                  </div>
                </details>
              </>
            ) : null}
          </div>

          <details className="border-t border-white/10 pt-3">
            <summary className="cursor-pointer text-xs text-slate-400">调整卖点、海报文字与配色</summary>
            <fieldset disabled={busy} className="mt-3 space-y-3 disabled:opacity-70">
              <legend className="sr-only">海报文字与配色</legend>
              {Object.keys(overrides).length ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                  <span>部分文字已单独调整。</span>
                  <button type="button" className="text-cyan-200 underline underline-offset-4" onClick={() => setOverrides({})}>同步当前海报文案</button>
                </div>
              ) : null}
              <label className="block space-y-1 text-xs text-slate-300" htmlFor={"poster-title-" + contentId}><span>海报标题</span><input id={"poster-title-" + contentId} className={FIELD_CLASS} value={title} maxLength={60} onChange={(event) => setOverrides((value) => ({ ...value, title: event.target.value }))} /></label>
              <label className="block space-y-1 text-xs text-slate-300" htmlFor={"poster-subtitle-" + contentId}><span>副标题</span><textarea id={"poster-subtitle-" + contentId} className={FIELD_CLASS} value={subtitle} rows={2} maxLength={120} onChange={(event) => setOverrides((value) => ({ ...value, subtitle: event.target.value }))} /></label>
              <label className="block space-y-1 text-xs text-slate-300" htmlFor={"poster-points-" + contentId}><span>已核对的卖点 <span className="text-slate-500">每行一条，最多 3 条，每条 36 字</span></span><textarea id={"poster-points-" + contentId} className={FIELD_CLASS} value={points} rows={3} maxLength={300} onChange={(event) => setPoints(event.target.value)} /></label>
              <label className="block space-y-1 text-xs text-slate-300" htmlFor={"poster-cta-" + contentId}><span>引导语</span><input id={"poster-cta-" + contentId} className={FIELD_CLASS} value={cta} maxLength={80} onChange={(event) => setOverrides((value) => ({ ...value, cta: event.target.value }))} /></label>
              <p className="text-[11px] text-slate-400">档案价格：<strong className="text-cyan-200">¥{posterPrice(product.price)} / {product.unit}</strong>，改价请先修改商品档案。</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="海报配色">
                {(Object.keys(POSTER_TEMPLATES) as PosterTemplate[]).map((option) => (
                  <button key={option} type="button" aria-pressed={!design && manualPalette && template === option}
                    onClick={() => { setTemplate(option); setManualPalette(true); setDesign(null); setDesignSourceKey(null); setDesignError(null); setBackgroundUrl(undefined); setBackgroundJob(null); setBackgroundPolling(false); setBackgroundError(null); }}
                    className={cn("flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px]", !design && manualPalette && template === option ? "border-cyan-300/40 text-cyan-100" : "border-white/10 text-slate-400")}>
                    <span className="size-3 rounded-full border border-white/20" style={{ backgroundColor: POSTER_TEMPLATES[option].swatches[1] }} />{POSTER_TEMPLATES[option].label}
                  </button>
                ))}
              </div>
            </fieldset>
          </details>
          <p className="text-[10px] leading-5 text-slate-500">设计与文字调整请下载留存；修改后需要重新核对。</p>
        </div>
      )}
    </section>
  );
}
