import { Skeleton } from "@/components/ui/skeleton";

/** /products/[id] 加载态 */
export default function ProductDetailLoading() {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,320px)_1fr]">
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-border bg-card p-4 shadow-card">
            <Skeleton className="aspect-4/3 w-full rounded-lg" />
            <Skeleton className="mt-3 h-6 w-24" />
            <div className="mt-3 flex flex-col gap-2">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-4 w-full" />
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-border bg-card p-4 shadow-card">
            <Skeleton className="h-4 w-24" />
            <div className="mt-3 flex gap-2">
              <Skeleton className="h-5 w-20 rounded-md" />
              <Skeleton className="h-5 w-20 rounded-md" />
            </div>
            <Skeleton className="mt-3 h-2 w-full" />
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-36 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
