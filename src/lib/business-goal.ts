/**
 * 经营目标组装（S4-2）
 *
 * 驾驶舱的「启动今日经营」让商家填三样东西：一句目标、主推商品、目标渠道
 * （都可选地补一句目标人群）。但 Business Brain 接收的是**一句**经营目标，
 * 因此这里负责把它们组装成一句人话。
 *
 * 为什么组装放在 `src/lib/` 而不是服务层：
 * 对话框是**客户端组件**，它要在输入时就实时预览「最终会交给 AI 的那句话」，
 * 并据此拦住超长的组合。若把这段逻辑放在 `services/business-brain.service.ts`，
 * 客户端一 import 就会把整个 AI 层（Provider、Zod、数据库连接）打进浏览器包。
 * 纯字符串处理没有任何服务端依赖，放在 lib 层两边共用同一份实现 ——
 * 也因此「界面上看到的」与「真正发给模型的」不可能不一致。
 *
 * 三条纪律：
 * 1. **不做静默截断**。组合超长时返回 `tooLong`，由界面明确告诉商家去精简，
 *    而不是偷偷截掉半句话 —— 被截掉的那半句很可能正是「今晚」「年轻家庭」这类
 *    决定计划方案的关键限定词。
 * 2. **不猜**。渠道清单就是真实支持的六个内容平台（见 `CONTENT_PLATFORMS`），
 *    界面不展示任何尚未实现的能力。
 * 3. **长度上限与 AI 契约对齐**。`BusinessPlanSchema.goal` 的上限是 120 字，
 *    这里必须比它更严 —— 否则 Mock Provider 会把整句话原样回填进计划，
 *    然后被契约拦下，商家看到的将是一个毫无道理的「模型输出格式错误」。
 */

import { CONTENT_FORMAT_LABEL, CONTENT_PLATFORM_LABEL } from "@/lib/status-meta";
import type { ContentFormat, ContentPlatform } from "@/types";

/**
 * 组合后的经营目标长度上限。
 *
 * 定为 120 是被契约倒逼的：`BusinessPlanSchema.goal` 用的是同一个 120
 * （计划里的 `goal` 是模型对目标的**复述**，不能比原文还长）。
 * 取同一个数而不是留一点余量，是为了让校验只有一处口径 ——
 * 这里放行、那里报错是最难向商家解释的一类失败。
 */
export const MAX_BUSINESS_GOAL_LENGTH = 120;

/**
 * 一个「渠道」= 平台 × 内容形态。
 *
 * 为什么成对定义而不是让商家分别选平台和形态：商家想的是「发个抖音」，
 * 不是「douyin + short-video」。形态跟着平台走是**行业常识**（抖音就是短视频、
 * 朋友圈就是海报文案），让用户自己配只会配出「朋友圈 × 短视频脚本」这种
 * 现实中不存在的组合。需要更细的控制时，去内容工厂单独生成 —— 那里才是
 * 平台与形态自由组合的地方。
 */
export interface BusinessGoalChannel {
  platform: ContentPlatform;
  format: ContentFormat;
  /** 平台展示名，如「抖音」 */
  label: string;
  /** 形态展示名，如「短视频脚本」 */
  formatLabel: string;
}

/** 渠道的默认形态（平台 → 最常见的形态） */
const DEFAULT_FORMAT_BY_PLATFORM: Readonly<Record<ContentPlatform, ContentFormat>> =
  {
    douyin: "short-video",
    xiaohongshu: "article",
    wechat: "poster-copy",
    shipinhao: "short-video",
    /** 商品详情页以图文为主（短视频在详情页会被自动播放打断阅读） */
    detail: "article",
    /** 投放素材以海报文案为主（素材位尺寸由平台决定，文案是可复用的那一层） */
    ads: "poster-copy",
  };

/**
 * 第一版开放的渠道清单。
 *
 * 顺序即界面展示顺序：前四个是商家日常真正会用的投放位，
 * 后两个（商品详情 / 广告投放）是站内物料，排在后面。
 * 这份清单**只能**包含 `CONTENT_PLATFORMS` 里的平台 —— 有 `satisfies` 兜底。
 */
