/** 商家可见的 AI 员工名称，内部 ID 不直接进入页面文案。 */
export const AgentNameMap: Readonly<Record<string, string>> = {
  product_agent: "商品经理",
  brand_agent: "品牌经理",
  content_agent: "内容运营员工",
  customer_service_agent: "智能客服",
  live_agent: "直播导演",
  analytics_agent: "经营分析",
  business_brain: "AI经营大脑",
};

const FIELD_NAME_MAP: Readonly<Record<string, string>> = {
  "product.analyzedProducts": "已完善的商品档案",
  "product.totalProducts": "商品总数",
  "product.analysisCompletionRate": "商品档案完善率",
  "content.generatedToday": "今日生成的内容",
  "customerService.groundedRate": "客服回答可靠率",
  "customerService.openKnowledgeGapCount": "待补充的客服资料",
  "agents.failedTasks": "未完成的 AI 工作",
  "workflow.completionRate": "工作计划完成情况",
};

/** 报告自由文本进入界面前的最后一道文案清洗。未知内部路径也不会原样显示。 */
export function sanitizeUserFacingText(value: string): string {
  return value
    .replace(/检查\s*[`“"]?product\.analyzedProducts[`”"]?\s*是否更新/gi, "检查商品档案是否已完善")
    .replace(/\bopenKnowledgeGaps\b/gi, "待补充的顾客问题")
    .replace(/\bagent_tasks\b/gi, "AI 工作记录")
    .replace(/\brisk\b/gi, "待处理")
    .replace(/\b[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+\b/g, (field) => FIELD_NAME_MAP[field] ?? "相关资料")
    .replace(/\b(?:[A-Za-z][A-Za-z0-9_]*_agent|business_brain)\b/gi, (agent) => AgentNameMap[agent.toLowerCase()] ?? "AI 员工")
    .replace(/`/g, "")
    .replace(/([\u3400-\u9fff]) +(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 清理模型偶尔写进用户文案的内部字段与程序标识。
 * 结构化字段仍完整保留在计划对象中，只是不直接暴露在界面上。
 */
export function toUserFacingPlanText(value: string): string {
  let text = value.trim();

  for (const [internalName, label] of Object.entries(AgentNameMap)) {
    text = text.replace(
      new RegExp(`\\s*\\b${internalName}\\b\\s*`, "g"),
      label,
    );
  }

  text = text
    .replace(/Product\s*DNA/gi, "商品理解")
    .replace(
      /[（(]\s*[A-Za-z][A-Za-z0-9_.-]*\s*=\s*(?:true|false|null)\s*[）)]/gi,
      "",
    )
    .replace(
      /\b[A-Za-z][A-Za-z0-9_.-]*\s*=\s*(?:true|false|null)\b/gi,
      "",
    )
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]+([，。；：！？])/g, "$1")
    .replace(/([，；、])\s*\1+/g, "$1")
    .replace(/，\s*[。；]/g, "。")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text;
}
