/**
 * Business Plan —— Business Brain 的结构化输出契约（S4-1 / 技术文档 Module 6、15 章）
 *
 * 与六位执行 Agent 的契约有一个**根本差别**，值得写在最前面：
 * Product DNA / Brand Profile / Content Asset 都描述「**产物长什么样**」，
 * 而 Business Plan 描述的是「**接下来该做哪几件事**」—— 它不产出任何内容本身。
 * 因此本文件里没有任何正文类字段，只有「任务、执行者、依赖、参数」。
 *
 * 沿用同一套纪律：
 * 1. 所有 AI 输出必须经过本 Schema 校验，失败由 `generateValidatedObject` 回喂一次纠错；
 * 2. 对格式宽容（列表允许写成分隔符字符串、id 允许写成 `task 1`）、对字段缺失严格；
 * 3. **Schema 只管形状，语义规则一律交给 `workflows/plan-validator.ts`**。
 *    为什么刻意这样切：把「content_agent 必须给 platform」写进 Schema 会让同一条规则
 *    在 Schema 与校验器里各存一份，两边迟早说不一样的话。形状与语义分开，
 *    校验器就是唯一的规则出口（也正因如此，「脏计划」的纠错反馈由校验器产生）。
 *
 * 关于白名单：六位一线 Agent 都已接入经营工作流。`business_brain` 仍只负责规划，
 * 不作为执行步骤出现；每一种 Agent 都必须由编排层提供真实的可执行动作。
 */

import { z } from "zod";

import {
  confidenceSchema,
  dedupeStrings,
  normalizeRawList,
  textField,
} from "@/ai/schemas/field-rules";
import { CONTENT_FORMATS, CONTENT_PLATFORMS } from "@/lib/content-options";
import { AGENT_NAME_LABEL } from "@/lib/status-meta";
import { toUserFacingPlanText } from "@/lib/user-facing-text";
import type { ContentFormat, ContentPlatform } from "@/types";

/** Business Plan 的 AI 契约版本号。模型或提示词发生不兼容变更时必须递增 */
export const BUSINESS_PLAN_AI_VERSION = "v2.0";

/**
 * 允许出现在经营计划里的 Agent 白名单。
 *
 * `business_brain` 自己不在白名单里：它是**规划者**，不是被规划的执行步骤
 * —— 允许它出现在计划里等于允许「计划中包含一条『再想一遍』」。
 */
export const PLANNER_AGENT_WHITELIST = [
  "product_agent",
  "brand_agent",
  "content_agent",
  "customer_service_agent",
  "live_agent",
  "analytics_agent",
] as const;

export type PlannerAgentId = (typeof PLANNER_AGENT_WHITELIST)[number];

export function isPlannerAgentId(value: unknown): value is PlannerAgentId {
  return (
    typeof value === "string" &&
    (PLANNER_AGENT_WHITELIST as readonly string[]).includes(value)
  );
}

/** Agent → 展示名。复用数字员工的统一命名，不另起一套叫法 */
export const PLANNER_AGENT_LABEL: Readonly<Record<PlannerAgentId, string>> = {
  product_agent: AGENT_NAME_LABEL.product_agent,
  brand_agent: AGENT_NAME_LABEL.brand_agent,
  content_agent: AGENT_NAME_LABEL.content_agent,
  customer_service_agent: AGENT_NAME_LABEL.customer_service_agent,
  live_agent: AGENT_NAME_LABEL.live_agent,
  analytics_agent: AGENT_NAME_LABEL.analytics_agent,
};

/* ------------------------------------------------------------------ */
/* 限制值                                                              */
/* ------------------------------------------------------------------ */

