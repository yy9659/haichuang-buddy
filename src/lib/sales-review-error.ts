import type { AppErrorShape } from "@/lib/result";
import { sanitizeUserFacingText } from "@/lib/user-facing-text";

/** 旧任务只保存了错误文本，页面仍需避免展示内部字段和校验诊断。 */
export function savedReportFailureMessage(message: string): string {
  if (/结构校验|输出不符合|JSON.*无法解析/.test(message)) {
    return "这次 AI 回顾中的数字或内容没有核对通过，请重新整理";
  }
  return sanitizeUserFacingText(message.split(/[（(]/)[0]);
}

/** 销售建议的提示按实际失败类型区分；不把模型或程序诊断直接展示给商户。 */
export function salesReviewErrorMessage(error: Pick<AppErrorShape, "code" | "message">): string {
  switch (error.code) {
    case "SCHEMA_INVALID":
      return "这次 AI 建议中的数字或内容没有核对通过，请重新生成。上次已保存的建议仍然保留。";
    case "MODEL_TIMEOUT":
      return "这次分析用时较长，暂时没有完成，请稍后重新生成。已有销售记录和建议仍然保留。";
    case "MODEL_UNAVAILABLE":
      return "AI 暂时没有连接成功，请稍后再试。已有销售记录和建议仍然保留。";
    case "RATE_LIMITED":
      return "当前 AI 请求较多，请稍等一会儿再生成建议。";
    case "QUOTA_EXCEEDED":
      return "AI 服务额度暂时不足，请补充额度后再生成。销售记录仍可正常查看。";
    case "UNAUTHORIZED":
      return "登录已失效，请重新登录后生成销售建议。";
    case "VALIDATION_FAILED":
      return error.message;
    default:
      return "这次销售建议没有生成成功，请稍后再试。已有销售记录和建议仍然保留。";
  }
}
