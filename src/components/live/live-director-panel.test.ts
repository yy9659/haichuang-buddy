import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/actions/live", () => ({ retryLiveCommentAction: vi.fn() }));

import { LiveDirectorPanel } from "./live-director-panel";
import type { LiveSuggestion } from "@/types";

it("默认打开回答建议页签，而不是把建议 ID 当页签值", () => {
  const html = renderToStaticMarkup(
    createElement(LiveDirectorPanel, { suggestions: [], hotTopics: [] }),
  );

  expect(html).toContain("暂无 AI 建议");
});

it("失败问题提供重新分析入口，明确无需重复录入", () => {
  const suggestion: LiveSuggestion = {
    id: "failed_suggestion", commentId: "saved_comment", commentContent: "收到鱼丸后怎么保存？",
    intent: "other", priority: "low", shouldRespond: false, responseMode: "ignore",
    hostSuggestion: "", suggestedReply: "", sellingAngle: null, grounded: false,
    citations: [], recommendedAction: "ignore", riskNotes: [], confidence: 0,
    durationMs: 1, createdAtText: "18:02", failureMessage: "向量化服务暂时不可用，请稍后重试",
  };
  const html = renderToStaticMarkup(createElement(LiveDirectorPanel, { suggestions: [suggestion], hotTopics: [] }));
  expect(html).toContain("重新分析");
  expect(html).toContain("无需重复录入");
  expect(html).toContain(suggestion.failureMessage);
  expect(html).toContain("0 条高优先级");
});
