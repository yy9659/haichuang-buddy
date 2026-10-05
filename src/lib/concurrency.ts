/**
 * 受控并发工具
 *
 * 存在的理由只有一个：**批量调用外部服务时必须有上限**。
 *
 * `Promise.all(items.map(...))` 会在一个 tick 内把全部请求一起发出去。
 * 对本地计算没问题，对模型 API 是三种故障的叠加：
 * 1. 触发限流（429）—— 而且是一次性全中，整批失败；
 * 2. 连接池被打满，同时进行的其它请求（比如消费者正在等的问答）被拖住；
 * 3. 失败后重试又全量重发，形成正反馈。
 *
 * 一份正常的知识文档能切出几十个切片，因此「一批全发」不是理论风险，
 * 而是第一次真索引就会发生的事。
 *
 * 这里刻意做成**纯函数、零依赖**：它要同时服务于索引流水线、
 * 以后可能的批量同步、以及单测里的并发断言。任何对具体业务类型的引用
 * 都会让它变成一个「只能在某个场景用」的工具。
 *
 * 语义上有三条保证（单测逐条覆盖）：
 * - **结果顺序与输入一致**，与完成先后无关（否则切片会与 chunkIndex 错位）；
 * - **任意时刻进行中的任务数不超过 `limit`**；
 * - **遇到失败立即停止派发新任务**，但已经开始的任务不再被强行中断 ——
 *   抛出的仍然是原始错误，由调用方按 `AppError` 处理。
 */

/**
 * 按 `limit` 的并发上限依次执行 `worker`，返回与 `items` 等长、顺序一致的结果。
 *
 * @param items 待处理项。空数组直接返回 `[]`，不启动任何任务。
 * @param limit 并发上限。小于 1 时按 1 处理 —— 「并发上限为 0」没有任何
 *   合理语义，静默返回空结果只会让人以为「没有任务」，所以夹取到 1。
 * @param worker 单项处理函数；抛出的异常会原样冒泡。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.trunc(limit));
  const results: R[] = new Array<R>(items.length);

  let cursor = 0;
  let failure: unknown;

  /** 一个「工人」：不断领取下一个未处理的序号，直到取完或有人失败 */
  const run = async (): Promise<void> => {
    while (failure === undefined) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      const item = items[index];
      if (item === undefined) {
        // 只可能是稀疏数组；跳过而不是把 undefined 当作合法输入递给 worker
        continue;
      }
      try {
        results[index] = await worker(item, index);
      } catch (cause) {
        /**
         * 记下第一个失败并停止派发。**不主动取消**已在运行的任务：
         * 强行中断一个已经发出的 HTTP 请求，只会把「一个明确的错误」
         * 变成「一堆含义不明的错误」，调用方反而看不清根因。
         */
        if (failure === undefined) {
          failure = cause;
        }
        return;
      }
    }
  };

  const workers = Math.min(size, items.length);
  await Promise.all(Array.from({ length: workers }, () => run()));

  if (failure !== undefined) {
    throw failure;
  }
  return results;
}
