/**
 * 引用校验（S6 抽取自 Customer Service Agent）
 *
 * 为什么把它从客服 Agent 里抽出来：S6 的 AI 直播导演同样需要「模型给出的引用
 * 必须真实来自本次检索」这道校验。复制粘一份会让两个 Agent 的判定规则逐渐分叉
 * ——某个 Agent 补了一条新规则、另一个没跟上，而这类分叉不会有任何报错，
 * 只会让其中一个 Agent 在某天开始接受假引用。
 *
 * 因此这里只做**最小必要抽取**：把「校验 + 转成展示形态」这一件事搬出来，
 * 两个 Agent 各自调用。业务规则（比如客服的 grounded 判定、直播的优先级）
 * 仍然留在各自的 Agent 里，不往上抽。
 *
 * 两条判定，缺一不可：
 * - `chunkId` 必须出现在**本次检索结果**里（不能是模型编的）；
 * - `documentId` 必须与那个 chunk 的真实归属一致（防止「真 chunkId + 假 documentId」
 *   这种半真半假的组合 —— 界面按 documentId 回查文档，错配会指向另一份文档）。
 */

import { toSimilarityScore } from "@/lib/embedding";
import { fail, ok, type Result } from "@/lib/result";
import type { KnowledgeSource, RetrievedChunk } from "@/types";

/** 引用片段在界面上展示的摘要长度 */
export const CITATION_SNIPPET_LENGTH = 160;

/** 把切片正文裁成一句可展示的摘要 */
export function toCitationSnippet(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length <= CITATION_SNIPPET_LENGTH
    ? compact
    : `${compact.slice(0, CITATION_SNIPPET_LENGTH)}…`;
}

/**
 * 校验模型给出的引用，并转换成可展示的 `KnowledgeSource`。
 *
 * 失败即 `VALIDATION_FAILED`，**不做「把假引用摘掉、保留其余」的补救** ——
 * 模型既然编了一个 id，它那段话的依据就不成立，摘掉引用只会让一句无据的话
 * 看起来像有据可依。
 */
export function validateCitations(
  citations: readonly { documentId: string; chunkId: string }[],
  hits: readonly RetrievedChunk[],
): Result<KnowledgeSource[]> {
  const byChunkId = new Map(hits.map((hit) => [hit.chunkId, hit]));
  const sources: KnowledgeSource[] = [];

  for (const citation of citations) {
    const hit = byChunkId.get(citation.chunkId);
    if (!hit) {
      return fail(
        "VALIDATION_FAILED",
        "模型返回了不在检索结果中的引用，已拒绝该回答",
        `伪造的 chunkId=${citation.chunkId}。本次检索到的可用 chunkId：${
          hits.map((item) => item.chunkId).join("、") || "（无）"
        }`,
      );
    }
    if (hit.documentId !== citation.documentId) {
      return fail(
        "VALIDATION_FAILED",
        "模型返回了与片段不匹配的文档引用，已拒绝该回答",
        `chunkId=${citation.chunkId} 实际属于 documentId=${hit.documentId}，而模型写的是 ${citation.documentId}`,
      );
    }
    sources.push({
      // id 供列表 key 使用；documentId + chunkId 才是可追溯的凭据
      id: hit.chunkId,
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      title: hit.documentName,
      type: hit.sourceType,
      snippet: toCitationSnippet(hit.content),
      /**
       * 这里是**展示边界**：检索层给的是原始余弦，界面要的是 0~1 的「相关度百分比」，
       * 映射只在这个出口做一次（`KnowledgeSource.score` 的契约就是 0~1）。
       */
      score: toSimilarityScore(hit.similarity),
    });
  }

  return ok(sources);
}
