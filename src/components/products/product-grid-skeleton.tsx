import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** 商品卡片骨架，结构对齐 ProductCard，避免加载完成后布局跳动 */
function ProductCardSkeleton() {
  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col gap-3 pt-4">
        <div className="flex gap-3">
          <Skeleton className="size-16 shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <div className="flex gap-1.5">
              <Skeleton className="h-4 w-12 rounded-md" />
              <Skeleton className="h-4 w-10 rounded-md" />
            </div>
          </div>
        </div>
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-9 w-full rounded-lg" />
        <div className="mt-auto flex items-center justify-between border-t border-border/70 pt-3">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-7 w-24 rounded-lg" />
        </div>
      </CardContent>
    </Card>
  );
}

/** 商品网格加载态：默认渲染一整行（3 列）卡片 */
export function ProductGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
      aria-busy
      aria-label="商品加载中"
    >
      {Array.from({ length: count }, (_, index) => (
        <ProductCardSkeleton key={index} />
      ))}
    </div>
  );
}

/** 商品筛选条骨架 */
export function ProductToolbarSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 shadow-card lg:flex-row lg:items-center">
      <Skeleton className="h-9 flex-1 rounded-lg" />
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-32 rounded-lg" />
        <Skeleton className="h-9 w-36 rounded-lg" />
      </div>
    </div>
  );
}
