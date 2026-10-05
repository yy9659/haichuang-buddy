"use client";

/**
 * 商品新增 / 编辑对话框
 *
 * 流程（任务书 Task 4）：
 *   填写字段 →（可选）选择图片 → 提交 → Server Action 校验 + 上传图片 + 落库
 *
 * 设计取舍：
 * - 图片与字段在同一次提交里发给服务端。保存商品失败时，服务端会清理刚上传的图片。
 * - 表单状态用受控 state，但提交用 `new FormData(form)` 直接从 DOM 取值，
 *   避免手写一堆字段拼装代码并保证文件输入能被带上。
 * - 校验失败的错误来自服务端（Zod），文案由 `src/lib/validation.ts` 统一翻译。
 */

import { useRouter } from "next/navigation";
import * as React from "react";
import { ImagePlus, Loader2, Plus, Save, Sparkles, Upload, X } from "lucide-react";

import { createProductAction, updateProductAction } from "@/actions/products";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_UNIT_SUGGESTIONS,
} from "@/lib/product-options";
import type { AppErrorShape } from "@/lib/result";
import { cn } from "@/lib/utils";
import { isAllowedProductImageType, MAX_PRODUCT_IMAGE_BYTES } from "@/storage/paths";
import type { Product, ProductCategory } from "@/types";

type ProductFormMode = "create" | "edit";

interface ProductFormState {
  name: string;
  description: string;
  category: ProductCategory;
  subCategory: string;
  price: string;
  unit: string;
  stock: string;
  origin: string;
  specification: string;
  storageMethod: string;
  shelfLife: string;
  tags: string;
}

const EMPTY_FORM: ProductFormState = {
  name: "",
  description: "",
  category: "海产品",
  subCategory: "",
  price: "",
  unit: "500g",
  stock: "",
  origin: "福建连江",
  specification: "",
  storageMethod: "",
  shelfLife: "",
  tags: "",
};

function toFormState(product: Product): ProductFormState {
  return {
    name: product.name,
    description: product.description,
    category: product.category,
    subCategory: product.subCategory,
    price: product.price > 0 ? `${product.price}` : "",
    unit: product.unit,
    stock: `${product.stock}`,
    origin: product.origin,
    specification: product.specification,
    storageMethod: product.storageMethod,
    shelfLife: product.shelfLife,
    tags: product.tags.join("、"),
  };
}

function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {hint ? (
          <span className="font-normal text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

/** 图片选择区：显示预览、支持更换与移除 */
function ImagePicker({
  enabled,
  currentImageUrl,
  onFileChange,
  onRemove,
  removed,
}: {
  enabled: boolean;
  currentImageUrl: string | null;
  onFileChange: (file: File | null) => void;
  onRemove: () => void;
  removed: boolean;
}) {
  const inputId = React.useId();
  const [file, setFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  /** 当前预览用的 object URL，需要显式释放 */
  const previewUrlRef = React.useRef<string | null>(null);

  const selectFile = (next: File | null) => {
    setFileError(null);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    if (next) {
      const url = URL.createObjectURL(next);
      previewUrlRef.current = url;
      setPreview(url);
    } else {
      setPreview(null);
    }
    setFile(next);
    onFileChange(next);
  };

  // 卸载时释放最后一个 object URL
  React.useEffect(
    () => () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    },
    [],
  );

  const background = preview ?? (removed ? null : currentImageUrl);

  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor={inputId}
        className={cn(
          "relative flex size-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted/50 bg-cover bg-center text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary",
          !enabled && "pointer-events-none opacity-60",
        )}
        style={background ? { backgroundImage: `url(${background})` } : undefined}
      >
        {background ? null : <ImagePlus className="size-5" />}
        <input
          id={inputId}
          name="image"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif"
          className="sr-only"
          disabled={!enabled}
          onChange={(event) => {
            const next = event.currentTarget.files?.[0] ?? null;
            if (next && next.size > MAX_PRODUCT_IMAGE_BYTES) {
              selectFile(null);
              setFileError("图片不能超过 5MB，请选择较小的图片");
              event.currentTarget.value = "";
              return;
            }
            if (next && !isAllowedProductImageType(next.type)) {
              selectFile(null);
              setFileError("图片格式不支持，请上传 JPG / PNG / WebP / AVIF");
              event.currentTarget.value = "";
              return;
            }
            selectFile(next);
          }}
        />
      </label>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[12px] leading-5 text-muted-foreground">
          {enabled
            ? "支持 JPG / PNG / WebP / AVIF，单张不超过 5MB；本地演示与云存储会自动适配"
            : "当前数据源尚未配置图片存储，其余商品字段仍可正常保存"}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!enabled}
            onClick={() => document.getElementById(inputId)?.click()}
          >
            <Upload />
            {background ? "更换图片" : "选择图片"}
          </Button>
          {background ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!enabled}
              onClick={() => {
                selectFile(null);
                onRemove();
              }}
            >
              <X />
              移除
            </Button>
          ) : null}
        </div>
        {file ? (
          <span className="truncate text-[11px] text-muted-foreground">
            已选择：{file.name}
          </span>
        ) : null}
        {fileError ? <span role="alert" className="text-[11px] text-rose-300">{fileError}</span> : null}
      </div>
      <input type="hidden" name="removeImage" value={removed ? "1" : "0"} />
    </div>
  );
}

