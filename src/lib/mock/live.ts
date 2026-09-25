import type {
  LiveComment,
  LiveSession,
  LiveStats,
  LiveSuggestion,
  TeleprompterSegment,
} from "@/types";

/** 当前直播场次（Mock） */
export const MOCK_LIVE_SESSION: LiveSession = {
  id: "live_001",
  title: "今晚 19:30 · 连江鲜活鲍鱼专场",
  productId: "prod_001",
  productName: "连江鲜活鲍鱼",
  status: "live",
  startedAt: "2026-09-25 19:30",
  durationText: "00:24:18",
};

export const MOCK_LIVE_STATS: LiveStats = {
  onlineCount: 1286,
  peakOnlineCount: 1642,
  likes: 8420,
  comments: 613,
  questions: 148,
  newFollowers: 96,
  engagementRate: 0.0751,
};

/** 直播间实时评论流（Mock，用于演示 AI 直播导演的输入） */
export const MOCK_LIVE_COMMENTS: LiveComment[] = [
  {
    id: "c_001",
    user: "海味爱好者",
    content: "这个鲍鱼怎么保存？能放几天？",
    createdAtText: "19:52",
    intent: "storage_question",
    priority: "high",
    handled: true,
  },
  {
    id: "c_002",
    user: "小渔儿",
    content: "今晚下单明天能到吗？",
    createdAtText: "19:53",
    intent: "logistics_question",
    priority: "medium",
    handled: true,
  },
  {
    id: "c_003",
    user: "海岸边",
    content: "有礼盒装吗？送人用",
    createdAtText: "19:53",
    intent: "price_question",
    priority: "medium",
    handled: false,
  },
  {
    id: "c_004",
    user: "Linda",
    content: "什么规格发货？够两个人吃吗",
    createdAtText: "19:54",
    intent: "price_question",
    priority: "low",
    handled: false,
  },
  {
    id: "c_005",
    user: "老陈买菜",
    content: "这个价格是活的还是冻的？",
    createdAtText: "19:54",
    intent: "price_question",
    priority: "high",
    handled: false,
  },
  {
    id: "c_006",
    user: "小汤圆",
    content: "老板讲得很实在，先关注了",
    createdAtText: "19:55",
    intent: "praise",
    priority: "low",
    handled: false,
  },
  {
    id: "c_007",
    user: "海边人家",
    content: "收到货死了怎么办？有售后吗",
    createdAtText: "19:55",
    intent: "after_sale",
    priority: "high",
    handled: false,
  },
  {
    id: "c_008",
    user: "厨房新手",
    content: "不会杀鲍鱼，能给个教程吗",
    createdAtText: "19:56",
    intent: "cooking_question",
    priority: "medium",
    handled: false,
  },
];

/** AI 直播导演输出（Mock） */
export const MOCK_LIVE_SUGGESTIONS: LiveSuggestion[] = [
  {
    id: "s_001",
    commentId: "c_001",
    intent: "storage_question",
    priority: "high",
    question: "鲍鱼怎么保存？能放几天？",
    answer:
      "收到后 0-4℃ 冷藏，48 小时内食用最佳；如果不当天吃，可以带壳冷冻，能放 30 天左右，解冻后口感影响不大。",
    hostSuggestion:
      "当前观众对「保存方式」关注度极高。建议立即口播：强调冷藏 48 小时、冷冻 30 天两个数字，并提醒不要提前刷洗。",
    recommendedAction: "explain_storage",
    knowledgeSource: ["商品详情 · 连江鲜活鲍鱼 · 储存方式", "FAQ · 鲜活产品保鲜指引"],
    createdAtText: "19:52",
  },
  {
    id: "s_002",
    commentId: "c_007",
    intent: "after_sale",
    priority: "high",
    question: "收到货死了怎么办？",
    answer:
      "鲜活产品支持签收后 2 小时内拍照报备，核实后按损耗比例赔付，具体以店铺售后规则为准。",
    hostSuggestion:
      "这是影响下单的关键异议。建议主播正面回应，强调「签收 2 小时内拍照报备即可处理」，不要回避。",
    recommendedAction: "handle_objection",
    knowledgeSource: ["售后政策 · 鲜活类商品赔付规则"],
    createdAtText: "19:55",
  },
  {
    id: "s_003",
    commentId: "c_008",
    intent: "cooking_question",
    priority: "medium",
    question: "不会杀鲍鱼，能给个教程吗？",
    answer:
      "先用刷子刷净外壳，用勺子沿壳边撬开取肉，去掉内脏和嘴部，冲洗后即可烹饪，全程不到 1 分钟。",
    hostSuggestion:
      "可以现场演示一次处理过程，能有效降低新手用户的购买门槛。",
    recommendedAction: "demo_processing",
    knowledgeSource: ["烹饪方式 · 鲍鱼处理步骤"],
    createdAtText: "19:56",
  },
  {
    id: "s_004",
    commentId: "c_005",
    intent: "price_question",
    priority: "high",
    question: "这个价格是活的还是冻的？",
    answer: "128 元 / 500g 为鲜活价格，当日现捞发货，非冷冻产品。",
    hostSuggestion:
      "价格敏感问题，建议明确区分鲜活与冷冻，避免用户收货后产生落差。",
    recommendedAction: "clarify_product_type",
    knowledgeSource: ["商品详情 · 连江鲜活鲍鱼 · 规格与发货说明"],
    createdAtText: "19:54",
  },
];

/** 主播提词器 */
export const MOCK_TELEPROMPTER: TeleprompterSegment[] = [
  {
    id: "t_001",
    type: "opening",
    title: "开场 · 产地介绍",
    content:
      "大家晚上好，我是连江的陈老板。今天这批鲍鱼是早上刚从黄岐半岛捞上来的，现在还带着海水味。",
    durationText: "1 分钟",
    status: "done",
  },
  {
    id: "t_002",
    type: "selling-point",
    title: "卖点 · 鲜活与规格",
    content:
      "8-10 头规格，500g 一盒 128 元。当日现捞当日发，不是冷冻货，到手刷一刷就能上锅。",
    durationText: "2 分钟",
    status: "current",
  },
  {
    id: "t_003",
    type: "objection",
    title: "异议 · 保鲜与售后",
    content:
      "担心路上不新鲜？我们发的是顺丰冷链，签收 2 小时内有问题拍照报备，按损耗比例赔付，不让你承担损失。",
    durationText: "1.5 分钟",
    status: "upcoming",
  },
  {
    id: "t_004",
    type: "selling-point",
    title: "卖点 · 家庭烹饪",
    content:
      "不会处理也没关系：刷壳、撬开、去内脏，一分钟搞定。蒜蓉蒸八分钟，孩子老人都能吃。",
    durationText: "2 分钟",
    status: "upcoming",
  },
  {
    id: "t_005",
    type: "cta",
    title: "收单 · 限时福利",
    content:
      "今晚直播间下单加赠紫菜一包，数量有限，拍完为止。想要的直接扣「鲍鱼」，我这边安排优先发货。",
    durationText: "1 分钟",
    status: "upcoming",
  },
];
