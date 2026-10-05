import { Compass, Quote, Sparkles } from "lucide-react";

import { TagSection } from "@/components/common/tag-section";
import { Card, CardContent } from "@/components/ui/card";
import type { BrandProfile } from "@/types";

/** 品牌定位卡片 */
export function BrandIdentityCard({ brand }: { brand: BrandProfile }) {
  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary-soft text-primary">
              <Compass className="size-4" />
            </span>
            <div className="flex flex-col">
              <span className="text-[13px] font-semibold">品牌定位</span>
              <span className="text-[11px] text-muted-foreground">
                由商家核对后决定是否对外使用
              </span>
            </div>
          </div>
        </div>

        <p className="text-[15px] leading-6 font-medium">{brand.positioning}</p>

        <div className="flex items-start gap-2 rounded-lg border border-primary/15 bg-primary-soft/60 px-3 py-2.5">
          <Quote className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span className="text-[13px] leading-6 font-medium text-primary">
            {brand.slogan}
          </span>
        </div>

        <TagSection
          title="目标人群"
          items={brand.targetAudience}
          variant="primary"
        />
      </CardContent>
    </Card>
  );
}

/** 品牌价值 / 性格 / 语气 / 视觉关键词 */
export function BrandValueGrid({ brand }: { brand: BrandProfile }) {
  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-violet-100 text-violet-600">
            <Sparkles className="size-4" />
          </span>
          <div className="flex flex-col">
            <span className="text-[13px] font-semibold">品牌资产</span>
            <span className="text-[11px] text-muted-foreground">
              供后续内容生成参考的品牌表达
            </span>
          </div>
        </div>
        <TagSection title="品牌价值" items={brand.brandValues} variant="success" />
        <TagSection title="品牌性格" items={brand.brandPersonality} />
        <TagSection title="表达语气" items={brand.toneOfVoice} />
        <TagSection title="视觉关键词" items={brand.visualKeywords} variant="warning" />
      </CardContent>
    </Card>
  );
}
