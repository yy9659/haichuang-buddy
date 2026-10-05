import { describe, expect, it } from "vitest";
import { salesReviewErrorMessage } from "./sales-review-error";

describe("销售建议失败提示", () => {
  it("截图中的结构校验错误用商户能理解的文案解释，且保留失败状态", () => {
    const message = salesReviewErrorMessage({ code: "SCHEMA_INVALID", message: "模型输出连续 2 次未通过结构校验" });
    expect(message).toContain("没有核对通过");
    expect(message).toContain("上次已保存的建议仍然保留");
    expect(message).not.toMatch(/结构校验|salesReview|2 次/);
  });
  it("区分限流与额度不足，额度不足时不要求反复重试", () => {
    expect(salesReviewErrorMessage({ code: "RATE_LIMITED", message: "429" })).toContain("稍等");
    expect(salesReviewErrorMessage({ code: "QUOTA_EXCEEDED", message: "quota" })).toContain("补充额度");
  });
});
