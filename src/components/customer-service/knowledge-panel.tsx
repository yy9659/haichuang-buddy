import { KnowledgeGapPanel } from "@/components/customer-service/knowledge-gap-panel";
import { KnowledgeLibrary } from "@/components/customer-service/knowledge-library";
import type { KnowledgeDocument, KnowledgeGapRecord } from "@/types";

interface KnowledgePanelProps {
  documents: KnowledgeDocument[];
  gaps: KnowledgeGapRecord[];
  productOptions: Array<{ id: string; name: string }>;
}

/**
 * 右侧「知识库与缺口」区。
 *
 * 这里只是一个**组合点**：两个子组件都是客户端组件（要弹窗、要提交），
 * 由本服务端组件把页面已经取到的数据分派下去。
 *
 * 为什么不合成一个大客户端组件：知识库管理与缺口补知识是两条独立的流程，
 * 合并之后「重新索引时缺口列表为什么也重渲染了」这类问题会不断冒出来。
 */
export function KnowledgePanel({
  documents,
  gaps,
  productOptions,
}: KnowledgePanelProps) {
  return (
    <div className="flex flex-col gap-3">
      <KnowledgeLibrary documents={documents} productOptions={productOptions} />
      <KnowledgeGapPanel gaps={gaps} />
    </div>
  );
}
