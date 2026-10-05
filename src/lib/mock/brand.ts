import type { BrandProfile } from "@/types";

/**
 * 示例品牌档案（**不再是 Mock 的初始值**）。
 *
 * S3-1 起品牌档案由 Brand Agent 真实生成，Mock 仓储的初始状态是 `null`，
 * 界面先进入 empty 态 —— 不预置一份「看着像 AI 产出」的假档案。
 *
 * 这个常量保留下来有两个明确用途：
 * 1. 作为 `computeBrandCompleteness` / `toBrandProfile` 等纯函数与展示组件的**测试 fixture**；
 * 2. 作为文档与演示时「一份完整档案长什么样」的参考样例。
 * 因此它**不应该**被仓储读取，任何恢复「Mock 直接返回它」的改动都会让 empty 态消失。
 */
export const MOCK_BRAND_PROFILE: BrandProfile = {
  positioning: "连江直发 · 家庭海鲜餐桌的一站式供应者",
  targetAudience: ["25-40 岁年轻家庭", "重视食材新鲜度的品质消费者", "节庆礼赠需求人群"],
  brandValues: ["真实可见的产地", "当日现捞的新鲜", "不夸张的表达"],
  brandPersonality: ["亲切", "实在", "专业", "有海边的松弛感"],
  slogan: "从连江的海，到你的餐桌。",
  brandStory:
    "陈老板在连江黄岐半岛长大，家里三代人靠海吃海。过去海产靠批发商收走，价格和故事都由别人讲。现在他决定自己讲：把当日现捞的鲍鱼、海带苗和大黄鱼，用最直白的方式送到家庭餐桌上。海创Buddy 帮他把这套「产地真实、表达不夸张」的经营方式，变成了每天都能执行的完整流程。",
  toneOfVoice: ["口语化", "像邻居介绍一样自然", "专业但不术语化"],
  visualKeywords: ["海雾蓝", "晨光", "渔港", "鲜活质感", "真实生活场景"],
  ipConcept:
    "「陈老板的海边日常」——以老板本人为原型的内容 IP，用渔港日常、分拣现场与家庭烹饪三个场景，持续输出真实可信的品牌形象。",
  riskNotes: ["避免使用「最」「第一」等绝对化用语"],
  aiVersion: "v1.0",
  confidence: 0.72,
  approved: false,
  updatedAt: "2026-09-25 11:03",
  completeness: 0.86,
};
