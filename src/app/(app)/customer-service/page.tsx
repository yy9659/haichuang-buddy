import type { Metadata } from "next";
import { BookOpen, CircleHelp, Headphones, ShieldCheck } from "lucide-react";

import { ChatComposer } from "@/components/customer-service/chat-composer";
import { ChatThread } from "@/components/customer-service/chat-thread";
import { ConversationList } from "@/components/customer-service/conversation-list";
import { ConversationToolbar } from "@/components/customer-service/conversation-toolbar";
import { KnowledgePanel } from "@/components/customer-service/knowledge-panel";
import { NewConversationDialog } from "@/components/customer-service/new-conversation-dialog";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { StatCard } from "@/components/common/stat-card";
import { Badge } from "@/components/ui/badge";
import { unwrapOrThrow } from "@/lib/result";
import { readParam, type RawSearchParams } from "@/lib/search-params";
import { ensureDemoKnowledgeIndexed, getCustomerServiceView } from "@/services";

export const metadata: Metadata = {
  title: "答疑助手 · 海创Buddy",
};

interface CustomerServicePageProps {
  /** 选中的会话由 URL 承载（`?conv=`），因此本页按请求渲染 */
  searchParams: Promise<RawSearchParams>;
}

/**
 * 智能客服：会话处理 + 知识来源 + 知识缺口提醒。
 *
 * 左（会话列表）→ 中（聊天消息）→ 右（知识依据 / 缺口 / 知识库）三段布局。
 * 三段的数据全部来自真实业务表：会话与消息来自 `customer_conversations` /
 * `customer_messages`，AI 回答来自一次真实的 RAG 检索 —— 页面里没有任何
 * 预置的客服话术。
 */
export default async function CustomerServicePage({
  searchParams,
}: CustomerServicePageProps) {
  const params = await searchParams;

  /**
   * 渲染前把 Demo 种子知识补齐索引（Task 81 §22）。
   *
   * 幂等且只在 Mock 数据源下真正干活；失败被刻意吞掉 —— 知识面板的
   * 「建立索引」按钮与条件警告条（§24）仍是人工兜底，一次自动初始化的
   * 失败不该让整个客服工作台打不开。
   */
  const bootstrapped = await ensureDemoKnowledgeIndexed();
  if (!bootstrapped.ok) {
    console.warn(`[customer-service] 演示知识自动索引失败：${bootstrapped.error.message}`);
  }

  const view = unwrapOrThrow(await getCustomerServiceView(readParam(params, "conv")));
  const {
    conversations,
    activeConversation,
    messages,
    knowledgeDocuments,
    knowledgeGaps,
    summary,
    productOptions,
  } = view;

  const indexedCount = knowledgeDocuments.filter(
    (document) => document.indexStatus === "indexed",
  ).length;
  const openGaps = knowledgeGaps.filter((gap) => gap.status === "open");
  const closed = activeConversation?.status === "closed";

  return (
    <>
      <PageHeader
        title="答疑助手"
        description="用商品资料核对回复，复制后由你发送给顾客。当前会话为站内模拟。"
        badge={<Badge variant="soft">知识可追溯</Badge>}
        actions={<NewConversationDialog productOptions={productOptions} />}
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="会话总数"
          value={`${summary.total}`}
          unit="个"
          tone="primary"
          icon={<Headphones />}
        />
        <StatCard
          label="依据充分回答"
          value={`${summary.botHandled}`}
          unit="个"
          tone="success"
          icon={<ShieldCheck />}
        />
        <StatCard
          label="待转人工"
          value={`${summary.humanNeeded}`}
          unit="个"
          tone="warning"
          icon={<CircleHelp />}
        />
        <StatCard
          label="知识库文档"
          value={`${knowledgeDocuments.length}`}
          unit="份"
          tone="info"
          icon={<BookOpen />}
          footer={
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {indexedCount} 份已完成索引 · {openGaps.length} 项待补缺口
            </span>
          }
        />
      </section>

      <div className="grid gap-3 xl:grid-cols-[1fr_minmax(0,320px)]">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,300px)_1fr] xl:items-stretch">
          <div className="xl:h-[calc(100vh-320px)]">
            <ConversationList
              conversations={conversations}
              activeId={activeConversation?.id ?? null}
            />
          </div>
          <div className="flex flex-col xl:h-[calc(100vh-320px)]">
            {/* key 保证切换会话时重置 —— 输入框里不该残留上一段会话的草稿 */}
            <ChatThread
              key={activeConversation?.id ?? "empty"}
              conversation={activeConversation}
              messages={messages}
              actions={
                activeConversation ? (
                  <ConversationToolbar conversation={activeConversation} />
                ) : null
              }
              footer={
                activeConversation ? (
                  <ChatComposer
                    conversationId={activeConversation.id}
                    disabled={closed}
                    disabledReason="会话已结束，无法继续发送。如需继续咨询，请新建一个会话。"
                  />
                ) : null
              }
            />
          </div>
        </div>

        <SectionCard
          title="知识库与缺口"
          description="回答依据与待补知识"
        >
          <KnowledgePanel
            documents={knowledgeDocuments}
            gaps={knowledgeGaps}
            productOptions={productOptions}
          />
        </SectionCard>
      </div>
    </>
  );
}
