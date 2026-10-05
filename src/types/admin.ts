export interface PlatformTask {
  id: string;
  agentType: string;
  title: string;
  status: string;
  businessName: string;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorSummary: string | null;
  providerId: string | null;
}

export interface PlatformSnapshot {
  merchants: number;
  materials: number;
  interactions: number;
  completed: number;
  failed: number;
  running: number;
  queued: number;
  skipped: number;
  averageDurationMs: number | null;
  categories: { name: string; value: number }[];
  channels: { name: string; value: number }[];
  locations: { name: string; value: number }[];
  recentTasks: PlatformTask[];
  trendTasks: PlatformTask[];
  trendLimited: boolean;
  updatedAt: string;
}

export interface PlatformTrendPoint {
  date: string;
  label: string;
  peak: number;
  responseSeconds: number | null;
  tasks: number;
}

export const PUBLIC_KNOWLEDGE_CATEGORIES = ["产地与地标", "品质规范", "冷链与售后", "经营与推广"] as const;
export type PublicKnowledgeCategory = typeof PUBLIC_KNOWLEDGE_CATEGORIES[number];
export type PublicKnowledgeStatus = "draft" | "published" | "archived";
export interface PublicKnowledgeInput {
  title: string;
  category: PublicKnowledgeCategory;
  content: string;
  tags: string[];
  sourceName: string;
  sourceUrl: string;
  verified: boolean;
  status: PublicKnowledgeStatus;
}
export interface PublicKnowledgeDocument extends PublicKnowledgeInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface PlatformRepository {
  snapshot(now: Date): Promise<PlatformSnapshot>;
  listKnowledge(publishedOnly?: boolean): Promise<PublicKnowledgeDocument[]>;
  saveKnowledge(id: string | null, input: PublicKnowledgeInput, editorId: string): Promise<PublicKnowledgeDocument | null>;
  deleteKnowledge(id: string): Promise<boolean>;
}
