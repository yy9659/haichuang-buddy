"use client";

import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, X } from "lucide-react";
import * as React from "react";

import {
  approveBrandDraftAction,
  saveBrandDraftAction,
  saveBusinessSettingsAction,
  saveOwnerSettingsAction,
} from "@/actions/brand-editor";
import { SectionCard } from "@/components/common/section-card";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Result } from "@/lib/result";
import type { BrandProfile, BusinessProfile, OwnerTwin } from "@/types";

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

function list(form: FormData, name: string): string[] {
  return [...new Set(form.getAll(name).map((value) => String(value).trim()).filter(Boolean))];
}

function ChoiceListField({ name, label, values, options = [], hint }: {
  name: string; label: string; values: string[]; options?: string[]; hint?: string;
}) {
  const [selected, setSelected] = React.useState(values);
  const [custom, setCustom] = React.useState("");
  const atLimit = selected.length >= 15;

  function add(value: string): void {
    const item = value.trim();
    if (item && item.length <= 120 && !selected.includes(item) && !atLimit) {
      setSelected((current) => [...current, item]);
    }
    setCustom("");
  }

  function toggle(value: string): void {
    setSelected((current) => current.includes(value)
      ? current.filter((item) => item !== value)
      : current.length < 15 ? [...current, value] : current);
  }

  return <div className="flex flex-col gap-2 sm:col-span-2">
    <span className="text-[12px] font-medium">{label}</span>
    {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    {options.length > 0 ? <div className="flex flex-wrap gap-1.5" aria-label={`${label}常用选项`}>
      {options.map((option) => {
        const active = selected.includes(option);
        return <button key={option} type="button" aria-pressed={active} disabled={!active && atLimit}
          onClick={() => toggle(option)}
          className={active
            ? "rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-[12px] text-primary transition-colors"
            : "rounded-full border border-border bg-card px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground disabled:opacity-50"}>
          {active ? "✓ " : "+ "}{option}
        </button>;
      })}
    </div> : null}
    {selected.filter((item) => !options.includes(item)).length > 0 ? <div className="flex flex-wrap gap-1.5" aria-label={`${label}自定义选项`}>
      {selected.filter((item) => !options.includes(item)).map((item) => <button key={item} type="button"
        onClick={() => toggle(item)} aria-label={`移除${item}`}
        className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-[12px] text-primary">
        {item}<X className="size-3" />
      </button>)}
    </div> : null}
    <div className="flex gap-2">
      <Input value={custom} maxLength={120} placeholder="写自己的说法，按回车添加"
        aria-label={`自定义${label}`} onChange={(event) => setCustom(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(custom); } }} />
      <Button type="button" size="sm" variant="outline" disabled={!custom.trim() || atLimit}
        onClick={() => add(custom)}><Plus />添加</Button>
    </div>
    {selected.map((item) => <input key={item} type="hidden" name={name} value={item} />)}
    {atLimit ? <span className="text-[11px] text-muted-foreground">最多选择 15 项</span> : null}
  </div>;
}

function TextField({ name, label, value, maxLength, wide = false }: {
  name: string; label: string; value: string; maxLength: number; wide?: boolean;
}) {
  return <label className={wide ? "flex flex-col gap-1 sm:col-span-2" : "flex flex-col gap-1"}>
    <span className="text-[12px] font-medium">{label}</span>
    <Input name={name} defaultValue={value} maxLength={maxLength} />
  </label>;
}

