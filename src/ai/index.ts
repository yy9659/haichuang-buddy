/**
 * AI 层统一出口
 *
 * 目录职责：
 * - `provider/` —— 模型能力抽象与实现（Mock 确定性实现 / DashScope 通义千问）
 * - `schemas/`  —— 结构化输出契约（Zod）与「提取 → 校验 → 纠错」通道
 * - `prompts/`  —— 提示词与结构化上下文块
 * - `agents/`   —— 各业务 Agent 的编排流程（Product / Brand / Content / Business Brain）与共用合规词表
 * - `workflows/`—— 经营计划的校验与执行引擎（S4-1 起）
 *
 * 纪律：业务代码（services / actions / 页面）只允许通过 Agent 或 Provider 接口访问模型，
 * 禁止直接 import 任何模型 SDK。
 *
 * 注意 `schemas/field-rules.ts` 与 `agents/compliance.ts` **刻意不从本出口导出**：
 * 它们是 Agent 层内部共用的实现细节（字段归一化规则、合规词表），
 * 不属于对外契约；需要它们的模块直接按路径引用，避免把内部约定扩散成公共 API。
 */

export * from "./provider";
export * from "./schemas/product-dna";
export * from "./schemas/brand-profile";
export * from "./schemas/content";
export * from "./schemas/business-plan";
export * from "./schemas/agent-output";
export * from "./prompts/product-agent";
export * from "./prompts/brand-agent";
export * from "./prompts/content-agent";
export * from "./prompts/business-brain";
export * from "./agents/product-agent";
export * from "./agents/brand-agent";
export * from "./agents/content-agent";
export * from "./agents/business-brain";
export * from "./workflows";
