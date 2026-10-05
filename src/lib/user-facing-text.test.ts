import { describe, expect, it } from "vitest";

import { sanitizeUserFacingText, toUserFacingPlanText } from "./user-facing-text";

describe("toUserFacingPlanText", () => {
  it("移除布尔内部字段并保留自然中文", () => {
    expect(
      toUserFacingPlanText(
        "商品已有商品理解（hasDna=true），品牌档案已存在（brandProfileExists=true），无需重复分析。",
      ),
    ).toBe("商品已有商品理解，品牌档案已存在，无需重复分析。");
  });

  it("把 Agent 内部标识转换为用户可读名称", () => {
    expect(toUserFacingPlanText("安排一次 content_agent 任务即可完成。"))
      .toBe("安排一次内容运营员工任务即可完成。");
  });
});

describe("sanitizeUserFacingText", () => {
  it("清理复盘模型中的内部字段与英文状态", () => {
    expect(sanitizeUserFacingText("openKnowledgeGaps 为空，状态为 risk，来自 agent_tasks。"))
      .toBe("待补充的顾客问题为空，状态为待处理，来自 AI 工作记录。");
  });
  it("将商品内部字段和 AI 员工 ID 改成商家能读懂的文案", () => {
    expect(sanitizeUserFacingText("检查 product.analyzedProducts 是否更新，再请 content_agent 处理。"))
      .toBe("检查商品档案是否已完善，再请内容运营员工处理。");
  });

  it("未知系统字段也不会直接展示", () => {
    expect(sanitizeUserFacingText("查看 `workflow.internalState`，联系 live_agent。"))
      .toBe("查看相关资料，联系直播导演。");
  });
});
