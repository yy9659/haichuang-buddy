/**
 * 结构化输出通道：提取 JSON → Zod 校验 → 失败回喂一次纠错
 *
 * 为什么需要这一层（技术文档 21 章 / 37 章开发纪律）：
 * - 模型输出天然不可信：可能包着 Markdown 代码围栏、前后带解释文字、缺字段、类型不对。
 * - 直接 `JSON.parse` 会让脏输出变成 500 白屏，而不是「一条可重试的错误」。
 * - 因此统一在这里收敛：**解析失败 / 校验失败都要能自愈一次，仍失败则给出明确错误**。
 *
 * 所有 Agent 共用本模块，避免每个 Agent 各写一套 JSON 兜底。
 */

import type { ZodType } from "zod";

import { formatIssues, type FieldLabelMap } from "@/lib/validation";
import { attempt, fail, ok, toAppError, type Result } from "@/lib/result";

import { SCHEMA_REPAIR_ATTEMPTS, type AIProvider, type ModelTier } from "@/ai/provider/types";

/** 单条错误摘要的最大长度，避免把整份脏输出塞进错误详情 */
const MAX_DETAIL_LENGTH = 800;

function clip(text: string, limit = MAX_DETAIL_LENGTH): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}…（已截断）`;
}

/** Markdown 代码围栏：```json ... ``` 或 ``` ... ``` */
const FENCED_BLOCK = /```(?:json|JSON)?\s*([\s\S]*?)```/;

/**
 * 从任意文本中扫出第一个**括号配平**的 JSON 对象。
 * 需要自己扫而不是正则，是因为字符串字面量里的 `{}` 会骗过简单计数。
 */
function findBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

/**
 * 从模型原始输出里提取 JSON 文本。
 * 优先取代码围栏内的内容，其次在全文里找第一个配平对象。
 */
export function extractJsonObject(raw: string): string | null {
  if (!raw) {
    return null;
  }
  const text = raw.trim();

  const fenced = FENCED_BLOCK.exec(text);
  const fencedBody = fenced?.[1]?.trim();
  if (fencedBody) {
    const balanced = findBalancedObject(fencedBody);
    if (balanced) {
      return balanced;
    }
    if (fencedBody.startsWith("{")) {
      return fencedBody;
    }
  }

  return findBalancedObject(text);
}

/**
 * 解析并校验模型输出。
 * @param labels 字段 → 中文标签，让错误信息变成「核心卖点至少需要 1 条」这种可读提示
 */
export function parseAgentObject<T>(
  raw: string,
  schema: ZodType<T>,
  labels?: FieldLabelMap,
): Result<T> {
  const json = extractJsonObject(raw);
  if (!json) {
    return fail(
      "SCHEMA_INVALID",
      "模型没有返回可解析的 JSON 结构",
      `原始输出：${clip(raw)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return fail(
      "SCHEMA_INVALID",
      "模型返回的 JSON 无法解析",
      `原因：${reason}；原文：${clip(json)}`,
    );
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return fail(
      "SCHEMA_INVALID",
      "模型输出不符合约定结构",
      formatIssues(validated.error, labels),
    );
  }

  return ok(validated.data);
}

/**
 * 组装纠错提示：把 Zod 的具体错误和上一版输出一起回喂，
 * 比单纯说「重试一次」有效得多（模型能定位到是哪个键写错了）。
 *
 * ⚠️ 调用方必须把本段**追加在原提示词之后**，不要替换原文 ——
 * 否则模型会丢掉商品上下文，只能对着错误信息凭空重写。
 */
export function buildSchemaRepairPrompt(input: {
  previousOutput: string;
  issues: string;
  requiredKeys?: readonly string[];
  repairGuidance?: string;
  previousOutputLimit?: number;
}): string {
  const keys = input.requiredKeys?.length
    ? `\n必须包含的键：${input.requiredKeys.join("、")}`
    : "";

  return [
    "上一次的输出没有通过结构校验，请**只返回修正后的 JSON**，不要任何解释、不要 Markdown 代码围栏。",
    `校验错误：${input.issues}${keys}`,
    ...(input.repairGuidance ? [input.repairGuidance] : []),
    "",
    "上一次的输出如下（仅用于定位问题，不要复述）：",
    "<<<PREVIOUS_OUTPUT>>>",
    clip(input.previousOutput, input.previousOutputLimit ?? MAX_DETAIL_LENGTH),
    "<<<END_PREVIOUS_OUTPUT>>>",
  ].join("\n");
}

/** 结构化生成的结果，附带可观测性信息（后续写入 agent_tasks 的耗时/重试次数） */
export interface ValidatedObjectOutcome<T> {
  value: T;
  /** 实际调用模型的次数 */
  attempts: number;
  /** 是否经过纠错重试才成功 */
  repaired: boolean;
  /** 失败尝试的错误摘要，便于排查提示词缺陷 */
  repairNotes: string[];
}

