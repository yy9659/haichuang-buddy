/**
 * AI 数字员工名册（S4-2，S5 Task81 起客服接入真实链路）
 *
 * 为什么把这份「名册」从 Mock 数据源里搬出来、放到 `src/lib/`：
 *
 * 1. **它不是业务数据，是界面目录**。名称、职责、图标、强调色、能力标签
 *    在这套产品里是**常量**（技术文档第 6 章的 1 + 6 编制），不随商家、不随数据源变化。
 *    把它留在 Mock 仓储里，意味着 `DATA_SOURCE=db` 时这张卡片会因为
 *    「员工状态仓储尚未实现」而整块取不到 —— 而它明明不需要数据库。
 * 2. **`available` 必须有一个权威出处**。它回答的是「这个员工有没有真实的
 *    业务实现」：S4-2 接上了 Product / Brand / Content，S5 Task80/81 接上了客服
 *    （真实会话 + 消息 + RAG + 缺口 + 知识索引），S6-A 接上了直播导演，
 *    S6-B 补上最后一位经营分析师 —— 至此编制 6 / 6 全部接入。
 *    如果「谁上线了」这件事散落在各个组件里判断，早晚会出现
 *    「卡片写着运行中、其实根本没有这个 Agent」的假象。
 *    在这里声明一次，界面只能照着渲染。
 *
 * 与本文件**刻意分开**的两件事（不要在名册里表达）：
 * - 运行时状态（idle / queued / running / completed / failed）：那是 `agent_tasks`
 *   与 `agent_workflows` 的真实数据，由 `services/dashboard.ts` 装配；
 * - 最近任务与最近执行时间：同理。
 * 名册只回答「这个员工是谁、他有哪些能力、他现在能不能真的干活」。
 */

import {
  Brain,
  ChartLine,
  FileText,
  Headphones,
  Megaphone,
  Package,
  Palette,
} from "lucide-react";

import type { AgentAccent, AgentId, IconComponent } from "@/types";

/**
 * AI 员工的静态档案。
 *
 * 与 `AgentEmployee`（S0 的展示模型）的关键差别：**不含任何运行时状态字段**。
 * 旧模型把 `status: "completed"` 直接写在常量里，那是「演示态」，
 * 一旦页面忘记用真实数据覆盖它，就会渲染出一个从未发生过的「已完成」。
 * 把状态字段从类型里拿掉，这个错误在编译期就不可能发生。
 */
export interface AgentProfile {
  id: AgentId;
  /** 员工名称，如「商品经理」 */
  name: string;
  /** 一句话职责 */
  role: string;
  /** 更详细的能力说明 */
  description: string;
  icon: IconComponent;
  /** 视觉强调色（纯展示，无业务语义） */
  accent: AgentAccent;
  /** 能力标签 */
  skills: string[];
  /** 是否为核心 Supervisor（视觉上单独表达） */
  supervisor: boolean;
  /**
   * 是否已接入真实 Agent 能力（S4-2）。
   *
   * `false` 的员工在界面上**必须**显示「待接入」，并且**不得**显示
   * running / completed 这类正在干活的措辞 —— 那会造成假 Agent。
   */
  available: boolean;
  /** `available=false` 时对商家说明白「现在是什么情况」 */
  unavailableNote: string;
}

/**
 * AI 经营大脑（Supervisor）。
 * 它不是计划中的一个执行步骤（不在 `PLANNER_AGENT_WHITELIST` 里），
 * 因此单独导出、不进 `EXECUTOR_AGENT_PROFILES`。
 */
export const BUSINESS_BRAIN_PROFILE: AgentProfile = {
  id: "business_brain",
  name: "AI经营大脑",
  role: "任务规划 · 调度执行",
  description:
    "读懂经营目标，结合现有商品与品牌资产拆解出任务计划，再按依赖关系调度其他 AI 员工执行。",
  icon: Brain,
  accent: "ocean",
  skills: ["目标理解", "任务拆解", "复用判断", "状态跟踪"],
  supervisor: true,
  available: true,
  unavailableNote: "",
};