export const BUSINESS_GOAL_CHANNELS: readonly BusinessGoalChannel[] = (
  [
    "douyin",
    "xiaohongshu",
    "wechat",
    "shipinhao",
    "detail",
    "ads",
  ] as const satisfies readonly ContentPlatform[]
).map((platform) => {
  const format = DEFAULT_FORMAT_BY_PLATFORM[platform];
  return {
    platform,
    format,
    label: CONTENT_PLATFORM_LABEL[platform],
    formatLabel: CONTENT_FORMAT_LABEL[format],
  } satisfies BusinessGoalChannel;
});

export function isBusinessGoalChannel(value: string): boolean {
  return BUSINESS_GOAL_CHANNELS.some((channel) => channel.platform === value);
}

/**
 * 把界面上的平台勾选（字符串数组，来自表单）解析成渠道对象。
 *
 * 未知平台上抛错也不静默丢弃，而是**明确忽略**并返回已识别的部分：
 * 这是从表单来的输入，前端已被下拉 / 勾选约束，出现未知值说明是伪造请求或
 * 前后端不同步，丢掉比报错更安全（报错会让整次规划失败，而商家什么都没做错）。
 */
export function resolveBusinessGoalChannels(
  platforms: readonly string[] | undefined,
): BusinessGoalChannel[] {
  if (!platforms || platforms.length === 0) {
    return [];
  }
  const wanted = new Set(platforms);
  return BUSINESS_GOAL_CHANNELS.filter((channel) => wanted.has(channel.platform));
}

export interface BusinessGoalInput {
  /** 商家的原话 */
  goal: string;
  /** 主推商品名（不是 id —— 这句话是要给模型读的） */
  productName?: string | null;
  /** 目标人群，可选 */
  targetAudience?: string | null;
  /** 选中的渠道；空数组表示「没特别指定」 */
  channels?: readonly BusinessGoalChannel[];
  /** 用户在工作台明确选择的协同范围，需出现在保存的目标中。 */
  fullChain?: boolean;
}

export interface BusinessGoalDraft {
  /** 组装后的最终文本；超长时仍然返回它，便于界面显示实际长度 */
  text: string;
  /** 字符数 */
  length: number;
  /** 超出上限 —— 界面必须据此拦住提交并说明原因 */
  tooLong: boolean;
  /** 是否包含了人群 / 渠道等补充信息（界面据此决定是否提示「已附带」） */
  enriched: boolean;
}

/** 渠道列表 → 「抖音短视频、朋友圈海报文案」 */
function renderChannelList(channels: readonly BusinessGoalChannel[]): string {
  return channels
    .map((channel) => `${channel.label}${channel.formatLabel}`)
    .join("、");
}

/**
 * 组装经营目标（确定性纯函数）。
 *
 * 输出形如：
 *   `为今晚的年轻家庭用户准备推广内容（主推商品：连江鲜活鲍鱼；目标用户：年轻家庭；渠道：抖音短视频脚本、朋友圈海报文案）`
 *
 * 为什么用「（）」把补充信息括在句尾，而不是写成几个句子：
 * 目标是**给模型读的一句话**，补充信息放括号里能让模型清楚区分
 * 「商家的诉求」与「结构化限定条件」。写成多句会让模型以为有好几个目标，
 * 进而拆出多余的任务（例如为「目标用户」单独安排一场分析）。
 */
export function buildBusinessGoalText(input: BusinessGoalInput): BusinessGoalDraft {
  const goal = input.goal.trim();
  const productName = input.productName?.trim() ?? "";
  const targetAudience = input.targetAudience?.trim() ?? "";
  const channels = input.channels ?? [];

  const details: string[] = [];
  if (productName) {
    details.push(`主推商品：${productName}`);
  }
  if (targetAudience) {
    details.push(`目标用户：${targetAudience}`);
  }
  if (channels.length > 0) {
    details.push(`渠道：${renderChannelList(channels)}`);
  }
  if (input.fullChain && !/六岗位|六\s*Agent|全链路/i.test(goal)) {
    details.push("协同方式：六岗位全链路");
  }

  const text = details.length > 0 ? `${goal}（${details.join("；")}）` : goal;

  return {
    text,
    length: text.length,
    tooLong: text.length > MAX_BUSINESS_GOAL_LENGTH,
    enriched: details.length > 0,
  };
}
