/**
 * 向量工具（S5）
 *
 * 这里是**唯一**声明向量维度的地方。数据库列 `knowledge_chunks.embedding`、
 * DashScope 的请求参数、Mock 的确定性向量、检索层的校验，全部读同一个常量 ——
 * 维度写死在四处的话，换模型时必然漏改一处，而后果是「写入报错」或
 * 「检索永远返回空」这种不明显的故障。
 *
 * 为什么放 `src/lib/` 而不是 `src/ai/`：数据库 Schema 需要它（`vector(1024)`），
 * 而 Schema 不该依赖 AI 层。它也不该放 `src/db/`，因为 Provider 与 RAG 层要用它，
 * 而它们都不该依赖数据库层。放在中立位置，三方各取所需。
 *
 * 本文件全部是纯函数，可被客户端与服务端共用，也可被单测穷举。
 */

/**
 * 向量维度，与 DashScope `text-embedding-v3` 及数据库列 `vector(1024)` 对齐。
 *
 * ⚠️ 改这个值意味着一次**必须重建全部向量**的迁移：数据库列是定长的，
 * 旧向量不会被自动转换，且新旧向量之间无法比较。
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * 校验一个向量是否满足维度约束。
 *
 * 三条明确禁止（任务书第六节）：**截断、padding、静默转换**。
 * 三者都会产出一个「看起来能用、其实语义已经错位」的向量，
 * 而错位的向量不会报错 —— 它只会让检索结果悄悄变差。
 */
export function isEmbeddingVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

/** 向量内积 */
export function dotProduct(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return sum;
}

/** 向量 L2 范数 */
export function vectorNorm(vector: readonly number[]): number {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

/**
 * 归一化（单位向量）。
 *
 * 零向量原样返回 —— 除以 0 得到 `NaN`，而 `NaN` 一旦进了数据库或比较运算，
 * 整条检索链会安静地失效（`NaN > 0.3` 恒为 false）。返回零向量至少是「明确的无信息」，
 * 且它的余弦相似度恒为 0，不会污染排序。
 */
export function normalizeVector(vector: readonly number[]): number[] {
  const norm = vectorNorm(vector);
  if (!Number.isFinite(norm) || norm === 0) {
    return [...vector];
  }
  return vector.map((value) => value / norm);
}

/**
 * 余弦相似度。
 *
 * 两个向量任何一方为零向量时返回 0，而不是 NaN —— 见 `normalizeVector` 的说明。
 * 结果为 -1 ~ 1；本项目的检索语义按「越大越相关」使用。
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  const normA = vectorNorm(a);
  const normB = vectorNorm(b);
  if (!Number.isFinite(normA) || !Number.isFinite(normB) || normA === 0 || normB === 0) {
    return 0;
  }
  const similarity = dotProduct(a, b) / (normA * normB);
  // 浮点误差可能让它略微越界，夹取到合法区间
  return Math.min(1, Math.max(-1, similarity));
}

/**
 * 把余弦相似度映射到 0 ~ 1，供**界面展示**使用。
 *
 * 为什么需要它：余弦的自然区间是 -1 ~ 1，而「相关度 30%」这种说法对应的是 0 ~ 1。
 * `(cos + 1) / 2` 把负值也拉进合法区间。
 *
 * ⚠️ 两个必须说清的坑：
 * 1. 它**不是恒等映射**。余弦 0.2 会变成 0.6、余弦 0 会变成 0.5 ——
 *    「相关度 60%」并不代表「余弦 0.6」。因此它**只能用在展示边界**，
 *    绝不能拿来和阈值比（阈值全在原始余弦尺度上）。
 * 2. 映射后 0 与弱相关的 0.2 会被拉开成 0.5 与 0.6，视觉上很难区分。
 *    所以它适合「给一个百分数」，不适合「用它做排序或判定」。
 */
export function toSimilarityScore(cosine: number): number {
  if (!Number.isFinite(cosine)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (cosine + 1) / 2));
}
