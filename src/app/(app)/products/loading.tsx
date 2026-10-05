import {
  ProductGridSkeleton,
  ProductToolbarSkeleton,
} from "@/components/products/product-grid-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** /products 加载态：结构对齐真实页面，避免加载完成时布局跳动 */
export default function ProductsLoading() {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[104px] rounded-xl" />
        ))}
      </section>

      <div className="flex flex-col gap-3">
        <ProductToolbarSkeleton />
        <ProductGridSkeleton />
      </div>
    </>
  );
}
