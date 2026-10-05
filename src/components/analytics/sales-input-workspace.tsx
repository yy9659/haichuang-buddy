"use client";

import { useRef, useState, useTransition } from "react";
import { ClipboardPaste, Download, FileSpreadsheet, FolderUp, Loader2, NotebookPen, ShieldCheck, Upload } from "lucide-react";
import { saveSaleRecordsAction } from "@/actions/sales";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SALES_CSV_TEMPLATE, MAX_SALES_CSV_BYTES, type ParsedSaleRow } from "@/lib/sales-csv";
import { SALES_COLUMNS, guessSalesColumns, normalizeSalesTable, parseSalesTableText, prepareSalesTable, type SalesColumnMapping, type SalesTable } from "@/lib/sales-table";
import { yuan } from "@/lib/sales-entry";
import { SaleEntryForm, type SalesCatalogItem } from "./sale-entry-form";

const MAX_EXCEL_BYTES = 5 * 1024 * 1024;
type InputMode = "quick" | "paste" | "file";
interface Sheet { sheet: string; data: SalesTable }
interface ImportSource { sheets: Sheet[]; name: string }
const MODES = [
  { key: "quick", title: "记一笔销售", hint: "少量流水，随卖随记", icon: NotebookPen },
  { key: "paste", title: "粘贴表格", hint: "从 Excel 或账本直接复制", icon: ClipboardPaste },
  { key: "file", title: "导入 Excel", hint: "已有销售表格，整批导入", icon: FolderUp },
] as const;

