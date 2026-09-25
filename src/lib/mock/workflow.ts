import type { AgentTask, AgentWorkflow } from "@/types";

/**
 * Agent Workflow（Mock）
 * 对应技术文档第 4 章核心闭环与 15 章 Workflow 设计
 * 本轮仅做 UI 展示，不包含任何执行逻辑。
 */
export const MOCK_WORKFLOW: AgentWorkflow = {
  id: "wf_20260925",
  goal: "准备今晚直播，并提高年轻家庭用户的转化",
  status: "running",
  startedAt: "今日 12:05",
  progress: 0.6,
  activeStageIndex: 3,
  stages: [
    {
      id: "business_brain",
      agentName: "AI经营大脑",
      title: "拆解目标 · 规划任务链",
      status: "completed",
      durationText: "6s",
      outputSummary: "拆解出 5 个任务并分配至 5 个 AI 员工",
    },
    {
      id: "product_agent",
      agentName: "商品经理",
      title: "提炼家庭消费场景卖点",
      status: "completed",
      durationText: "42s",
      outputSummary: "输出 4 个核心卖点、3 个消费场景",
    },
    {
      id: "brand_agent",
      agentName: "品牌经理",
      title: "校准品牌表达与人群语气",
      status: "completed",
      durationText: "36s",
      outputSummary: "确认「真实、不夸张」的表达边界",
    },
    {
      id: "content_agent",
      agentName: "内容运营",
      title: "生成 3 条家庭场景营销内容",
      status: "running",
      durationText: "已执行 58s",
      outputSummary: "已完成 2 / 3 条",
    },
    {
      id: "live_agent",
      agentName: "AI直播导演",
      title: "生成今晚直播策略与主播话术",
      status: "queued",
    },
    {
      id: "analytics_agent",
      agentName: "经营分析师",
      title: "汇总数据并生成经营日报",
      status: "queued",
    },
  ],
};

/** 今日任务列表（Mock） */
export const MOCK_TODAY_TASKS: AgentTask[] = [
  {
    id: "task_001",
    workflowId: "wf_20260925",
    agentType: "product_agent",
    agentName: "商品经理",
    title: "分析商品图片，生成 Product DNA",
    status: "completed",
    timeText: "10:24 完成",
  },
  {
    id: "task_002",
    workflowId: "wf_20260925",
    agentType: "brand_agent",
    agentName: "品牌经理",
    title: "生成品牌定位和故事",
    status: "completed",
    timeText: "11:03 完成",
  },
  {
    id: "task_003",
    workflowId: "wf_20260925",
    agentType: "content_agent",
    agentName: "内容运营",
    title: "生成 3 条家庭场景营销内容",
    status: "running",
    timeText: "已执行 5 分钟",
  },
  {
    id: "task_004",
    workflowId: "wf_20260925",
    agentType: "live_agent",
    agentName: "AI直播导演",
    title: "生成今晚直播策略和主播话术",
    status: "queued",
    timeText: "等待中",
  },
  {
    id: "task_005",
    workflowId: "wf_20260925",
    agentType: "customer_service_agent",
    agentName: "智能客服",
    title: "整理直播前高频问答",
    status: "completed",
    timeText: "09:48 完成",
  },
  {
    id: "task_006",
    workflowId: "wf_20260925",
    agentType: "content_agent",
    agentName: "内容运营",
    title: "生成手工鱼丸短视频脚本",
    status: "failed",
    timeText: "20:10 失败",
  },
];

/** AI 任务通知（顶部栏消息中心，Mock） */
export const MOCK_AGENT_NOTIFICATIONS = [
  {
    id: "notif_001",
    title: "内容运营已完成 2 条家庭场景内容",
    description: "剩余 1 条预计 3 分钟内产出",
    timeText: "3 分钟前",
    read: false,
  },
  {
    id: "notif_002",
    title: "商品经理生成 Product DNA",
    description: "连江鲜活鲍鱼，置信度 92%",
    timeText: "1 小时前",
    read: false,
  },
  {
    id: "notif_003",
    title: "手工鱼丸内容生成失败",
    description: "建议重新执行该任务",
    timeText: "昨天 20:10",
    read: true,
  },
  {
    id: "notif_004",
    title: "智能客服发现 3 条知识缺口",
    description: "发票与运费相关问题需要补充资料",
    timeText: "昨天 18:32",
    read: true,
  },
];
