"use client";

import { Check, Clapperboard, Copy, Download, Save, Send, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { confirmContentStatusAction, saveContentDraftAction } from "@/actions/content-editor";
import { Button } from "@/components/ui/button";
import type { ContentDraftCopy, ContentItem, ContentSlot } from "@/types";

/** 生成只是草稿；审核、复制和标记发布都由商家明确触发。 */
export function ContentEditor({ content, onDraftChange }: {
  content: ContentItem;
  onDraftChange?: (copy: ContentDraftCopy) => void;
}) {
  const router = useRouter();
  const [title, setTitle] = React.useState(content.title);
  const [hook, setHook] = React.useState(content.hook);
  const [body, setBody] = React.useState(content.body);
  const [cta, setCta] = React.useState(content.cta);
  const [pending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);
  const [reviewed, setReviewed] = React.useState(false);

  React.useEffect(() => {
    onDraftChange?.({ title, hook, body, cta });
  }, [title, hook, body, cta, onDraftChange]);

  const slot: ContentSlot = {
    productId: content.productId,
    platform: content.platform,
    format: content.format,
  };
  const changed = title.trim() !== content.title.trim() || hook.trim() !== content.hook.trim() ||
    body.trim() !== content.body.trim() || cta.trim() !== content.cta.trim();
  const valid = title.trim() && hook.trim() && body.trim() && cta.trim();
  const canApprove = content.status === "draft" || content.status === "reviewing";
  const isPoster = content.format === "poster-copy";
  const PreviewContainer = isPoster ? "details" : "div";
  const ApprovalContainer = isPoster ? "details" : "div";
  const outlineLabel = ({ "short-video": "拍摄提纲", article: "配图建议", "poster-copy": "创意建议", voiceover: "口播稿" })[content.format];
  const voiceLabel = ({ "short-video": "视频旁白", article: "一句话重点", "poster-copy": "一句话重点", voiceover: "口播稿" })[content.format];
  const isDemoDraft = content.riskNotes?.some((note) => note.includes("【Mock】")) ?? false;
  const reviewNotes = (content.riskNotes ?? []).filter((note) => !note.includes("【Mock】"));
  const caption = [title.trim(), hook.trim(), body.trim(), cta.trim(), content.hashtags.join(" ")]
    .filter(Boolean).join("\n\n");
  const shootingOutline = [
    `${outlineLabel}｜${title.trim()}`,
    ...content.shotList.map((shot, index) => `${index + 1}. ${shot}`),
    "",
    `${voiceLabel}：${content.voiceover}`,
    "",
    `画面建议：${content.visualSuggestions.join("；")}`,
  ].join("\n");
  const fullPack = ["【发布文案】", caption, "", `【${outlineLabel}】`, shootingOutline].join("\n");

  function save(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await saveContentDraftAction(slot, { title, hook, body, cta });
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      setMessage("修改已保存，内容回到待确认状态。");
      router.refresh();
    });
  }

  function confirm(status: "approved" | "published"): void {
    setMessage(null);
    startTransition(async () => {
      const result = await confirmContentStatusAction(slot, status);
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      setMessage(status === "approved" ? "已确认可用。" : "已记录为手动发布；系统没有代你发布到平台。");
      router.refresh();
    });
  }

  async function copy(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`${label}已复制。发布前请核对商品信息。`);
    } catch {
      setMessage("复制失败，请直接选中文字复制。");
    }
  }

  function downloadPack(): void {
    const blob = new Blob([fullPack], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${content.productName.replace(/[\\/:*?"<>|]/g, "-")}-推广素材.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("素材包已下载，请保留需要的版本。");
  }

  return (
    <div className="flex flex-col gap-2">
      {isPoster ? <div className="mb-1 flex items-center justify-between gap-2"><h4 className="text-sm font-semibold text-cyan-100">海报文案</h4><span className="text-[11px] text-slate-400">{changed ? "修改尚未保存" : "文字与海报同步"}</span></div> : null}
      <PreviewContainer className={isPoster ? "mb-2 rounded-lg border border-white/10 px-3 py-2.5" : "mb-2 rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-[#12395d] to-[#10243e] p-4 shadow-lg shadow-black/10"}>
        {isPoster ? <summary className="cursor-pointer text-xs text-slate-400">查看发布文案预览</summary> : null}
        <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold tracking-wide text-cyan-200">发布文案预览</span>
          {changed ? <span className="text-xs text-amber-200">修改尚未保存</span> : null}
        </div>
        <h4 className="mt-3 text-lg font-semibold text-white">{title || "等待填写标题"}</h4>
        <p className="mt-2 text-sm font-medium leading-6 text-cyan-100">{hook || "填写开头一句"}</p>
        <p className="mt-2 line-clamp-5 whitespace-pre-line text-sm leading-6 text-slate-200">{body || "填写正文"}</p>
        <p className="mt-2 text-xs text-cyan-200">{content.hashtags.join(" ")}</p>
        </div>
      </PreviewContainer>
      {!isPoster ? <p className="text-xs font-medium text-muted-foreground">修改文案</p> : null}
      <label htmlFor={`content-title-${content.id}`} className="text-[11px] font-semibold text-muted-foreground">
        {isPoster ? "海报标题" : "标题"}
      </label>
      <input
        id={`content-title-${content.id}`}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        disabled={pending || content.status === "published"}
        maxLength={60}
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-70"
      />
      <label htmlFor={`content-hook-${content.id}`} className="text-[11px] font-semibold text-muted-foreground">
        {isPoster ? "副标题" : "开头一句"}
      </label>
      <textarea
        id={`content-hook-${content.id}`}
        value={hook}
        onChange={(event) => setHook(event.target.value)}
        disabled={pending || content.status === "published"}
        rows={2}
        maxLength={120}
        className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-[12px] leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-70"
      />
      <label htmlFor={`content-body-${content.id}`} className="text-[11px] font-semibold text-muted-foreground">
        {isPoster ? "正文 · 供 AI 理解卖点与场景" : "正文"}
      </label>
      <textarea
        id={`content-body-${content.id}`}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        disabled={pending || content.status === "published"}
        rows={isPoster ? 5 : 8}
        maxLength={5000}
        className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-[12px] leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-70"
      />
      <label htmlFor={`content-cta-${content.id}`} className="text-[11px] font-semibold text-muted-foreground">
        引导行动
      </label>
      <input
        id={`content-cta-${content.id}`}
        value={cta}
        onChange={(event) => setCta(event.target.value)}
        disabled={pending || content.status === "published"}
        maxLength={80}
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-70"
      />
      {reviewNotes.length > 0 ? (
        <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.07] p-3 text-xs leading-5 text-amber-100">
          <p className="font-semibold">发布前留意</p>
          <ul className="mt-1 space-y-1">
            {reviewNotes.map((note) => <li key={note}>· {note}</li>)}
          </ul>
        </div>
      ) : null}
      {isDemoDraft ? <p className="text-xs text-amber-200">这是演示模式的占位草稿，可复制体验，但不能确认可用或标记发布。</p> : null}
      <div className="flex flex-wrap gap-2">
        {content.status !== "published" ? (
          <Button type="button" size="sm" variant="outline" onClick={save} disabled={pending || !changed || !valid}>
            <Save />保存修改
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={() => void copy(caption, "发布文案")} disabled={pending || changed}>
          <Copy />复制发布文案
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy(shootingOutline, outlineLabel)} disabled={pending || changed}>
          <Clapperboard />复制{outlineLabel}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={downloadPack} disabled={pending || changed}>
          <Download />下载整份素材
        </Button>
      </div>
      {canApprove || content.status === "approved" ? (
        <ApprovalContainer className={isPoster ? "mt-2 rounded-lg border border-white/10 px-3 py-2.5" : "space-y-2"}>
          {isPoster ? <summary className="cursor-pointer text-xs text-slate-400">确认文案与记录发布</summary> : null}
          <div className="mt-2 space-y-2">
            {canApprove ? <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-5 text-slate-300"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} className="mt-1 accent-cyan-500" /><span><ShieldCheck className="mr-1 inline size-3.5 text-cyan-300" />我已核对商品名称、价格、产地、保质期和文案承诺。</span></label> : null}
            {canApprove ? <Button type="button" size="sm" onClick={() => confirm("approved")} disabled={pending || changed || !reviewed || isDemoDraft}><Check />确认文案可用</Button> : null}
            {content.status === "approved" ? <Button type="button" size="sm" onClick={() => confirm("published")} disabled={pending || changed}><Send />标记已发布</Button> : null}
          </div>
        </ApprovalContainer>
      ) : null}
      <p className="text-[11px] leading-5 text-muted-foreground">
        发布是手动记录，不会自动发送到抖音或微信；价格、保质期和物流承诺请再次核对。
      </p>
      {message ? <p role="status" className="text-[11px] text-primary">{message}</p> : null}
    </div>
  );
}
