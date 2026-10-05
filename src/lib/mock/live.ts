/**
 * Mock 直播间种子数据（S6 重写）
 *
 * 与 S0 版的关键差别：**删掉了预置的 AI 导演建议与提词器文案**。
 *
 * 旧的 `MOCK_LIVE_SUGGESTIONS` / `MOCK_TELEPROMPTER` 是「看起来像 AI 产出」的假结果 ——
 * 建议没有经过检索、引用指向不存在的切片，任何人无法验证「AI 是不是真的分析了评论」。
 * 任务书第二十一节明确禁止这种做法（「新输入的评论必须真正经过 Live Agent」）。
 *
 * 现在 Mock 只提供**两侧静态资料**：
 * - **模拟指标**（在线 / 点赞 / 涨粉）：没有真实来源，如实标注为演示数据（§42）；
 * - **初始历史评论**：只有观众昵称与评论原文，**不带任何 AI 分类结果**
 *   （`intent` / `priority` 均为 null）。它们是「观众说过的话」，
 *   而不是「AI 判断过的结论」—— 结论必须由真实链路现场产生。
 */

import type { LiveComment, LiveSession, LiveStats } from "@/types";

/** Demo 直播商品（连江鲜活鲍鱼，与商品种子 prod_001 对齐） */
export const MOCK_LIVE_PRODUCT_ID = "prod_001";
export const MOCK_LIVE_PRODUCT_NAME = "连江鲜活鲍鱼";

/** 初始直播场次（页面与驾驶舱据此展示「正在直播」；用户可随时结束或重开） */
export const MOCK_LIVE_SESSION: LiveSession = {
  id: "live_001",
  title: "今晚 19:30 · 连江鲜活鲍鱼专场",
  productId: MOCK_LIVE_PRODUCT_ID,
  productName: MOCK_LIVE_PRODUCT_NAME,
  status: "live",
  startedAt: "2026-09-25 19:30",
  endedAt: null,
  durationText: "00:24:18",
  commentsCount: 0,
  aiHandledCount: 0,
};

/**
 * 直播间**模拟**指标。
 *
 * 明确标注为演示数据：在线人数 / 点赞 / 涨粉没有真实来源，
 * 绝不与「真实可计算的指标」（评论数 / AI 处理数等）混在一起展示。
 */
export const MOCK_LIVE_STATS: LiveStats = {
  onlineCount: 1286,
  peakOnlineCount: 1642,
  likes: 8420,
  comments: 613,
  questions: 148,
  newFollowers: 96,
  engagementRate: 0.0751,
};

/** 初始历史评论的静态形状（id / 时间戳由 Mock 存储层生成） */
export interface MockLiveSeedComment {
  authorName: string;
  content: string;
}

/**
 * 初始观众评论（**未分析**）。
 *
 * 这些评论覆盖了 Demo 会用到的几类意图，但它们**没有**附带 AI 判断结果 ——
 * 打开页面时右栏是空的，用户点击快捷问题或手动输入后，新评论才真正走
 * Retriever + DashScope 产出建议。这正是「链路是通的」的可观测证据。
 */
export const MOCK_LIVE_SEED_COMMENTS: MockLiveSeedComment[] = [
  { authorName: "海味爱好者", content: "这个鲍鱼怎么保存？能放几天？" },
  { authorName: "小渔儿", content: "今晚下单明天能到吗？" },
  { authorName: "老陈买菜", content: "这个价格是活的还是冻的？" },
  { authorName: "海边人家", content: "收到货死了怎么办？有售后吗" },
  { authorName: "厨房新手", content: "不会杀鲍鱼，能给个教程吗" },
  { authorName: "小汤圆", content: "老板讲得很实在，先关注了" },
];

/**
 * Demo 快捷评论按钮（§41）。
 *
 * 它们**只是帮用户填评论** —— 点击后仍然走
 * `submitLiveComment → Retriever → DashScope → Live Agent`。
 * 绝不与预设 AI 答案绑定。
 */
export const MOCK_LIVE_QUICK_COMMENTS: readonly string[] = [
  "这个鲍鱼怎么保存？",
  "怎么做比较好吃？",
  "今天下单明天能到吗？",
  "感觉有点贵",
  "适合送人吗？",
];

/** 供 Mock 存储层初始化用：把种子评论补全为领域类型 */
export function buildSeedLiveComments(sessionId: string): LiveComment[] {
  return MOCK_LIVE_SEED_COMMENTS.map((seed, index) => ({
    id: `lc_${String(index + 1).padStart(3, "0")}`,
    sessionId,
    authorName: seed.authorName,
    content: seed.content,
    // 未分析：种子评论不带 AI 结论（任务书第二十一节）
    intent: null,
    priority: null,
    handled: false,
    createdAtText: "19:5" + (index % 6),
  }));
}
