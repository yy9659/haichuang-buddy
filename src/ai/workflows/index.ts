/**
 * 编排层出口（S4-1）
 *
 * 模块职责：
 * - `types.ts`             —— 执行记录与结果的共享类型
 * - `dependency-graph.ts`  —— 依赖图与拓扑序
 * - `plan-validator.ts`    —— 计划合法性校验（形状之外的语义规则）
 * - `reuse-resolver.ts`    —— 复用判定（已有结果就不重复调模型）
 * - `executor.ts`          —— 按依赖调度执行（并发上限、失败传播、超时、中止）
 * - `business-workflow.ts` —— 工作流状态机编排（running → 终态）
 */

export * from "./types";
export * from "./dependency-graph";
export * from "./plan-validator";
export * from "./reuse-resolver";
export * from "./executor";
export * from "./business-workflow";
