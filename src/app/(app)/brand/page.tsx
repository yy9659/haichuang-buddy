import type { Metadata } from "next";
import { Palette, RefreshCw, Store } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import {
  BrandIdentityCard,
  BrandValueGrid,
} from "@/components/brand/brand-identity-card";
import { BrandStoryCard, OwnerTwinCard } from "@/components/brand/owner-twin-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MOCK_BRAND_PROFILE, MOCK_BUSINESS, MOCK_OWNER_TWIN } from "@/lib/mock";

export const metadata: Metadata = {
  title: "品牌中心 · 海创Buddy",
};

/** 品牌中心：品牌定位 + 品牌资产 + 品牌故事 + 老板数字分身 */
export default function BrandPage() {
  return (
    <>
      <PageHeader
        title="品牌中心"
        description="品牌经理 Agent 基于 Product DNA 与老板数字分身，产出可被所有内容 Agent 复用的品牌档案。"
        badge={<Badge variant="soft">完整度 86%</Badge>}
        actions={
          <>
            <Button variant="outline">
              <Store />
              {MOCK_BUSINESS.shortName}
            </Button>
            <Button>
              <RefreshCw />
              重新生成品牌策略
            </Button>
          </>
        }
      />

      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
        <BrandIdentityCard brand={MOCK_BRAND_PROFILE} />
        <BrandValueGrid brand={MOCK_BRAND_PROFILE} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
        <BrandStoryCard brand={MOCK_BRAND_PROFILE} />
        <OwnerTwinCard owner={MOCK_OWNER_TWIN} />
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-[12px] text-muted-foreground shadow-card">
        <Palette className="size-3.5 shrink-0 text-primary" />
        品牌档案更新时间：{MOCK_BRAND_PROFILE.updatedAt} · 当前品牌：
        {MOCK_BUSINESS.name}（{MOCK_BUSINESS.location}）
      </div>
    </>
  );
}