interface ProductFormDialogContentProps {
  mode: ProductFormMode;
  product?: Product;
  imageUploadEnabled: boolean;
  onDone: () => void;
}

function ProductFormDialogContent({
  mode,
  product,
  imageUploadEnabled,
  onDone,
}: ProductFormDialogContentProps) {
  const router = useRouter();
  const [values, setValues] = React.useState<ProductFormState>(() =>
    product ? toFormState(product) : EMPTY_FORM,
  );
  const [removedImage, setRemovedImage] = React.useState(false);
  const [error, setError] = React.useState<AppErrorShape | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [slowRequest, setSlowRequest] = React.useState(false);

  React.useEffect(() => {
    if (!pending) {
      return;
    }
    const timer = window.setTimeout(() => setSlowRequest(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const update = (patch: Partial<ProductFormState>) =>
    setValues((prev) => ({ ...prev, ...patch }));

  async function submit(formData: FormData) {
    setError(null);
    try {
      const result =
        mode === "create"
          ? await createProductAction(formData)
          : await updateProductAction(formData);

      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
      router.refresh();
    } catch {
      setError({
        code: "UNKNOWN",
        message: "保存请求中断，请刷新商品列表确认是否已保存，再尝试提交。",
        retryable: true,
      });
    } finally {
      setSlowRequest(false);
    }
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSlowRequest(false);
    const formData = new FormData(event.currentTarget);
    // 显式写入商品 id：编辑态下商品 id 不在可见表单里，避免被 DOM 意外清空
    if (mode === "edit" && product) {
      formData.set("productId", product.id);
    }
    startTransition(() => submit(formData));
  };

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          {mode === "create" ? "添加商品" : "编辑商品资料"}
        </DialogTitle>
        <DialogDescription>
          {mode === "create"
            ? "填写商品资料并上传图片，保存后可继续完善商品分析。"
            : "修改后的资料会立即生效；更换图片后商品会使用新图。"}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <ErrorState error={error} className="mb-4" />
          ) : null}
          {slowRequest ? (
            <p role="status" className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
              保存时间较长。如果页面仍无响应，请刷新后先检查商品列表，避免重复添加。
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Field
              label="商品名称"
              htmlFor="product-name"
              className="sm:col-span-2"
            >
              <Input
                id="product-name"
                name="name"
                value={values.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder="例如：连江鲜活鲍鱼"
                required
              />
            </Field>

            <Field label="分类" htmlFor="product-category">
              <Select
                id="product-category"
                name="category"
                value={values.category}
                onChange={(event) =>
                  update({ category: event.target.value as ProductCategory })
                }
              >
                {PRODUCT_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="子类目" htmlFor="product-subcategory" hint="选填">
              <Input
                id="product-subcategory"
                name="subCategory"
                value={values.subCategory}
                onChange={(event) => update({ subCategory: event.target.value })}
                placeholder="例如：鲍鱼"
              />
            </Field>

            <Field label="价格（元）" htmlFor="product-price">
              <Input
                id="product-price"
                name="price"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={values.price}
                onChange={(event) => update({ price: event.target.value })}
                placeholder="0.00"
                required
              />
            </Field>

            <Field label="计价单位" htmlFor="product-unit">
              <Input
                id="product-unit"
                name="unit"
                list="product-unit-options"
                value={values.unit}
                onChange={(event) => update({ unit: event.target.value })}
                placeholder="500g"
              />
              <datalist id="product-unit-options">
                {PRODUCT_UNIT_SUGGESTIONS.map((unit) => (
                  <option key={unit} value={unit} />
                ))}
              </datalist>
            </Field>

            <Field label="库存" htmlFor="product-stock" hint="选填">
              <Input
                id="product-stock"
                name="stock"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={values.stock}
                onChange={(event) => update({ stock: event.target.value })}
                placeholder="0"
              />
            </Field>

            <Field label="产地" htmlFor="product-origin" hint="选填">
              <Input
                id="product-origin"
                name="origin"
                value={values.origin}
                onChange={(event) => update({ origin: event.target.value })}
                placeholder="福建连江 · 黄岐半岛"
              />
            </Field>

            <Field label="规格" htmlFor="product-specification" hint="选填">
              <Input
                id="product-specification"
                name="specification"
                value={values.specification}
                onChange={(event) =>
                  update({ specification: event.target.value })
                }
                placeholder="8-10 头 / 500g"
              />
            </Field>

            <Field label="储存方式" htmlFor="product-storage" hint="选填">
              <Input
                id="product-storage"
                name="storageMethod"
                value={values.storageMethod}
                onChange={(event) =>
                  update({ storageMethod: event.target.value })
                }
                placeholder="0-4℃ 冷藏"
              />
            </Field>

            <Field label="保质期" htmlFor="product-shelflife" hint="选填">
              <Input
                id="product-shelflife"
                name="shelfLife"
                value={values.shelfLife}
                onChange={(event) => update({ shelfLife: event.target.value })}
                placeholder="2 天"
              />
            </Field>

            <Field
              label="标签"
              htmlFor="product-tags"
              hint="选填，最多 8 个，用逗号分隔"
              className="sm:col-span-2"
            >
              <Input
                id="product-tags"
                name="tags"
                value={values.tags}
                onChange={(event) => update({ tags: event.target.value })}
                placeholder="鲜活、产地直发、顺丰冷链"
              />
            </Field>

            <Field
              label="商品描述"
              htmlFor="product-description"
              hint="选填"
              className="sm:col-span-2"
            >
              <Textarea
                id="product-description"
                name="description"
                value={values.description}
                onChange={(event) => update({ description: event.target.value })}
                placeholder="用于详情页与 AI 分析的商品说明，建议写清产地、规格与卖点。"
                rows={3}
              />
            </Field>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label>商品图片</Label>
              <ImagePicker
                enabled={imageUploadEnabled}
                currentImageUrl={product?.imageUrl ?? null}
                removed={removedImage}
                onFileChange={(next) => {
                  if (next) {
                    setRemovedImage(false);
                  }
                }}
                onRemove={() => setRemovedImage(true)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              取消
            </Button>
          </DialogClose>
          <Button type="submit" disabled={pending}>
            {pending ? (
              <>
                <Loader2 className="animate-spin" />
                {mode === "create" ? "创建中…" : "保存中…"}
              </>
            ) : (
              <>
                {mode === "create" ? <Plus /> : <Save />}
                {mode === "create" ? "创建商品" : "保存修改"}
              </>
            )}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** 商品中心 / 空态里的「添加商品」入口 */
export function ProductCreateDialog({
  imageUploadEnabled,
  className,
  triggerLabel = "添加商品",
  triggerVariant = "default",
}: {
  imageUploadEnabled: boolean;
  className?: string;
  triggerLabel?: string;
  triggerVariant?: "default" | "outline" | "soft";
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} className={className}>
          <Plus />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <ProductFormDialogContent
        mode="create"
        imageUploadEnabled={imageUploadEnabled}
        onDone={() => setOpen(false)}
      />
    </Dialog>
  );
}

/** 商品详情页的「编辑资料」入口 */
export function ProductEditDialog({
  product,
  imageUploadEnabled,
  className,
}: {
  product: Product;
  imageUploadEnabled: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className={className}>
          <Sparkles />
          编辑资料
        </Button>
      </DialogTrigger>
      <ProductFormDialogContent
        mode="edit"
        product={product}
        imageUploadEnabled={imageUploadEnabled}
        onDone={() => setOpen(false)}
      />
    </Dialog>
  );
}

export type { ProductFormMode };