/**
 * 六个执行型 AI 员工。
 *
 * 顺序即界面展示顺序：前五位是**已接入**的一线员工（技术文档 Module 4 / 5 / 6、
 * S5 的客服、S6-A 的直播导演），最后一位是 S6-B 补上的经营分析师 ——
 * 至此六位全部上线，`available` 全为 `true`。
 */
export const EXECUTOR_AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: "product_agent",
    name: "商品经理",
    role: "商品理解 · 卖点提炼",
    description: "读取商品图片与资料，输出结构化的商品理解，供其他 AI 员工共享。",
    icon: Package,
    accent: "ocean",
    skills: ["多模态分析", "卖点提炼", "风险提示"],
    supervisor: false,
    available: true,
    unavailableNote: "",
  },
  {
    id: "brand_agent",
    name: "品牌经理",
    role: "品牌定位 · 故事策划",
    description: "基于商品理解与老板数字分身，制定品牌定位、Slogan 与品牌故事。",
    icon: Palette,
    accent: "violet",
    skills: ["品牌定位", "人群策略", "IP 概念"],
    supervisor: false,
    available: true,
    unavailableNote: "",
  },
  {
    id: "content_agent",
    name: "内容运营",
    role: "图文视频 · 营销内容",
    description: "按平台调性批量生成短视频脚本、图文笔记与营销文案，落到内容槽位上。",
    icon: FileText,
    accent: "teal",
    skills: ["多平台适配", "脚本撰写", "镜头建议"],
    supervisor: false,
    available: true,
    unavailableNote: "",
  },
  {
    id: "live_agent",
    name: "AI直播导演",
    role: "直播策略 · 主播话术",
    description: "实时分析直播评论，检测热点问题并给主播生成即时建议与异议话术。",
    icon: Megaphone,
    accent: "rose",
    skills: ["评论分类", "热点检测", "异议处理"],
    supervisor: false,
    available: true,
    unavailableNote: "",
  },
  {
    id: "customer_service_agent",
    name: "智能客服",
    role: "知识库 · 智能问答",
    description: "基于商品与售后知识库回答客户咨询，无可靠信息时主动建议转人工。",
    icon: Headphones,
    accent: "emerald",
    skills: ["问题分类", "知识检索", "转人工判断"],
    supervisor: false,
    available: true,
    unavailableNote: "",
  },
  {
    id: "analytics_agent",
    name: "经营分析师",
    role: "数据分析 · 经营复盘",
    description: "读取程序计算的经营指标，完成归因解释与明日行动建议。",
    icon: ChartLine,
    accent: "amber",
    skills: ["指标解释", "问题归因", "行动建议"],
    supervisor: false,
    available: true,
    unavailableNote: "",
  },
];

/** 全部 AI 员工（含 Supervisor） */
export const AGENT_ROSTER: readonly AgentProfile[] = [
  BUSINESS_BRAIN_PROFILE,
  ...EXECUTOR_AGENT_PROFILES,
];

const PROFILE_BY_ID = new Map<AgentId, AgentProfile>(
  AGENT_ROSTER.map((profile) => [profile.id, profile]),
);

/** 按 id 取名册档案；不存在的 id 返回 null（调用方须显式处理，不要瞎猜名字） */
export function getAgentProfile(id: AgentId): AgentProfile | null {
  return PROFILE_BY_ID.get(id) ?? null;
}

/**
 * 已接入真实能力的 Agent id。
 * 界面据此判断「这张卡片能不能显示真实状态」，服务层据此过滤要查库的 Agent。
 */
export const AVAILABLE_AGENT_IDS: readonly AgentId[] = AGENT_ROSTER.filter(
  (profile) => profile.available,
).map((profile) => profile.id);
