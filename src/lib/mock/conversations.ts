import type {
  ChatMessage,
  CustomerConversation,
  KnowledgeGap,
  KnowledgeSource,
} from "@/types";

/** 知识库片段（Mock，用于展示引用来源） */
export const MOCK_KNOWLEDGE_SOURCES: KnowledgeSource[] = [
  {
    id: "kb_001",
    title: "连江鲜活鲍鱼 · 储存方式",
    type: "storage",
    snippet:
      "收到后 0-4℃ 冷藏保存，建议 48 小时内食用；如需延长保存可带壳冷冻，冷冻 30 天内食用口感影响较小。",
    score: 0.94,
  },
  {
    id: "kb_002",
    title: "鲜活类商品赔付规则",
    type: "after-sale",
    snippet:
      "鲜活类商品签收后 2 小时内可凭开箱视频或照片报备，核实后按实际损耗比例赔付；超时未报备不再受理。",
    score: 0.91,
  },
  {
    id: "kb_003",
    title: "顺丰冷链发货时效说明",
    type: "logistics",
    snippet:
      "每日 16:00 前下单当日发出，福建省内次日达，华东华南次日或隔日达，偏远地区顺延 1-2 天。",
    score: 0.87,
  },
  {
    id: "kb_004",
    title: "鲍鱼处理与烹饪方式",
    type: "cooking",
    snippet:
      "刷净外壳后用勺沿壳边撬开取肉，去除内脏与嘴部，冲洗后即可烹饪；8-10 头规格水开后蒸 8 分钟最佳。",
    score: 0.83,
  },
  {
    id: "kb_005",
    title: "连江产地与品牌故事",
    type: "brand",
    snippet:
      "连江黄岐半岛位于闽江口外，冷水海域养分充足，海水交换快，出产的鲍鱼肉质厚实、口感弹牙。",
    score: 0.79,
  },
];

export const MOCK_CONVERSATIONS: CustomerConversation[] = [
  {
    id: "conv_001",
    customerName: "海味爱好者",
    customerLabel: "抖音 · 老客",
    channel: "douyin",
    lastMessage: "那我今天下单，明天能到吗？",
    updatedAtText: "2 分钟前",
    unreadCount: 2,
    status: "bot",
    tags: ["高意向", "关注保存方式"],
  },
  {
    id: "conv_002",
    customerName: "小汤圆",
    customerLabel: "视频号 · 新客",
    channel: "shipinhao",
    lastMessage: "礼盒装适合送长辈吗？",
    updatedAtText: "9 分钟前",
    unreadCount: 1,
    status: "human",
    tags: ["礼赠需求", "需人工确认"],
  },
  {
    id: "conv_003",
    customerName: "老陈买菜",
    customerLabel: "微信 · 老客",
    channel: "wechat",
    lastMessage: "收到了，很新鲜，谢谢老板",
    updatedAtText: "26 分钟前",
    unreadCount: 0,
    status: "closed",
    tags: ["复购客户"],
  },
  {
    id: "conv_004",
    customerName: "厨房新手",
    customerLabel: "抖音 · 新客",
    channel: "douyin",
    lastMessage: "不会处理鲍鱼怎么办？",
    updatedAtText: "38 分钟前",
    unreadCount: 0,
    status: "bot",
    tags: ["新手用户", "需教学"],
  },
  {
    id: "conv_005",
    customerName: "海边人家",
    customerLabel: "抖音 · 新客",
    channel: "douyin",
    lastMessage: "如果路上死了算谁的？",
    updatedAtText: "1 小时前",
    unreadCount: 3,
    status: "human",
    tags: ["售后异议", "高优先级"],
  },
  {
    id: "conv_006",
    customerName: "Linda",
    customerLabel: "门店 · 熟客",
    channel: "store",
    lastMessage: "帮我留两盒，周六来拿",
    updatedAtText: "2 小时前",
    unreadCount: 0,
    status: "closed",
    tags: ["门店自提"],
  },
];

