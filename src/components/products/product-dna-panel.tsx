import { Sparkles, TriangleAlert } from "lucide-react";

import { TagSection, TagSectionCard } from "@/components/common/tag-section";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { ProductDNA } from "@/types";

/** Product DNA 结果面板（商品经理 Agent 输出） */
export function ProductDnaPanel({ dna }: { dna: ProductDNA }) {
  return (
    <div className="flex flex-col gap-3">
      <TagSectionCard
        title="AI 分析结论"
        description={`由商品经理 Agent 生成 · ${dna.aiVersion} · ${dna.generatedAt}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="soft">分类：{dna.category}</Badge>
          <Badge variant="soft">子类目：{dna.subCategory}</Badge>
          <Badge variant={dna.approved ? "success" : "warning"}>
            {dna.approved ? "已确认" : "待确认"}
          </Badge>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Sparkles className="size-3" />
              分析置信度
            </span>
            <span className="tabular-nums">
              {(dna.confidence * 100).toFixed(0)}%
            </span>
          </div>
          <Progress value={dna.confidence * 100} />
        </div>
      </TagSectionCard>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <TagSectionCard title="视觉特征" description="来自商品图片的多模态识别结果">
          <TagSection title="识别到的视觉要素" items={dna.visualFeatures} />
        </TagSectionCard>

        <TagSectionCard title="核心卖点" description="可直接用于详情页与直播口播">
          <TagSection
            title="卖点列表"
            items={dna.sellingPoints}
            variant="success"
          />
          <TagSection title="产品核心特征" items={dna.coreFeatures} />
        </TagSectionCard>

        <TagSectionCard title="目标用户与场景">
          <TagSection title="目标用户" items={dna.targetUsers} />
          <TagSection title="消费场景" items={dna.consumptionScenarios} />
        </TagSectionCard>

        <TagSectionCard title="用户痛点与营销角度">
          <TagSection title="用户痛点" items={dna.userPainPoints} />
          <TagSection title="可切入的营销角度" items={dna.marketingAngles} />
        </TagSectionCard>
      </div>

      <TagSectionCard
        title="风险提示"
        description="合规与表达风险，AI 内容生成时会规避此类表述"
      >
        <ul className="flex flex-col gap-2">
          {dna.riskNotes.map((note) => (
            <li
              key={note}
              className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/12 px-3 py-2 text-[12px] leading-5 text-warning"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {note}
            </li>
          ))}
        </ul>
      </TagSectionCard>
    </div>
  );
}
