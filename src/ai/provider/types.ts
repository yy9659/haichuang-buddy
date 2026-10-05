/**
 * AI Provider 抽象（技术文档第 13 章）
 *
 * 硬约束：业务代码与 Agent 只能通过本接口调用模型，
 * 禁止在组件或服务里直接 import 任何模型 SDK（开发纪律 07）。
 *
 * S0 阶段只定义契约，具体实现（OpenAI 兼容协议 / DashScope / 其他）
 * 在 S2 接入 Product Agent 时落地。
 */

import type { ZodType } from "zod";

/** 模型档位，对应环境变量 AI_MODEL_FAST / REASONING / VISION / EMBEDDING */
export type ModelTier = "fast" | "reasoning" | "vision" | "embedding";

export interface ChatMessageInput {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateTextInput {
  /** 系统提示词。每个调用点都必须显式提供，禁止依赖默认值 */
  system: string;
  prompt: string;
  tier?: ModelTier;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateObjectInput<T> {
  system: string;
  prompt: string;
  /** 输出必须通过该 Zod Schema 校验 */
  schema: ZodType<T>;
  tier?: ModelTier;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface AnalyzeImageInput {
  system: string;
  prompt: string;
  /** 图片地址（Supabase Storage 公网或签名 URL） */
  imageUrls: string[];
  tier?: ModelTier;
  signal?: AbortSignal;
}

export interface EmbedInput {
  values: string[];
  signal?: AbortSignal;
}

export interface StreamTextInput extends GenerateTextInput {
  /** 流式回调，逐段消费文本；用于内容生成与客服对话 */
  onChunk?: (chunk: string) => void;
}

/**
 * 模型能力统一接口。
 * 后续可整体切换到 OpenAI / Qwen / DeepSeek / 平台提供的模型，业务代码无需改动。
 */
export interface AIProvider {
  /** 提供方标识，用于日志与可观测性 */
  readonly id: string;
  /** 纯文本生成，返回完整文本 */
  generateText(input: GenerateTextInput): Promise<string>;
  /** 结构化输出，返回已通过 Zod 校验的对象 */
  generateObject<T>(input: GenerateObjectInput<T>): Promise<T>;
  /** 流式文本生成 */
  streamText(input: StreamTextInput): Promise<ReadableStream<string>>;
  /** 图像理解（Product Agent 的商品图片分析） */
  analyzeImage(input: AnalyzeImageInput): Promise<string>;
  /** 文本向量化（RAG 检索） */
  embed(input: EmbedInput): Promise<number[][]>;
}

/**
 * 结构化输出的纠错重试次数（技术文档 21 章：失败可重试）。
 *
 * 纠错逻辑由 `src/ai/schemas/agent-output.ts` 的 `generateValidatedObject()` 统一实现
 * ——放在 Agent 公共层而不是各 Provider 里，是为了保证「提取 JSON → 校验 → 把错误回喂」
 * 只有一份实现，换模型时行为不变。
 */
export const SCHEMA_REPAIR_ATTEMPTS = 1;
