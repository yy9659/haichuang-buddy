"use client";

/**
 * 删除商品确认对话框
 *
 * 删除是不可逆操作（数据库记录 + 级联的 Product DNA + 对象存储中的图片），
 * 因此这里强制二次确认，并把「会一起删掉什么」写清楚。
 */

import { useRouter } from "next/navigation";
import * as React from "react";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";

import { deleteProductAction } from "@/actions/products";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { AppErrorShape } from "@/lib/result";
import type { Product } from "@/types";

interface ProductDeleteDialogProps {
  product: Product;
  className?: string;
  /** 删除成功后是否跳回列表页（商品详情页场景传 true） */
  redirectToList?: boolean;
  /** 触发按钮样式 */
  triggerVariant?: "outline" | "ghost" | "danger";
  triggerLabel?: string;
}

export function ProductDeleteDialog({
  product,
  className,
  redirectToList = false,
  triggerVariant = "ghost",
  triggerLabel = "删除",
}: ProductDeleteDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<AppErrorShape | null>(null);
  const [pending, startTransition] = React.useTransition();

  const handleDelete = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteProductAction(product.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      if (redirectToList) {
        router.push("/products");
        return;
      }
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} className={className}>
          <Trash2 />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>删除商品</DialogTitle>
          <DialogDescription>
            确认要删除「{product.name}」吗？此操作不可撤销。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-5 py-4">
          {error ? <ErrorState error={error} /> : null}
          <ul className="flex flex-col gap-2 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2.5 text-[12px] leading-5 text-destructive">
            <li className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              商品资料将从数据库移除
            </li>
            <li className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              该商品的分析结果也会一并删除
            </li>
            <li className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {product.imageUrl
                ? "对象存储中的商品图片会被同步清理"
                : "该商品没有上传过图片"}
            </li>
          </ul>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              取消
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="danger"
            disabled={pending}
            onClick={handleDelete}
          >
            {pending ? (
              <>
                <Loader2 className="animate-spin" />
                删除中…
              </>
            ) : (
              <>
                <Trash2 />
                确认删除
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