export interface ValidatedGenerationInput<T> {
  provider: AIProvider;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  tier?: ModelTier;
  /** 总尝试次数（含首次），默认「首次 + 纠错 1 次」 */
  maxAttempts?: number;
  labels?: FieldLabelMap;
  /** 纠错提示里要强调的键名清单 */
  requiredKeys?: readonly string[];
  /** 按具体校验错误补充修复指令，避免模型把已正确的字段整份重写 */
  repairGuidance?: (issue: string) => string | null;
  /** 长报告纠错需要保留末尾字段；与日志摘要的截断长度分开。 */
  repairOutputLimit?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * 一次完整的结构化生成：调用 → 校验 → 失败则回喂纠错 → 再校验。
 *
 * 契约（**纠错重试的边界必须写死在这里，不能靠调用方自觉**）：
 *
 * 1. **只有 `SCHEMA_INVALID` 才触发纠错重试。** 也就是说，只有「模型 HTTP 调用
 *    成功、但返回的内容提取不出 JSON / 不符合结构」这一类失败才值得再问一次 ——
 *    因为再问一次真的可能变好。
 * 2. **模型调用本身失败一律直接透传，绝不重试。** 超时、连接中断、401 / 403、
 *    429 限流、配额耗尽、模型不存在，这些再问一次结果只会一样（或者更糟：
 *    白烧掉一次配额）。错误码由 Provider 层归一化后带上来，这里原样交给上层，
 *    由上层决定是「报错给用户」还是「按业务降级」。
 * 3. 用尽尝试次数后返回 `SCHEMA_INVALID`，detail 里保留最后一次的具体错误。
 *
 * `maxAttempts` 是**总尝试次数（含首次）**，默认「首次 + 纠错 1 次」。
 * 直播这类交互场景需要更高的自愈率时会显式放大（见 `LIVE_SCHEMA_ATTEMPTS`），
 * 但放大只作用于第 1 类失败 —— 它永远不会把 429 变成 3 次 429。
 */
export async function generateValidatedObject<T>(
  input: ValidatedGenerationInput<T>,
): Promise<Result<ValidatedObjectOutcome<T>>> {
  const totalAttempts = Math.max(
    1,
    input.maxAttempts ?? SCHEMA_REPAIR_ATTEMPTS + 1,
  );

  const repairNotes: string[] = [];
  let prompt = input.prompt;

  for (let attemptIndex = 1; attemptIndex <= totalAttempts; attemptIndex += 1) {
    const generated = await attempt(
      () =>
        input.provider.generateText({
          system: input.system,
          prompt,
          tier: input.tier,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          signal: input.signal,
        }),
      (cause) => toAppError(cause, "MODEL_UNAVAILABLE", "模型服务调用失败"),
    );

    /**
     * 传输 / 鉴权 / 限流类失败：**立即返回，不做结构 repair**。
     * 这条分支的顺序很关键 —— 它必须在解析之前，否则「模型没应答」会被
     * 误判成「模型答得不合结构」，从而对同一个坏网关连问三次。
     */
    if (!generated.ok) {
      return { ok: false, error: generated.error };
    }

    const parsed = parseAgentObject(generated.data, input.schema, input.labels);
    if (parsed.ok) {
      return ok({
        value: parsed.data,
        attempts: attemptIndex,
        repaired: attemptIndex > 1,
        repairNotes,
      });
    }

    /**
     * 防御性判定：只有结构校验失败才继续走纠错。
     * `parseAgentObject` 目前只会返回 `SCHEMA_INVALID`，但把它写出来是有意的 ——
     * 将来若它开始返回别的错误码（例如内容安全拦截），这里会自然停手，
     * 而不是把一次「不该重试的失败」重复问三遍。
     */
    if (parsed.error.code !== "SCHEMA_INVALID") {
      return { ok: false, error: parsed.error };
    }

    const issue = parsed.error.detail ?? parsed.error.message;
    repairNotes.push(issue);

    if (attemptIndex === totalAttempts) {
      return {
        ok: false,
        error: {
          ...parsed.error,
          message: `模型输出连续 ${totalAttempts} 次未通过结构校验`,
          detail: issue,
        },
      };
    }

    prompt = [
      input.prompt,
      "",
      buildSchemaRepairPrompt({
        previousOutput: generated.data,
        issues: issue,
        requiredKeys: input.requiredKeys,
        repairGuidance: input.repairGuidance?.(issue) ?? undefined,
        previousOutputLimit: input.repairOutputLimit,
      }),
    ].join("\n");
  }

  // 循环必然在内部 return；此处仅为满足类型完备性
  return fail("SCHEMA_INVALID", "模型输出未通过结构校验");
}