function LongField({ name, label, value, maxLength, hint }: {
  name: string; label: string; value: string; maxLength: number; hint?: string;
}) {
  return <label className="flex flex-col gap-1 sm:col-span-2">
    <span className="text-[12px] font-medium">{label}</span>
    {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    <Textarea name={name} defaultValue={value} maxLength={maxLength} rows={4} />
  </label>;
}

function EditorDialog({ title, description, trigger, children, onSave }: {
  title: string;
  description: string;
  trigger: string;
  children: React.ReactNode;
  onSave: (form: FormData) => Promise<Result<unknown>>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await onSave(data);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <Button type="button" size="sm" variant="outline"><Pencil />{trigger}</Button>
    </DialogTrigger>
    <DialogContent className="max-w-2xl">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <DialogBody>
          <div className="grid gap-3 sm:grid-cols-2">{children}</div>
          {error ? <p role="alert" className="mt-3 text-[12px] text-destructive">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>取消</Button>
          <Button type="submit" disabled={pending}>{pending ? "保存中…" : "保存"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function BusinessSettingsCard({ business }: { business: BusinessProfile | null }) {
  if (!business) return null;
  return <SectionCard title="商家资料" description="品牌生成会读取这里的信息" action={<EditorDialog
    title="编辑商家资料" description="请填写可核实的店铺事实；修改后原品牌确认状态会撤销。" trigger="编辑"
    onSave={(form) => saveBusinessSettingsAction({
      name: field(form, "name"), shortName: field(form, "shortName"),
      description: field(form, "description"), owner: field(form, "owner"),
      location: field(form, "location"), mainCategory: field(form, "mainCategory"),
      channels: list(form, "channels"),
    })}
  >
    <TextField name="name" label="商家名称" value={business.name} maxLength={60} wide />
    <TextField name="shortName" label="展示简称" value={business.shortName} maxLength={30} />
    <TextField name="owner" label="商家负责人" value={business.owner} maxLength={30} />
    <TextField name="location" label="所在地" value={business.location} maxLength={80} />
    <TextField name="mainCategory" label="主营品类" value={business.mainCategory} maxLength={40} />
    <LongField name="description" label="商家自述" value={business.description ?? ""} maxLength={500} hint="写真实经营方式、优势或经历，不要编造资质。" />
    <ChoiceListField name="channels" label="经营渠道" values={business.channels}
      options={["线下门店", "抖音", "视频号", "小红书", "微信社群", "淘宝", "拼多多"]}
      hint="可点选常用渠道，也可以添加自己的渠道。" />
  </EditorDialog>}>
    <p className="text-[14px] font-medium">{business.name}</p>
    <p className="mt-1 text-[12px] text-muted-foreground">{[business.location, business.mainCategory].filter(Boolean).join(" · ") || "尚未完善所在地与主营品类"}</p>
    {business.description ? <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{business.description}</p> : null}
  </SectionCard>;
}

export function OwnerSettingsCard({ owner }: { owner: OwnerTwin | null }) {
  return <SectionCard title="表达偏好" description="决定品牌内容的说话方式与禁用表达" action={<EditorDialog
    title="编辑表达偏好" description="可按实际经营者修改，不必沿用演示人物设定；修改后品牌需重新确认。" trigger="编辑"
    onSave={(form) => saveOwnerSettingsAction({
      displayName: field(form, "displayName"), businessPhilosophy: list(form, "businessPhilosophy"),
      tone: list(form, "tone"), salesStyle: field(form, "salesStyle"),
      targetCustomers: list(form, "targetCustomers"), forbiddenExpressions: list(form, "forbiddenExpressions"),
    })}
  >
    <TextField name="displayName" label="内容表达者称呼" value={owner?.displayName ?? ""} maxLength={30} wide />
    <ChoiceListField name="businessPhilosophy" label="经营理念" values={owner?.businessPhilosophy ?? []}
      options={["真实介绍", "重视品质", "尊重顾客选择", "认真服务"]} />
    <ChoiceListField name="tone" label="表达语气" values={owner?.tone ?? []}
      options={["亲切", "朴实", "专业", "轻松", "克制", "有活力"]} />
    <LongField name="salesStyle" label="销售风格" value={owner?.salesStyle ?? ""} maxLength={160} />
    <ChoiceListField name="targetCustomers" label="目标顾客" values={owner?.targetCustomers ?? []}
      options={["家庭用户", "年轻消费者", "礼品采购", "本地居民", "企业客户"]} />
    <ChoiceListField name="forbiddenExpressions" label="禁用表达" values={owner?.forbiddenExpressions ?? []}
      hint="输入不希望内容中出现的词句，添加后可随时删除。" />
  </EditorDialog>}>
    <p className="text-[14px] font-medium">{owner?.displayName || "尚未设置"}</p>
    <p className="mt-1 text-[12px] text-muted-foreground">{owner?.tone.join(" · ") || "设置语气后，品牌生成会参考它。"}</p>
    {owner?.forbiddenExpressions.length ? <p className="mt-2 text-[12px] text-muted-foreground">避用：{owner.forbiddenExpressions.join("、")}</p> : null}
  </SectionCard>;
}

export function BrandDraftControls({ brand }: { brand: BrandProfile | null }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [message, setMessage] = React.useState<string | null>(null);

  function approve(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await approveBrandDraftAction();
      setMessage(result.ok ? "品牌档案已确认。" : result.error.message);
      router.refresh();
    });
  }

  return <div className="flex flex-wrap items-center gap-2">
    <EditorDialog title={brand ? "修改品牌档案" : "手动建立品牌档案"}
      description="可以自由输入，也可以选择常用表达。保存后为待确认草稿。"
      trigger={brand ? "编辑品牌档案" : "手动建立品牌"}
      onSave={(form) => saveBrandDraftAction({
        factsConfirmed: form.get("factsConfirmed") === "on",
        positioning: field(form, "positioning"), brandStory: field(form, "brandStory"),
        slogan: field(form, "slogan"), ipConcept: field(form, "ipConcept"),
        targetAudience: list(form, "targetAudience"), brandValues: list(form, "brandValues"),
        brandPersonality: list(form, "brandPersonality"), toneOfVoice: list(form, "toneOfVoice"),
        visualKeywords: list(form, "visualKeywords"),
      })}
    >
      <LongField name="positioning" label="品牌定位" value={brand?.positioning ?? ""} maxLength={200} hint="服务谁、提供什么价值、依据是什么。" />
      <LongField name="brandStory" label="品牌故事" value={brand?.brandStory ?? ""} maxLength={1500} hint="只写真实经历与可核实细节。" />
      <TextField name="slogan" label="品牌主张" value={brand?.slogan ?? ""} maxLength={80} />
      <LongField name="ipConcept" label="内容人物 / IP 方向" value={brand?.ipConcept ?? ""} maxLength={500} />
      <ChoiceListField name="targetAudience" label="目标人群" values={brand?.targetAudience ?? []}
        options={["家庭用户", "年轻消费者", "本地居民", "礼品采购", "企业客户"]} />
      <ChoiceListField name="brandValues" label="品牌价值" values={brand?.brandValues ?? []}
        options={["真实", "可靠", "用心", "品质", "便利", "在地特色"]} />
      <ChoiceListField name="brandPersonality" label="品牌性格" values={brand?.brandPersonality ?? []}
        options={["亲切", "务实", "专业", "温暖", "年轻", "稳重"]} />
      <ChoiceListField name="toneOfVoice" label="内容语气" values={brand?.toneOfVoice ?? []}
        options={["像朋友一样", "简洁直接", "专业清楚", "有生活感", "温暖克制"]} />
      <ChoiceListField name="visualKeywords" label="视觉关键词" values={brand?.visualKeywords ?? []}
        options={["自然光", "真实场景", "简洁留白", "明亮色彩", "手作质感"]} />
      <label className="flex items-start gap-2 text-[12px] leading-5 sm:col-span-2">
        <input type="checkbox" name="factsConfirmed" required className="mt-1 accent-primary" />
        我已核对以上品牌内容的事实与承诺，并愿意将它保存为人工草稿。
      </label>
    </EditorDialog>
    {brand && !brand.approved ? <Button type="button" size="sm" onClick={approve} disabled={pending}>
      <Check />{pending ? "确认中…" : "核实并确认"}
    </Button> : null}
    {brand && !brand.approved ? <span className="text-[11px] text-muted-foreground">确认前请核对品牌故事、商品事实与禁用表达。</span> : null}
    {message ? <span role="status" className="text-[12px] text-muted-foreground">{message}</span> : null}
  </div>;
}
