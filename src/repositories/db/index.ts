/**
 * 数据库仓储集合
 *
 * 状态说明（重要）：
 * 已迁移到数据库的领域：**商品 / Product DNA / 品牌档案 / 内容资产 / Agent 任务记录 /
 * 工作流记录 / 商家 / 知识库（文档・切片・缺口）/ 客服会话与消息 /
 * 直播（场次・评论・建议）/ 经营日报（S7 补齐）**。
 *
 * `analytics`（流量 / 转化 / 销量等**模拟**经营数据）没有对应的表：这些数字只在
 * 接入真实平台后台后才可能有来源，本地没有种子、也没有表 —— 因此在 db 数据源下
 * 返回**空视图**（界面显示「暂无模拟数据」），而不是抛 NOT_IMPLEMENTED。
 *
 * S4-2 起 AI 员工的状态**不经过仓储**：员工的名称 / 图标 / 能力标签是常量目录
 * （`@/lib/agents`），运行时状态由 `agentTasks` + `agentWorkflows` 推出。
 * 因此 db 模式下驾驶舱的「AI 数字员工」与「经营工作流」两块是完全可用的。
 *
 * S7 起直播与经营日报也从 NOT_IMPLEMENTED 占位补齐为真实实现，所有业务领域
 * 均已接上数据库 —— 把 DATA_SOURCE 切成 db 时不再有任何「尚未迁移」的区块。
 */

import type {
  AgentTaskRepository,
  AnalyticsReportRepository,
  AnalyticsRepository,
  BusinessRepository,
  KnowledgeChunkRepository,
  KnowledgeDocumentRepository,
  KnowledgeGapRepository,
  LiveRepository,
  ProductDnaRepository,
  ProductRepository,
  Repositories,
} from "../types";

import { createDbAgentTaskRepository } from "./agent-task.repository";
import { createDbAgentWorkflowRepository } from "./agent-workflow.repository";
import { createDbAnalyticsRepository } from "./analytics.repository";
import {
  createDbSessionRepository,
  createDbUserRepository,
} from "./auth.repository";
import { createDbBrandRepository } from "./brand.repository";
import { createDbBusinessRepository } from "./business.repository";
import { createDbContentRepository } from "./content.repository";
import { createDbConversationRepository } from "./conversation.repository";
import {
  createDbKnowledgeChunkRepository,
  createDbKnowledgeDocumentRepository,
} from "./knowledge.repository";
import { createDbKnowledgeGapRepository } from "./knowledge-gap.repository";
import { createDbLiveRepository } from "./live.repository";
import { createDbProductDnaRepository } from "./product-dna.repository";
import { createDbProductRepository } from "./product.repository";
import { createDbAnalyticsReportRepository } from "./reports.repository";
import { createDbSalesRepository } from "./sales.repository";

export function createDbRepositories(): Repositories {
  const products: ProductRepository = createDbProductRepository();
  const productDna: ProductDnaRepository = createDbProductDnaRepository();
  const business: BusinessRepository = createDbBusinessRepository();
  const agentTasks: AgentTaskRepository = createDbAgentTaskRepository();
  const knowledgeDocuments: KnowledgeDocumentRepository =
    createDbKnowledgeDocumentRepository();
  const knowledgeChunks: KnowledgeChunkRepository = createDbKnowledgeChunkRepository();
  const knowledgeGaps: KnowledgeGapRepository = createDbKnowledgeGapRepository();
  const live: LiveRepository = createDbLiveRepository();
  const analytics: AnalyticsRepository = createDbAnalyticsRepository();
  const reports: AnalyticsReportRepository = createDbAnalyticsReportRepository();

  return {
    products,
    productDna,
    business,
    brand: createDbBrandRepository(),
    content: createDbContentRepository(),
    live,
    conversations: createDbConversationRepository(),
    agentTasks,
    agentWorkflows: createDbAgentWorkflowRepository(),
    knowledgeDocuments,
    knowledgeChunks,
    knowledgeGaps,
    analytics,
    sales: createDbSalesRepository(),
    reports,
    users: createDbUserRepository(),
    sessions: createDbSessionRepository(),
  };
}

export { createDbSessionRepository, createDbUserRepository } from "./auth.repository";
export { createDbAgentTaskRepository } from "./agent-task.repository";
export { createDbAgentWorkflowRepository } from "./agent-workflow.repository";
export { createDbAnalyticsRepository } from "./analytics.repository";
export { createDbBrandRepository } from "./brand.repository";
export { createDbBusinessRepository } from "./business.repository";
export { createDbContentRepository } from "./content.repository";
export { createDbConversationRepository } from "./conversation.repository";
export {
  createDbKnowledgeChunkRepository,
  createDbKnowledgeDocumentRepository,
} from "./knowledge.repository";
export { createDbKnowledgeGapRepository } from "./knowledge-gap.repository";
export { createDbLiveRepository } from "./live.repository";
export { createDbProductDnaRepository } from "./product-dna.repository";
export { createDbProductRepository } from "./product.repository";
export { createDbAnalyticsReportRepository } from "./reports.repository";
