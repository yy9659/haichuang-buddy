/**
 * AI Provider 工厂
 *
 * 选择规则（与项目「不静默降级」的一贯纪律一致）：
 * - `AI_PROVIDER` 未设置 / = `mock` → Mock Provider（零凭证可跑，产出带占位标记）
 * - `AI_PROVIDER=dashscope`         → 通义千问（阿里云百炼，OpenAI 兼容协议）
 * - `AI_PROVIDER=<其他>`            → **明确报错**，而不是偷偷用 Mock 顶替。
 *   悄悄降级会让「以为在调真模型、其实拿到占位数据」这种事发生。
 */

import { getServerEnv } from "@/lib/env";
import { AppError, toAppError } from "@/lib/result";

import { DASHSCOPE_PROVIDER_ID, createDashScopeProvider } from "./dashscope";
import { createMockAIProvider } from "./mock";
import type { AIProvider } from "./types";

/** 未配置 AI_PROVIDER 时使用的默认提供方 */
export const DEFAULT_AI_PROVIDER_ID = "mock";

/** 已实现的提供方（其余取值一律 NOT_IMPLEMENTED） */
export const IMPLEMENTED_AI_PROVIDER_IDS = [
  DEFAULT_AI_PROVIDER_ID,
  DASHSCOPE_PROVIDER_ID,
] as const;

/** 提供方 → 界面展示名；未知取值的兜底在函数里处理 */
export const AI_PROVIDER_LABEL: Readonly<Record<string, string>> = {
  [DEFAULT_AI_PROVIDER_ID]: "Mock 占位",
  [DASHSCOPE_PROVIDER_ID]: "通义千问",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  custom: "自定义模型",
};

/** 获取当前生效的 AI Provider；配置不可用时抛出带标准错误码的 AppError */
export function getAIProvider(): AIProvider {
  const providerId = getServerEnv().AI_PROVIDER ?? DEFAULT_AI_PROVIDER_ID;

  if (providerId === DEFAULT_AI_PROVIDER_ID) {
    return createMockAIProvider();
  }
  if (providerId === DASHSCOPE_PROVIDER_ID) {
    return createDashScopeProvider();
  }

  throw new AppError({
    code: "NOT_IMPLEMENTED",
    message: `模型提供方「${providerId}」尚未接入`,
    detail:
      `当前已实现的提供方：${IMPLEMENTED_AI_PROVIDER_IDS.join("、")}。` +
      "本地开发请把 .env.local 中的 AI_PROVIDER 设为 mock 或 dashscope。",
    retryable: false,
  });
}

/**
 * 仅查询「当前模型通道是否可用」，**不抛异常**。
 *
 * 用途：商品详情页需要在用户点按钮之前就如实告诉对方
 * 「现在用的是 Mock 占位还是真实模型」，而不是点了才失败。
 */
export interface AIProviderStatus {
  providerId: string;
  /** 是否为本地 Mock（产出带占位标记，不能当真实结论） */
  isMock: boolean;
  /** 当前配置下能否真正发起调用 */
  usable: boolean;
  /** 不可用原因，用于界面提示 */
  reason?: string;
}

export function getAIProviderStatus(): AIProviderStatus {
  let providerId: string = DEFAULT_AI_PROVIDER_ID;
  try {
    providerId = getServerEnv().AI_PROVIDER ?? DEFAULT_AI_PROVIDER_ID;
  } catch (cause) {
    return {
      providerId: "unknown",
      isMock: false,
      usable: false,
      reason: toAppError(cause, "VALIDATION_FAILED", "模型配置不可用").message,
    };
  }

  if (providerId === DEFAULT_AI_PROVIDER_ID) {
    return { providerId, isMock: true, usable: true };
  }

  if (providerId === DASHSCOPE_PROVIDER_ID) {
    try {
      // 构造一次即可完成「缺 Key / 地址非法」的校验
      createDashScopeProvider();
      return { providerId, isMock: false, usable: true };
    } catch (cause) {
      const error = toAppError(cause, "VALIDATION_FAILED", "模型配置不可用");
      return {
        providerId,
        isMock: false,
        usable: false,
        reason: error.detail ?? error.message,
      };
    }
  }

  return {
    providerId,
    isMock: false,
    usable: false,
    reason: `模型提供方「${providerId}」尚未接入，已实现的提供方：${IMPLEMENTED_AI_PROVIDER_IDS.join("、")}`,
  };
}

export {
  createDashScopeProvider,
  DASHSCOPE_PROVIDER_ID,
  DASHSCOPE_DEFAULT_BASE_URL,
  DASHSCOPE_DEFAULT_MODELS,
} from "./dashscope";
export type { DashScopeProviderOptions } from "./dashscope";
export {
  buildDeterministicEmbedding,
  createMockAIProvider,
  MOCK_AI_SCENARIOS,
  MOCK_OUTPUT_MARKER,
} from "./mock";
export type { MockAIProviderOptions, MockAiScenario } from "./mock";
/**
 * 注意：`tokenizeForEmbedding` / `lexicalCoverage` **不从这里导出**。
 * 它们是中立的文本工具（`@/lib/text-tokens`），RAG 检索层与 Provider 各用一份，
 * 谁都不该通过 Provider 的入口去拿对方的实现细节。
 */
export * from "./types";
export { createWanxiangImageProvider, getWanxiangStatus } from "./wanxiang";
