"use client";

/**
 * 企业知识库管理（客户端组件 · 任务书第二十七 ~ 三十一节）
 *
 * 四类操作全部**经 Knowledge Service**，页面自己绝不碰 chunk / embedding / repository：
 *
 * | 操作 | 走的方法 | 为什么不能绕过 |
 * |---|---|---|
 * | 新增 | `createKnowledgeDocument` | 切片 + 向量化 + 原子写入，任一步失败都不能留下半套状态 |
 * | 编辑 | `updateKnowledgeDocument` | 「先建好新索引、再替换旧的」，正文与向量永远一致 |
 * | 重新索引 | `reindexKnowledgeDocument` | 切片规则升级后重建旧向量，不新建文档 |
 * | 删除 | `deleteKnowledgeDocument` | 切片随文档级联清理 |
 *
 * 界面上刻意不出现「分块」「向量」「embedding」这些词：商家要表达的是
 * 「这条知识说了什么」，切片是系统的内部实现。
 * 唯一例外是**索引状态**——它必须显示，因为「文档写进去了」与
 * 「它真的能被检索到」是两件事，而后者才是消费者能不能得到回答的关键。
 *
 * 删除带确认弹窗：它会连带删掉全部切片，而商家看到的界面只是一个列表项。
 */

import { useRouter } from "next/navigation";
import {
  Database,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import * as React from "react";

import {
  createKnowledgeDocumentAction,
  deleteKnowledgeDocumentAction,
  indexPendingKnowledgeDocumentsAction,
  reindexKnowledgeDocumentAction,
  updateKnowledgeDocumentAction,
} from "@/actions/customer-service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { AppErrorShape } from "@/lib/result";
import {
  KNOWLEDGE_INDEX_STATUS_META,
  KNOWLEDGE_SOURCE_LABEL,
  KNOWLEDGE_TYPE_LABEL,
} from "@/lib/status-meta";
import {
  KNOWLEDGE_DOCUMENT_TYPES,
  type KnowledgeDocument,
  type KnowledgeDocumentType,
} from "@/types";

interface KnowledgeLibraryProps {
  documents: KnowledgeDocument[];
  productOptions: Array<{ id: string; name: string }>;
}

/** 新建 / 编辑共用的表单状态 */
interface DocumentFormState {
  name: string;
  type: KnowledgeDocumentType;
  productId: string;
  content: string;
}

const EMPTY_FORM: DocumentFormState = {
  name: "",
  type: "faq",
  productId: "",
  content: "",
};

export function KnowledgeLibrary({ documents, productOptions }: KnowledgeLibraryProps) {
  const router = useRouter();

  /** 打开中的编辑目标；`"new"` 表示新建，null 表示关闭 */
  const [editing, setEditing] = React.useState<KnowledgeDocument | "new" | null>(null);
  const [form, setForm] = React.useState<DocumentFormState>(EMPTY_FORM);
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<AppErrorShape | null>(null);
  const [deleting, setDeleting] = React.useState<KnowledgeDocument | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  /** 正在重新索引的文档 id —— 与整体 pending 分开，避免所有按钮一起转圈 */
  const [reindexing, setReindexing] = React.useState<string | null>(null);

  const dialogOpen = editing !== null;
  /** 还没被索引的文档：它们**检索不到**，必须显式提示而不是混在列表里 */
  const notIndexed = documents.filter((document) => document.indexStatus !== "indexed");

  function openCreate(): void {
    setForm(EMPTY_FORM);
    setError(null);
    setEditing("new");
  }

  function openEdit(document: KnowledgeDocument): void {
    setForm({
      name: document.name,
      type: document.type,
      productId: document.productId ?? "",
      content: document.content,
    });
    setError(null);
    setEditing(document);
  }

  function closeDialog(): void {
    setEditing(null);
    setError(null);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!editing) {
      return;
    }

    const name = form.name.trim();
    const content = form.content.trim();
    if (name.length === 0) {
      setError({ code: "VALIDATION_FAILED", message: "请填写知识名称", retryable: false });
      return;
    }
    if (content.length === 0) {
      setError({ code: "VALIDATION_FAILED", message: "请填写知识正文", retryable: false });
      return;
    }

    const target = editing;
    setError(null);

    startTransition(async () => {
      const payload = {
        name,
        type: form.type,
        content,
        productId: form.productId || null,
      };

      const result =
        target === "new"
          ? await createKnowledgeDocumentAction(payload)
          : await updateKnowledgeDocumentAction(target.id, payload);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      closeDialog();
      setNotice(
        target === "new"
          ? "知识已建立并完成索引，后续回答将优先检索该内容。"
          : "知识已更新，新的索引已生效。",
      );
      router.refresh();
    });
  }

  function handleReindex(document: KnowledgeDocument): void {
    setError(null);
    setNotice(null);
    setReindexing(document.id);
    startTransition(async () => {
      const result = await reindexKnowledgeDocumentAction(document.id);
      setReindexing(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`《${document.name}》已重新建立索引。`);
      router.refresh();
    });
  }

  function handleDelete(): void {
    const target = deleting;
    if (!target) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await deleteKnowledgeDocumentAction(target.id);
      setDeleting(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`《${target.name}》已删除，其切片已一并清理。`);
      router.refresh();
    });
  }

  /** 把尚未索引的知识一次性建好索引（种子知识第一次进演示环境时需要这一步） */
  function handleIndexPending(): void {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await indexPendingKnowledgeDocumentsAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { indexed, failures } = result.data;
      if (failures.length > 0) {
        setNotice(
          `已完成 ${indexed} 份知识的索引；${failures.length} 份失败：${failures
            .map((item) => `《${item.name}》（${item.message}）`)
            .join("、")}。失败的可以再试一次。`,
        );
      } else {
        setNotice(`已完成 ${indexed} 份知识的索引，现在可以被客服检索到了。`);
      }
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card p-3.5 shadow-card">
      <div className="flex items-center gap-2">
        <Database className="size-3.5 text-primary" />
        <span className="text-[12px] font-semibold">企业知识库</span>
        <Badge variant="secondary" className="ml-auto">
          {documents.length} 份
        </Badge>
        <Button type="button" size="icon-sm" variant="soft" onClick={openCreate} title="新增知识">
          <Plus />
        </Button>
      </div>

      {notIndexed.length > 0 ? (
        <div className="mt-2.5 flex flex-col gap-1.5 rounded-lg border border-warning/25 bg-warning/12 px-2.5 py-2">
          <p className="text-[11px] leading-4 text-warning">
            {notIndexed.length} 份知识尚未完成索引 ——
            <span className="font-medium">它们现在检索不到</span>，AI 无法引用。
            建立索引后立即可被客服使用。
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            disabled={isPending}
            onClick={handleIndexPending}
          >
            {isPending && reindexing === null ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            建立索引（{notIndexed.length} 份）
          </Button>
        </div>
      ) : null}

      {notice ? (
        <p className="mt-2 rounded-lg border border-success/20 bg-success/10 px-2.5 py-1.5 text-[11px] leading-4 text-success">
          {notice}
        </p>
      ) : null}
      {error && !dialogOpen && !deleting ? (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-destructive/20 bg-destructive/8 px-2.5 py-1.5 text-[11px] leading-4 text-destructive"
        >
          {error.message}
        </p>
      ) : null}

      {documents.length === 0 ? (
        <p className="mt-2.5 text-[11px] leading-4 text-muted-foreground">
          知识库还是空的。新增一份知识文档后，系统会自动切片并建立索引。
        </p>
      ) : (
        <ul className="mt-2.5 flex flex-col gap-1.5">
          {documents.map((document) => {
            const indexMeta = KNOWLEDGE_INDEX_STATUS_META[document.indexStatus];
            const busy = isPending && reindexing === document.id;
            return (
              <li
                key={document.id}
                className="flex flex-col gap-1.5 rounded-lg bg-muted/60 px-2.5 py-2"
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {document.name}
                  </span>
                  <Badge
                    variant={indexMeta.tone}
                    className="shrink-0 px-1.5 py-0 text-[10px]"
                  >
                    {busy ? "重建中…" : indexMeta.label}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant="soft" className="px-1.5 py-0 text-[10px]">
                    {KNOWLEDGE_TYPE_LABEL[document.type]}
                  </Badge>
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                    {KNOWLEDGE_SOURCE_LABEL[document.source]}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {document.chunkCount > 0
                      ? `${document.chunkCount} 个分块`
                      : "尚未分块"}
                  </span>
                  {document.productId ? (
                    <span className="text-[10px] text-muted-foreground">
                      商品级
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">全店级</span>
                  )}
                </div>

                {document.indexStatus === "failed" && document.indexError ? (
                  <span className="text-[10px] leading-4 text-destructive">
                    {document.indexError}
                  </span>
                ) : null}

                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">
                    更新于 {document.updatedAt}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      title="编辑正文（会同步重建索引）"
                      disabled={isPending}
                      onClick={() => openEdit(document)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      title="重新索引（不修改正文）"
                      disabled={isPending}
                      onClick={() => handleReindex(document)}
                    >
                      {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      title="删除知识（切片一并清理）"
                      disabled={isPending}
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        setDeleting(document);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------------- 新增 / 编辑对话框 ---------------- */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next) {
            closeDialog();
          }
        }}
      >
        <DialogContent>
          <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
            <DialogHeader>
              <DialogTitle>
                {editing === "new" ? "新增知识" : "编辑知识"}
              </DialogTitle>
              <DialogDescription>
                提交后系统会自动切片并建立索引，立即可被客服检索到。
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="flex min-h-0 flex-col gap-3 overflow-y-auto">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="kb-name">知识名称</Label>
                <Input
                  id="kb-name"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="例如：连江海创物流说明"
                  maxLength={64}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-type">知识类型</Label>
                  <Select
                    id="kb-type"
                    value={form.type}
                    onChange={(event) =>
                      setForm({ ...form, type: event.target.value as KnowledgeDocumentType })
                    }
                  >
                    {KNOWLEDGE_DOCUMENT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {KNOWLEDGE_TYPE_LABEL[type]}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-product">关联商品（可选）</Label>
                  <Select
                    id="kb-product"
                    value={form.productId}
                    onChange={(event) => setForm({ ...form, productId: event.target.value })}
                  >
                    <option value="">全店级（物流 / 售后等政策）</option>
                    {productOptions.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="kb-content">知识正文</Label>
                <Textarea
                  id="kb-content"
                  value={form.content}
                  onChange={(event) => setForm({ ...form, content: event.target.value })}
                  rows={7}
                  className="min-h-[140px]"
                  placeholder="把商家对外承诺的内容写清楚：温度、时效、范围、赔付标准…"
                />
                <p className="text-[10px] leading-4 text-muted-foreground">
                  AI 只会依据这里写下的内容回答，不会自行发挥。写得越具体，回答越可靠。
                </p>
              </div>

              {error ? (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/20 bg-destructive/8 px-2.5 py-2 text-[11px] leading-4 text-destructive"
                >
                  {error.message}
                  {error.detail ? `（${error.detail}）` : ""}
                </p>
              ) : null}
            </DialogBody>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeDialog} disabled={isPending}>
                取消
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? <Loader2 className="animate-spin" /> : <Plus />}
                {editing === "new" ? "建立知识" : "保存并重建索引"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------------- 删除确认 ---------------- */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) {
            setDeleting(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除知识</DialogTitle>
            <DialogDescription>
              将删除《{deleting?.name}》及其全部切片。
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-[12px] leading-5 text-muted-foreground">
              删除后 AI 立即不再引用这份材料。
              <span className="mt-1.5 block">
                若它曾经解决过某条知识缺口，那条缺口不会被自动重新打开 ——
                缺口状态只在客服再次遇到该问题、或人工显式操作时改变。
              </span>
            </p>
            {error ? (
              <p role="alert" className="mt-2 text-[11px] leading-4 text-destructive">
                {error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleting(null)}
              disabled={isPending}
            >
              取消
            </Button>
            <Button type="button" variant="danger" onClick={handleDelete} disabled={isPending}>
              {isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