export function SalesInputWorkspace({ today, catalog, names, channels, existingNos, onSaved }: {
  today: string; catalog?: readonly SalesCatalogItem[]; names: readonly string[]; channels: readonly string[]; existingNos: readonly string[]; onSaved: (message: string) => void;
}) {
  const [mode, setMode] = useState<InputMode>("quick");
  const [paste, setPaste] = useState("");
  const [source, setSource] = useState<ImportSource | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<SalesColumnMapping | null>(null);
  const [defaultChannel, setDefaultChannel] = useState("线下");
  const [preview, setPreview] = useState<ParsedSaleRow[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pending, startTransition] = useTransition();
  const revision = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const table = source?.sheets[sheetIndex]?.data ?? [];
  const busy = reading || checking || pending;
  const duplicates = preview.filter(row => existingNos.includes(row.recordNo)).length;

  function resetPreview() { revision.current += 1; setPreview([]); setError(""); setNotice(""); }
  function loadSource(next: ImportSource, index = 0) {
    resetPreview(); setSource(next); setSheetIndex(index);
    setMapping(guessSalesColumns(next.sheets[index].data[0] ?? []));
  }
  function changeMode(next: InputMode) {
    if (busy || next === mode) return;
    resetPreview(); setSource(null); setMapping(null); setMode(next);
  }
  function readPaste() {
    try {
      const rows = normalizeSalesTable(parseSalesTableText(paste));
      if (rows.length < 2) { setError("请复制表头和销售数据，一起粘贴到这里。"); return; }
      loadSource({ name: "粘贴的销售表格", sheets: [{ sheet: "粘贴内容", data: rows }] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "表格没有识别成功，请检查内容。"); }
  }
  async function selectFile(file?: File) {
    resetPreview(); setSource(null); setMapping(null);
    if (!file) return;
    const version = revision.current;
    setReading(true);
    try {
      const extension = file.name.split(".").at(-1)?.toLowerCase();
      if (extension === "xls") throw new Error("这是旧版 Excel 文件，请在 Excel 中另存为 .xlsx 后再导入。");
      if (!["xlsx", "csv", "tsv", "txt"].includes(extension ?? "")) throw new Error("请选择 Excel（.xlsx）、CSV 或表格文本文件。");
      if (file.size > (extension === "xlsx" ? MAX_EXCEL_BYTES : MAX_SALES_CSV_BYTES)) throw new Error(extension === "xlsx" ? "Excel 文件不能超过 5 MB，请保留销售表格后再导入。" : "表格文件不能超过 256 KB，请分批导入。");
      let sheets: Sheet[];
      if (extension === "xlsx") {
        const { default: readExcelFile } = await import("read-excel-file/browser");
        sheets = (await readExcelFile(file)).map(sheet => ({ sheet: sheet.sheet, data: normalizeSalesTable(sheet.data.map(row => row.map(cell => cell instanceof Date || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" ? cell : null))) }));
      } else {
        const buffer = await file.arrayBuffer();
        let raw: string;
        try { raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
        catch { raw = new TextDecoder("gb18030", { fatal: true }).decode(buffer); }
        sheets = [{ sheet: "销售表格", data: normalizeSalesTable(parseSalesTableText(raw)) }];
      }
      if (version !== revision.current) return;
      const usable = sheets.filter(sheet => sheet.data.length >= 2);
      if (!usable.length) throw new Error("文件里还没有销售数据，请检查工作表。");
      loadSource({ name: file.name, sheets: usable });
    } catch (cause) { if (version === revision.current) setError(cause instanceof Error && /请选择|不能超过|旧版|还没有|请分批/.test(cause.message) ? cause.message : "文件没有读出来，请确认它是未加密的正常表格，或直接复制内容到「粘贴表格」。"); }
    finally { setReading(false); }
  }
  async function check() {
    if (!mapping || busy) return;
    resetPreview(); const version = revision.current; setChecking(true);
    try {
      const result = await prepareSalesTable(table, mapping, defaultChannel);
      if (version !== revision.current) return;
      if (!result.ok) setError(result.errors.join("；"));
      else setPreview(result.rows);
    } catch { setError("核对没有完成，请重新检查表格。当前内容还没有保存。"); }
    finally { setChecking(false); }
  }
  function save() {
    if (!preview.length || busy) return;
    const rows = preview;
    startTransition(async () => {
      try {
        const result = await saveSaleRecordsAction(rows);
        if (!result.ok) { setError(result.error.message); return; }
        const message = `已保存 ${result.data.inserted} 条销售记录${result.data.skipped ? `，跳过 ${result.data.skipped} 条重复编号` : ""}。销售分析已更新。`;
        resetPreview(); setSource(null); setMapping(null); setPaste(""); setNotice(message); onSaved(message);
      } catch { setError("保存没有完成，请重试。同编号的记录会自动跳过，不会重复记账。"); }
    });
  }

  return <div id="sales-import" className="scroll-mt-24 overflow-hidden rounded-2xl border border-white/10 bg-muted/40 text-card-foreground">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-4 sm:px-5"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-white"><NotebookPen className="size-4 text-cyan-300" />把今天卖出的记下来</h3><p className="mt-1 text-xs text-slate-400">随手记一笔，或把现成的销售表格带进来</p></div><span className="flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary-soft px-3 py-1 text-[11px] text-cyan-200"><ShieldCheck className="size-3.5" />保存后自动更新销售分析</span></header>
    <div className="space-y-4 p-4 sm:p-5">
      <div role="group" aria-label="销售录入方式" className="grid gap-2 sm:grid-cols-3">{MODES.map(item => <button key={item.key} type="button" aria-pressed={mode === item.key} disabled={busy} onClick={() => changeMode(item.key)} className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-50 ${mode === item.key ? "border-primary/40 bg-primary-soft shadow-sm shadow-black/10" : "border-border bg-muted/40 hover:bg-muted/70"}`}><span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${mode === item.key ? "bg-primary-soft text-primary" : "bg-white/5 text-slate-400"}`}><item.icon className="size-4" /></span><span><span className="block text-xs font-semibold text-slate-100">{item.title}</span><span className="mt-0.5 block text-[11px] text-slate-400">{item.hint}</span></span></button>)}</div>
      {mode === "quick" ? <div role="region" aria-label="记一笔销售"><SaleEntryForm today={today} catalog={catalog} names={names} channels={channels} onSaved={onSaved} /></div> : <div role="region" aria-label={mode === "paste" ? "粘贴表格" : "导入表格"} className="space-y-4">
        {mode === "paste" ? <div><label htmlFor="sales-paste" className="mb-2 block text-xs font-medium text-slate-200">复制表头和销售记录，粘贴到这里</label><Textarea id="sales-paste" rows={4} maxLength={MAX_SALES_CSV_BYTES} disabled={busy} placeholder={"日期\t商品\t数量\t实收\t渠道\t成本\n2026-10-03\t鱼丸\t2\t96\t微信\t58"} value={paste} onChange={event => { setPaste(event.target.value); resetPreview(); setSource(null); setMapping(null); }} /><div className="mt-2 flex justify-end"><Button size="sm" variant="outline" disabled={busy || !paste.trim()} onClick={readPaste}><ClipboardPaste />识别表格</Button></div></div> : <div onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) void selectFile(event.dataTransfer.files[0]); }} className="rounded-xl border border-dashed border-primary/30 bg-muted/40 p-5 text-center"><FileSpreadsheet className="mx-auto size-7 text-cyan-300" /><p className="mt-2 text-sm font-medium text-slate-100">把销售表格拖到这里，或选择文件</p><p className="mt-1 text-xs text-slate-400">支持 Excel .xlsx、CSV；不必先改成固定模板</p><input ref={fileInput} type="file" accept=".xlsx,.csv,.tsv,.txt,.xls" aria-label="选择销售表格文件" className="sr-only" disabled={busy} onChange={event => { void selectFile(event.target.files?.[0]); event.target.value = ""; }} /><div className="mt-3 flex flex-wrap justify-center gap-2"><Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>{reading ? <Loader2 className="animate-spin" /> : <FolderUp />}{reading ? "正在读取表格…" : "选择文件"}</Button><a href={`data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${SALES_CSV_TEMPLATE}`)}`} download="海创Buddy-销售记录模板.csv" className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3 text-xs text-slate-200 hover:bg-white/10"><Download className="size-3.5" />参考表格格式</a></div></div>}
        {source && mapping ? <div className="space-y-4 rounded-xl border border-border bg-muted/40 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-xs font-semibold text-cyan-100">先核对这些列</h4><p className="mt-1 break-all text-[11px] text-slate-400">{source.name} · {Math.max(0, table.length - 1)} 条待检查</p></div>{source.sheets.length > 1 ? <Select aria-label="选择工作表" value={sheetIndex} disabled={busy} onChange={event => loadSource(source, Number(event.target.value))}>{source.sheets.map((sheet, index) => <option key={index} value={index}>{sheet.sheet}</option>)}</Select> : null}</div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{SALES_COLUMNS.map(column => <div key={column.key}><label htmlFor={`sales-column-${column.key}`} className="mb-1.5 block text-[11px] text-slate-300">{column.label}{column.required ? <span className="ml-1 text-cyan-300">*</span> : "（选填）"}</label><Select id={`sales-column-${column.key}`} value={mapping[column.key]} disabled={busy} onChange={event => { resetPreview(); setMapping(prev => prev && ({ ...prev, [column.key]: Number(event.target.value) })); }}><option value={-1}>{column.required ? "请选择对应列" : column.key === "recordNo" ? "自动生成编号" : column.key === "channel" ? "使用统一渠道" : "暂不填写成本"}</option>{table[0]?.map((cell, index) => <option key={index} value={index}>{String(cell ?? "").trim() || `第 ${index + 1} 列`}</option>)}</Select></div>)}</div>{mapping.channel < 0 ? <div className="max-w-xs"><label htmlFor="sales-default-channel" className="mb-1.5 block text-xs text-slate-300">这批销售来自哪个渠道？</label><Select id="sales-default-channel" disabled={busy} value={defaultChannel} onChange={event => { resetPreview(); setDefaultChannel(event.target.value); }}>{[...new Set(["线下", "微信", "抖音", "小红书", "视频号", ...channels])].map(channel => <option key={channel}>{channel}</option>)}</Select></div> : null}{mapping.recordNo < 0 ? <p className="text-[11px] leading-5 text-slate-400">未提供编号时会自动生成；内容完全相同的记录重复导入会跳过。同一天多笔相同销售建议保留各自的原始编号。</p> : null}<div className="flex justify-end"><Button size="sm" variant="outline" disabled={busy} onClick={() => { void check(); }}>{checking ? <Loader2 className="animate-spin" /> : <ShieldCheck />}{checking ? "正在核对…" : "核对并预览"}</Button></div></div> : null}
        {preview.length > 0 ? <div className="overflow-hidden rounded-xl border border-border bg-card"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 p-3"><p className="text-xs font-medium text-cyan-100">{preview.length} 条已核对 · 待新增 {preview.length - duplicates} 条{duplicates ? ` · 已有 ${duplicates} 条会跳过` : ""}</p><span className="text-xs text-slate-300">本批总实收 ¥{yuan(preview.reduce((sum, row) => sum + row.revenueCents, 0))}</span></div><div className="max-h-56 overflow-auto"><table className="w-full min-w-[580px] text-left text-xs"><thead className="sticky top-0 bg-popover text-slate-300"><tr>{["日期", "商品", "渠道", "数量", "实收", "成本", "状态"].map(label => <th key={label} className="p-2.5">{label}</th>)}</tr></thead><tbody>{preview.slice(0, 20).map(row => <tr key={row.recordNo} className="border-t border-white/10 text-slate-200"><td className="p-2.5">{row.saleDate}</td><td className="p-2.5">{row.productName}</td><td className="p-2.5">{row.channel}</td><td className="p-2.5">{row.quantity}</td><td className="p-2.5">¥{yuan(row.revenueCents)}</td><td className="p-2.5">{row.costCents === null ? "未填" : `¥${yuan(row.costCents)}`}</td><td className={`p-2.5 ${existingNos.includes(row.recordNo) ? "text-amber-200" : "text-cyan-200"}`}>{existingNos.includes(row.recordNo) ? "已有记录" : "待保存"}</td></tr>)}</tbody></table></div><div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 p-3"><span className="text-[11px] text-slate-400">{preview.length > 20 ? "预览展示前 20 条，确认后保存全部已核对记录。" : "确认商品、数量与实收后，再保存到账本。"}</span><Button size="sm" disabled={busy || duplicates === preview.length} onClick={save}>{pending ? <Loader2 className="animate-spin" /> : <Upload />}{pending ? "正在保存…" : `确认保存 ${preview.length - duplicates} 条`}</Button></div></div> : null}
      </div>}
      {error ? <p role="alert" className="rounded-lg border border-rose-300/20 bg-rose-300/10 p-3 text-xs leading-5 text-rose-200">{error}</p> : null}
      {notice ? <p role="status" className="text-xs text-cyan-200">{notice}</p> : null}
    </div>
  </div>;
}