/** 会话消息（Mock，含 RAG 引用来源） */
export const MOCK_CHAT_MESSAGES: Record<string, ChatMessage[]> = {
  conv_001: [
    {
      id: "m_001",
      conversationId: "conv_001",
      role: "customer",
      content: "主播说今天现捞的，怎么保存比较好？",
      createdAtText: "19:52",
    },
    {
      id: "m_002",
      conversationId: "conv_001",
      role: "agent",
      content:
        "收到后建议 0-4℃ 冷藏，48 小时内吃完口感最好。如果这两天吃不完，可以带壳直接冷冻，能放 30 天左右，解冻后口感影响不大。注意不要提前刷洗再冷藏，容易影响鲜活度。",
      createdAtText: "19:52",
      confidence: 0.94,
      knowledgeSources: [MOCK_KNOWLEDGE_SOURCES[0]],
    },
    {
      id: "m_003",
      conversationId: "conv_001",
      role: "customer",
      content: "那我今天下单，明天能到吗？",
      createdAtText: "19:54",
    },
    {
      id: "m_004",
      conversationId: "conv_001",
      role: "agent",
      content:
        "每日 16:00 前下单当天发出，福建省内一般次日送达；如果您在华东或华南地区，通常是次日到隔日。现在是 19:54，会安排明天 16:00 前发出。",
      createdAtText: "19:54",
      confidence: 0.87,
      knowledgeSources: [MOCK_KNOWLEDGE_SOURCES[2]],
    },
  ],
  conv_002: [
    {
      id: "m_101",
      conversationId: "conv_002",
      role: "customer",
      content: "礼盒装适合送长辈吗？",
      createdAtText: "20:11",
    },
    {
      id: "m_102",
      conversationId: "conv_002",
      role: "agent",
      content:
        "礼盒装是 2.5kg、4-6 人份，含鲍鱼、干贝、花胶，开盖加热就能上桌，送礼比较体面。不过礼盒的具体配送时间和发票信息我这边没有可靠资料，建议转人工帮您确认。",
      createdAtText: "20:11",
      confidence: 0.52,
      knowledgeSources: [MOCK_KNOWLEDGE_SOURCES[4]],
      needsHuman: true,
    },
  ],
  conv_003: [
    {
      id: "m_201",
      conversationId: "conv_003",
      role: "customer",
      content: "收到了，很新鲜，谢谢老板",
      createdAtText: "19:30",
    },
    {
      id: "m_202",
      conversationId: "conv_003",
      role: "agent",
      content:
        "谢谢陈哥支持！下次想吃的时候提前一天说，我这边给你留当天现捞的。",
      createdAtText: "19:31",
      confidence: 0.9,
      knowledgeSources: [MOCK_KNOWLEDGE_SOURCES[4]],
    },
  ],
  conv_004: [
    {
      id: "m_301",
      conversationId: "conv_004",
      role: "customer",
      content: "不会处理鲍鱼怎么办？",
      createdAtText: "19:16",
    },
    {
      id: "m_302",
      conversationId: "conv_004",
      role: "agent",
      content:
        "别担心，处理很简单：先用刷子把外壳刷干净，用勺子沿壳边撬开取肉，去掉内脏和嘴部，冲洗一下就能下锅，全程不到一分钟。8-10 头规格水开后蒸 8 分钟口感最好。",
      createdAtText: "19:16",
      confidence: 0.83,
      knowledgeSources: [MOCK_KNOWLEDGE_SOURCES[3]],
    },
  ],
  conv_005: [
    {
      id: "m_401",
      conversationId: "conv_005",
      role: "customer",
      content: "如果路上死了算谁的？",
      createdAtText: "18:55",
    },
    {
      id: "m_402",
      conversationId: "conv_005",
      role: "agent",
      content:
        "鲜活类商品签收后 2 小时内，您可以拍开箱视频或照片联系我们，核实后按实际损耗比例赔付。超过 2 小时未报备的话就不再受理了，所以收到货请尽快查看。",
      createdAtText: "18:55",
      confidence: 0.91,
      knowledgeSources: [MOCK_KNOWLEDGE_SOURCES[1]],
    },
  ],
  conv_006: [
    {
      id: "m_501",
      conversationId: "conv_006",
      role: "customer",
      content: "帮我留两盒，周六来拿",
      createdAtText: "17:40",
    },
    {
      id: "m_502",
      conversationId: "conv_006",
      role: "agent",
      content: "好的，已经帮您登记周六到店自提两盒，到货后会先给您留出。",
      createdAtText: "17:41",
      confidence: 0.88,
    },
  ],
};

/** 知识库缺失提醒（Mock） */
export const MOCK_KNOWLEDGE_GAPS: KnowledgeGap[] = [
  {
    id: "gap_001",
    question: "礼盒装能否开发票？开票时间多久？",
    askedCount: 12,
    suggestion: "建议补充「发票与开票时效」知识文档，可显著降低转人工比例。",
  },
  {
    id: "gap_002",
    question: "福建以外偏远地区是否包邮？",
    askedCount: 9,
    suggestion: "建议补充「运费与包邮范围」说明，避免客户反复询问。",
  },
  {
    id: "gap_003",
    question: "鲍鱼是否可以代客处理后再发货？",
    askedCount: 6,
    suggestion: "当前无相关服务说明，建议由人工确认后再补充知识库。",
  },
];
