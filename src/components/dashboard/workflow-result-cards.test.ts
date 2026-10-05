import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LiveStepView } from "@/lib/workflow-display";

import { WorkflowResultCards } from "./workflow-result-cards";

function liveStep(
  agent: LiveStepView["agent"],
  status: LiveStepView["displayStatus"],
): LiveStepView {
  return {
    taskId: "task-1",
    agent,
    agentName: agent === "live_agent" ? "AI直播导演" : "经营分析师",
    title: "本轮预演",
    reason: "测试结果卡片状态",
    displayStatus: status,
    outcome: status === "not_run" ? "skipped" : "executed",
    liveStatus: null,
    note: status === "not_run" ? "上游任务失败，本步未执行。" : null,
    blockedByTitles: status === "not_run" ? ["生成内容"] : [],
    outputRef: null,
    durationMs: 0,
    productId: null,
    platform: null,
    format: null,
  };
}

describe("WorkflowResultCards", () => {
  it("未执行岗位不能显示成功标记或不存在的产出入口", () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowResultCards, { steps: [liveStep("live_agent", "not_run")] }),
    );

    expect(html).toContain('aria-label="未执行"');
    expect(html).toContain("本步未能完成");
    expect(html).not.toContain("查看直播建议");
    expect(html).not.toContain("text-success");
  });

  it("真正完成的岗位仍可查看产出", () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowResultCards, { steps: [liveStep("analytics_agent", "executed")] }),
    );

    expect(html).toContain('aria-label="已完成"');
    expect(html).toContain("查看经营报告");
  });
});
