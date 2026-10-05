/**
 * 稳定哈希工具
 *
 * 项目里需要「把一段文本压成一个可比较、可入库的定长标识」的地方有两处：
 *   1. 知识缺口的聚合键（`src/rag/knowledge-gap.ts`）；
 *   2. Agent 任务日志里的 `questionHash`（只留指纹，不留消费者原话）。
 *
 * 两处**必须用同一个实现**：哈希算法一旦分叉，同一个问题在缺口表与任务表里
 * 会得到不同的指纹，排查时「这两条记录是不是同一次提问」就变成了猜测。
 * 因此这里只留一个最底层的原语，谁也不许再写第二份 `createHash("sha256")`。
 *
 * 为什么不用 `crypto.randomUUID` 之类换个做法：要求的性质是不同的 ——
 * 这里要的是**确定性**（同样的输入永远得到同样的输出），
 * 而不是「不重复」。随机数在这里毫无用处，反而会让聚合失效。
 */

import { createHash } from "node:crypto";

/**
 * 取文本的 SHA-256 十六进制摘要。
 *
 * 用途是**指纹**，不是加密：它不可逆、也不加盐。放进 Agent 任务日志是为了
 * 「同一次提问能被对上」，而不是为了隐藏内容 ——
 * 消费者原话本来就已经存在 `customer_messages` 里，任务表里再存一遍
 * 只是把同一份内容复制到第二个地方（任务书第十五节明确要求不这么做）。
 */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
