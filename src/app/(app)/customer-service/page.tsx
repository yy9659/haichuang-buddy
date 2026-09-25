import type { Metadata } from "next";
import { BookOpen, CircleHelp, Headphones, Percent, Upload } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { StatCard } from "@/components/common/stat-card";
import { ConversationWorkspace } from "@/components/customer-service/conversation-workspace";
import { KnowledgePanel } from "@/components/customer-service/knowledge-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MOCK_CHAT_MESSAGES,
  MOCK_CONVERSATIONS,
  MOCK_KNOWLEDGE_GAPS,
  MOCK_KNOWLEDGE_SOURCES,
} from "@/lib/mock";

export const metadata: Metadata = {
  title: "智能客服 · 海创Buddy",
};

/** 智能客服：会话处理 + 知识来源 + 知识缺口提醒 */
export default function CustomerServicePage() {
  const humanNeeded = MOCK_CONVERSATIONS.filter(
    (item) => item.status === "human",
  ).length;

  return (
    <>
      <PageHeader
        title="智能客服"
        description="AI 客服基于商品与售后知识回答客户咨询，每条回答都附引用来源；缺少可靠信息时主动建议转人工。"
        badge={<Badge variant="soft">Mock 数据</Badge>}
        actions={
          <>
            <Button variant="outline">
              <Upload />
              上传知识文档
            </Button>
            <Button>
              <Headphones />
              接入渠道设置
            </Button>
          </>
        }
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="今日会话"
          value={`${MOCK_CONVERSATIONS.length}`}
          unit="个"
          tone="primary"
          icon={<Headphones />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              来自抖音、视频号、微信与门店
            </span>
          }
        />
        <StatCard
          label="AI 自动解决率"
          value="82%"
          tone="success"
          icon={<Percent />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              较昨日提升 4 个百分点
            </span>
          }
        />
        <StatCard
          label="待转人工"
          value={`${humanNeeded}`}
          unit="个"
          tone="warning"
          icon={<CircleHelp />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              其中 1 个为高优先级售后异议
            </span>
          }
        />
        <StatCard
          label="知识库文档"
          value={`${MOCK_KNOWLEDGE_SOURCES.length}`}
          unit="条"
          tone="info"
          icon={<BookOpen />}
          footer={
            <span className="text-[11px] text-muted-foreground">
              覆盖商品 / 物流 / 售后 / 烹饪 / 储存
            </span>
          }
        />
      </section>

      <div className="grid gap-3 xl:grid-cols-[1fr_minmax(0,300px)]">
        <ConversationWorkspace
          conversations={MOCK_CONVERSATIONS}
          messagesByConversation={MOCK_CHAT_MESSAGES}
        />

        <SectionCard
          title="知识库与缺口"
          description="RAG 检索结果的引用来源与缺失项"
        >
          <KnowledgePanel
            sources={MOCK_KNOWLEDGE_SOURCES}
            gaps={MOCK_KNOWLEDGE_GAPS}
          />
        </SectionCard>
      </div>
    </>
  );
}
