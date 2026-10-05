import { BookOpen, Fingerprint } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import type { BrandProfile, OwnerTwin } from "@/types";

/** 品牌故事卡片 */
export function BrandStoryCard({ brand }: { brand: BrandProfile }) {
  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
            <BookOpen className="size-4" />
          </span>
          <div className="flex flex-col">
            <span className="text-[13px] font-semibold">品牌故事</span>
            <span className="text-[11px] text-muted-foreground">
              商家确认后可用于详情页、视频与店铺介绍
            </span>
          </div>
        </div>
        <p className="text-[13px] leading-6 text-muted-foreground">
          {brand.brandStory}
        </p>
        <div className="rounded-lg border border-border bg-muted/60 px-3 py-2.5">
          <span className="text-[11px] font-semibold text-muted-foreground">
            IP 概念
          </span>
          <p className="mt-1 text-[12px] leading-5">{brand.ipConcept}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** 老板数字分身 Owner Twin */
export function OwnerTwinCard({ owner }: { owner: OwnerTwin }) {
  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-100 to-cyan-100 text-[16px] font-semibold text-blue-700">
            {owner.avatarLabel}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-[14px] font-semibold">
              {owner.displayName} · 数字分身
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Fingerprint className="size-3" />
              内容与客服 Agent 必须读取 Owner Profile
            </span>
          </div>
        </div>

        <dl className="flex flex-col text-[12px]">
          {[
            { id: "philosophy", label: "经营理念", value: owner.businessPhilosophy.join(" · ") },
            { id: "tone", label: "表达语气", value: owner.tone.join(" · ") },
            { id: "sales", label: "销售风格", value: owner.salesStyle },
            {
              id: "customers",
              label: "目标客户",
              value: owner.targetCustomers.join(" · "),
            },
          ].map((row, index) => (
            <div
              key={row.id}
              className={
                index === 0
                  ? "flex gap-3 py-2"
                  : "flex gap-3 border-t border-border/70 py-2"
              }
            >
              <dt className="w-16 shrink-0 text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 flex-1 leading-5 font-medium">{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2">
          <span className="text-[11px] font-semibold text-destructive">
            禁用表达
          </span>
          <p className="mt-1 text-[12px] leading-5 text-destructive">
            {owner.forbiddenExpressions.join("、")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