/** 六 Agent 全链路 + 最多六个投放渠道仍能完整表达；再多通常是在罗列而非排优先级 */
export const MAX_PLAN_TASKS = 12;
const MIN_PLAN_TASKS = 1;
/** 任务 id 上限（它会被别的任务当作引用键，必须短且无歧义） */
const MAX_TASK_ID_LENGTH = 24;
/** 单个任务能声明的前置依赖数 */
const MAX_DEPENDS_ON = 8;
const MAX_TASK_TITLE_LENGTH = 40;
const MAX_TASK_REASON_LENGTH = 120;
/**
 * 计划里 `goal` 字段的长度上限。
 *
 * 导出是为了让「超长输入」这件事**只有一处口径**：`Business Builder` 的输入校验
 * （`agents/business-brain.ts`）用的是 `MAX_BUSINESS_GOAL_LENGTH`，
 * 两者必须满足 `MAX_BUSINESS_GOAL_LENGTH <= MAX_PLAN_GOAL_LENGTH`，
 * 否则 Mock 把整句话原样回填时会撞上这里，商家看到的将是一句
 * 「模型输出格式错误」——而真正的原因是输入太长。
 * 这个不变式由 `business-goal.test.ts` 断言守住，不靠人记。
 */
export const MAX_PLAN_GOAL_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 300;
const MAX_PRODUCT_ID_LENGTH = 64;

/**
 * 任务 id 允许的字符集。
 *
 * 刻意只放行 ASCII：id 是计划内部的**引用键**（`dependsOn` 指向它），
 * 一旦允许任意字符，模型就可能在 `id` 与 `dependsOn` 里写出「看起来一样、
 * 实则不同」的两串字（全角空格、零宽字符），让「依赖是否存在」的判断不可靠。
 * 归一化能救回 `task 1` / `"task-1"` 这类写法，救不回的就触发纠错。
 */
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/* ------------------------------------------------------------------ */
/* 归一化（预处理）                                                     */
/* ------------------------------------------------------------------ */

