import { createMockAgentTaskRepository } from "./agent-tasks";
import { createMockAgentWorkflowRepository } from "./agent-workflows";
import { createMockAnalyticsRepository } from "./analytics";
import {
  createMockSessionRepository,
  createMockUserRepository,
} from "./auth";
import { createMockBrandRepository } from "./brand";
import { createMockBusinessRepository } from "./business";
import { createMockContentRepository } from "./content";
import { createMockConversationRepository } from "./conversations";
import {
  createMockKnowledgeChunkRepository,
  createMockKnowledgeDocumentRepository,
} from "./knowledge";
import { createMockKnowledgeGapRepository } from "./knowledge-gaps";
import { createMockLiveRepository } from "./live";
import { createMockProductDnaRepository } from "./product-dna";
import { createMockProductRepository } from "./products";
import { createMockAnalyticsReportRepository } from "./reports";
import { createMockSalesRepository } from "./sales";

import type { Repositories } from "../types";

/** 组装全部 Mock 仓储 */
export function createMockRepositories(): Repositories {
  return {
    products: createMockProductRepository(),
    productDna: createMockProductDnaRepository(),
    business: createMockBusinessRepository(),
    brand: createMockBrandRepository(),
    content: createMockContentRepository(),
    live: createMockLiveRepository(),
    conversations: createMockConversationRepository(),
    agentTasks: createMockAgentTaskRepository(),
    agentWorkflows: createMockAgentWorkflowRepository(),
    knowledgeDocuments: createMockKnowledgeDocumentRepository(),
    knowledgeChunks: createMockKnowledgeChunkRepository(),
    knowledgeGaps: createMockKnowledgeGapRepository(),
    analytics: createMockAnalyticsRepository(),
    sales: createMockSalesRepository(),
    reports: createMockAnalyticsReportRepository(),
    users: createMockUserRepository(),
    sessions: createMockSessionRepository(),
  };
}
