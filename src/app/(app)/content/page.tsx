import type { Metadata } from "next";
import { Eye, FileText, RefreshCw, Sparkles, TrendingUp } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { StatCard } from "@/components/common/stat-card";
import { ContentBriefForm } from "@/components/content/content-brief-form";
import { ContentPlanCard } from "@/components/content/content-plan-card";
import { ContentWorkspace } from "@/components/content/content-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MOCK_CONTENT_PLAN, MOCK_CONTENTS, MOCK_PRODUCTS } from "@/lib/mock";

export const metadata: Metadata = {
  title: "内容工厂 · 海创Buddy",
};

/** AI 内容工厂：输入商品与营销目标，产出多平台结构化内容 */
export default function ContentPage() {
  const published = MOCK_CONTENTS.filter(
    (item) => item.status === "published",
  ).length;
  const failed = MOCK_CONTENTS.filter((item) => item.status === "failed").length;
  const totalViews = MOCK_CONTENTS.reduce(
    (sum, item) => sum + item.metrics.views,
    0,
  );
  const avgEngagement =
    MOCK_CONTENTS.filter((item) => item.metrics.views > 0).reduce(
      (sum, item) => sum + item.metrics.engagementRate,
      0,
    ) / Math.max(MOCK_CONTENTS.filter((item) => item.metrics.views > 0).length, 1);

  return (
    <>
      <PageHeader
        title="AI 内容工厂"
        description="内容运营 Agent 依据 Product DNA、品牌档案与老板数字分身，按平台调性生成结构化营销内容。"
        badge={<Badge variant="soft">Mock 数据</Badge>}
        actions={
          <Button variant="outline">
            <RefreshCw />
            重新生成失败内容
          </Button>
        }
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="今日内容产出"
          value={`${MOCK_CONTENTS.length}`}
          unit="条"
          tone="primary"
          icon={<FileText />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              覆盖抖音、小红书、视频号等平台
            </span>
          }
        />
        <StatCard
          label="已发布"
          value={`${published}`}
          unit="条"
          tone="success"
          icon={<Sparkles />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              {failed > 0 ? `${failed} 条生成失败待重试` : "全部生成成功"}
            </span>
          }
        />
        <StatCard
          label="累计播放量"
          value={totalViews >= 10000 ? `${(totalViews / 10000).toFixed(1)}w` : `${totalViews}`}
          tone="info"
          icon={<Eye />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              含短视频与图文，不含未发布内容
            </span>
          }
        />
        <StatCard
          label="平均互动率"
          value={`${(avgEngagement * 100).toFixed(1)}%`}
          tone="warning"
          icon={<TrendingUp />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              程序计算：(赞 + 评 + 转) / 播放
            </span>
          }
        />
      </section>

      <div className="grid gap-3 xl:grid-cols-[1.6fr_1fr]">
        <SectionCard
          title="内容生成"
          description="选择商品与营销目标，生成结构化营销内容"
          icon={<Sparkles className="size-4 text-primary" />}
        >
          <ContentBriefForm products={MOCK_PRODUCTS} />
        </SectionCard>

        <SectionCard title="内容排期" description="今日计划与执行状态">
          <ContentPlanCard plan={MOCK_CONTENT_PLAN} />
        </SectionCard>
      </div>

      <SectionCard
        title="内容资产"
        description="点击左侧内容查看完整结构化输出（标题 / Hook / 正文 / CTA / Hashtag / 镜头建议 / 旁白）"
        icon={<FileText className="size-4 text-primary" />}
      >
        <ContentWorkspace contents={MOCK_CONTENTS} />
      </SectionCard>
    </>
  );
}