/** 任务 id 归一：去引号、去首尾空白、把内部空白换成连字符 */
export function normalizeTaskId(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * 依赖列表归一：`undefined` / `null` 一律当成空数组。
 *
 * 「没有前置依赖」是完全正常的语义（第一步任务），因此不该因为模型省略了这个键
 * 或写了 `null` 就判定失败 —— 那会白白消耗一次纠错重试。
 */
function normalizeDependsOn(value: unknown): unknown {
  if (value === undefined || value === null) {
    return [];
  }
  return normalizeRawList(value);
}

/** 可空文本：空串 / 纯空白 / null / undefined 一律归一为 null（「不指定」是合法语义） */
function normalizeOptionalText(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* ------------------------------------------------------------------ */
/* 字段                                                                */
/* ------------------------------------------------------------------ */

const taskIdSchema = z.preprocess(
  normalizeTaskId,
  z
    .string()
    .min(1, "任务 id 不能为空")
    .max(MAX_TASK_ID_LENGTH, `任务 id 不能超过 ${MAX_TASK_ID_LENGTH} 字符`)
    .regex(
      TASK_ID_PATTERN,
      "任务 id 只能使用字母、数字、连字符与下划线（如 task-1）",
    ),
);

const dependsOnSchema = z.preprocess(
  normalizeDependsOn,
  z
    .array(taskIdSchema)
    .max(MAX_DEPENDS_ON, `单个任务最多声明 ${MAX_DEPENDS_ON} 个前置依赖`),
);

/**
 * 可空的商品 id / 平台 / 形态。
 *
 * 三者都用 `.catch(null)` 而不是让校验失败：这些字段的**合法性由校验器判定**
 * （例如「content_agent 缺 platform」会被校验器指出并触发语义纠错），
 * 若这里也报错，模型会在同一轮里收到两条重复的抱怨，反而更容易改歪。
 * `catch(null)` 保证脏值退化成「未指定」，把判断权留给唯一的那处规则。
 */
const optionalProductIdSchema = z
  .preprocess(
    normalizeOptionalText,
    z.string().max(MAX_PRODUCT_ID_LENGTH).nullable(),
  )
  .catch(null);

const optionalPlatformSchema = z
  .preprocess(
    normalizeOptionalText,
    z.enum(CONTENT_PLATFORMS).nullable(),
  )
  .catch(null);

const optionalFormatSchema = z
  .preprocess(normalizeOptionalText, z.enum(CONTENT_FORMATS).nullable())
  .catch(null);

/* ------------------------------------------------------------------ */
/* 契约                                                                */
/* ------------------------------------------------------------------ */

/**
 * 计划里的一个执行步骤。
 *
 * `productId` 对六种 Agent 的含义不同：
 * - `product_agent`：分析**这个**商品（必填，校验器会检查）；
 * - `brand_agent`：以这个商品为素材来源（可空 —— 品牌也可以不绑商品）；
 * - `content_agent`：为这个商品写内容（必填）。
 * - `customer_service_agent`：围绕这个商品做一次知识库客服预演（必填）；
 * - `live_agent`：围绕这个商品做一次直播场控预演（必填）；
 * - `analytics_agent`：生成全店经营报告（不绑定商品）。
 *
 * `platform` / `format` 只对 `content_agent` 有意义，其它 Agent 写了也会在
 * 归一化阶段被清空（见 `normalizeBusinessPlanDraft`）。
 */
export const BusinessPlanTaskSchema = z.object({
  /** 计划内部的任务标识，`dependsOn` 按它引用 */
  id: taskIdSchema,
  /** 执行这个步骤的 Agent（白名单） */
  agent: z.enum(PLANNER_AGENT_WHITELIST),
  /** 一句话说明这一步做什么，如「生成抖音短视频脚本」 */
  title: textField("任务标题", MAX_TASK_TITLE_LENGTH),
  /** 为什么需要这一步 —— 商家要能看懂编排逻辑，而不是被动接受一串任务 */
  reason: textField("安排理由", MAX_TASK_REASON_LENGTH),
  /** 前置任务 id 列表；空数组表示可以立刻开始 */
  dependsOn: dependsOnSchema,
  /** 目标商品 id（必须来自调用时给出的可选商品清单，校验器会检查） */
  productId: optionalProductIdSchema,
  /** 发布平台，仅 `content_agent` 需要 */
  platform: optionalPlatformSchema,
  /** 内容形态，仅 `content_agent` 需要 */
  format: optionalFormatSchema,
});

/** Business Brain 的 AI 输出契约 */
export const BusinessPlanSchema = z.object({
  /** 复述经营目标（确认模型读懂了要做什么，也让落库的计划能独立阅读） */
  goal: textField("经营目标", MAX_PLAN_GOAL_LENGTH),
  /** 规划思路：为什么这样安排、优先级怎么定的 */
  summary: textField("规划思路", MAX_SUMMARY_LENGTH),
  /** 任务清单，按建议执行顺序排列 */
  tasks: z
    .array(BusinessPlanTaskSchema)
    .min(MIN_PLAN_TASKS, `计划至少需要 ${MIN_PLAN_TASKS} 个任务`)
    .max(MAX_PLAN_TASKS, `计划最多 ${MAX_PLAN_TASKS} 个任务`),
  /** 置信度 0 ~ 1 */
  confidence: confidenceSchema,
});

export type BusinessPlanDraft = z.infer<typeof BusinessPlanSchema>;
export type BusinessPlanTaskDraft = z.infer<typeof BusinessPlanTaskSchema>;

/**
 * 落库形态：契约内容 + 版本号。
 * 用 `extend` 派生而不是重新写一遍，保证「能存的」与「能校验的」永远同一份定义
 * —— 读回计划时直接拿它 `safeParse`，不需要另写一套解析规则。
 */
export const StoredBusinessPlanSchema = BusinessPlanSchema.extend({
  version: z.string().trim().min(1),
});

export type StoredBusinessPlan = z.infer<typeof StoredBusinessPlanSchema>;

/** 字段 → 中文标签（嵌套字段用点号路径，与 `formatIssues` 的取值方式一致） */
export const BUSINESS_PLAN_FIELD_LABELS: Readonly<Record<string, string>> = {
  goal: "经营目标",
  summary: "规划思路",
  tasks: "任务清单",
  confidence: "置信度",
  "tasks.id": "任务 id",
  "tasks.agent": "执行 Agent",
  "tasks.title": "任务标题",
  "tasks.reason": "安排理由",
  "tasks.dependsOn": "前置依赖",
  "tasks.productId": "目标商品",
  "tasks.platform": "发布平台",
  "tasks.format": "内容形态",
};

/* ------------------------------------------------------------------ */
/* 归一化与映射                                                        */
/* ------------------------------------------------------------------ */

/**
 * 校验通过后的第二步清理。
 *
 * 只做**格式层**的事，不做语义判断：
 * - 清掉与该任务类型无关的槽位参数（品牌任务带着 `platform: "douyin"`
 *   会让计划读起来自相矛盾，而且没有任何消费者会读它）；
 * - 经营分析是全店级任务，清掉模型误填的 `productId`；
 * - `dependsOn` 去重（重复声明同一个依赖在语义上是同一件事，只是噪声）。
 *
 * **刻意不做的两件事**（都要留给校验器，否则错误会被悄悄抹平）：
 * - 不删自引用依赖、不拆循环依赖；
 * - 不丢弃引用不到的 `productId`。
 * 这三类都是「模型没读懂任务」的信号，该被指出来，而不是修好装作没发生。
 *
 * 任务顺序也原样保留：模型给出的顺序本身就是「它认为的优先级」，
 * 是排查提示词缺陷时最有用的线索之一。
 */
export function normalizeBusinessPlanDraft(
  draft: BusinessPlanDraft,
): BusinessPlanDraft {
  return {
    goal: draft.goal.trim(),
    summary: toUserFacingPlanText(draft.summary),
    tasks: draft.tasks.map((task) => ({
      id: task.id,
      agent: task.agent,
      title: toUserFacingPlanText(task.title),
      reason: toUserFacingPlanText(task.reason),
      dependsOn: dedupeStrings(task.dependsOn),
      productId: task.agent === "analytics_agent" ? null : task.productId,
      platform: task.agent === "content_agent" ? task.platform : null,
      format: task.agent === "content_agent" ? task.format : null,
    })),
    confidence: draft.confidence,
  };
}

/**
 * 契约 → 落库对象（写进 `agent_workflows.plan`）。
 *
 * 返回值是 `type` 而不是 `interface`，且成员全部是 JSON 安全类型，
 * 因此可以直接赋给仓储的 `plan: Record<string, unknown> | null`
 * （interface 缺隐式索引签名，会被 TS 拦下 —— 同 `AgentWorkflowSummary` 的处理）。
 */
export function toStoredBusinessPlan(
  draft: BusinessPlanDraft,
): StoredBusinessPlan {
  return {
    version: BUSINESS_PLAN_AI_VERSION,
    goal: draft.goal,
    summary: draft.summary,
    tasks: draft.tasks.map((task) => ({
      id: task.id,
      agent: task.agent,
      title: task.title,
      reason: task.reason,
      dependsOn: [...task.dependsOn],
      productId: task.productId,
      platform: task.platform as ContentPlatform | null,
      format: task.format as ContentFormat | null,
    })),
    confidence: draft.confidence,
  };
}

/**
 * 从 jsonb 读回计划。
 *
 * 读不出来时返回 `null` 而不是抛错：这条路径有两个调用方（编排层重试、界面展示），
 * 它们面对「计划读不出来」的正确反应是**如实告知**（「该次执行的计划不可读」），
 * 而不是让整页 500。注意这与「静默降级」不同 —— 界面必须把 null 显式表达出来。
 */
export function parseStoredBusinessPlan(
  value: unknown,
): StoredBusinessPlan | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = StoredBusinessPlanSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
