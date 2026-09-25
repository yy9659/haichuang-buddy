import { Card, CardContent } from "@/components/ui/card";
import { TONE_CLASSES } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { QuestionCategoryStat } from "@/types";

/** 问题类型占比（纯 CSS 条形，占比由程序计算） */
export function QuestionCategoryList({
  categories,
}: {
  categories: QuestionCategoryStat[];
}) {
  return (
    <ul className="flex flex-col gap-3">
      {categories.map((category) => (
        <li key={category.intent} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium">{category.label}</span>
            <span className="flex items-center gap-1.5 text-muted-foreground tabular-nums">
              <span>{category.count}</span>
              <span className="text-border">·</span>
              <span className={cn("font-medium", TONE_CLASSES[category.tone].text)}>
                {(category.ratio * 100).toFixed(1)}%
              </span>
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-700",
                TONE_CLASSES[category.tone].solid,
              )}
              style={{ width: `${Math.max(category.ratio * 100, 2)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** 带标题卡片包装（供经营分析页面直接使用） */
export function QuestionCategoryCard({
  categories,
  className,
}: {
  categories: QuestionCategoryStat[];
  className?: string;
}) {
  const total = categories.reduce((sum, item) => sum + item.count, 0);

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardContent className="pt-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13px] font-medium">问题类型占比</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            共 {total} 次咨询
          </span>
        </div>
        <QuestionCategoryList categories={categories} />
      </CardContent>
    </Card>
  );
}
