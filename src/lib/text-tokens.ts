/**
 * 中文词元切分与词面覆盖度（S5）
 *
 * 为什么放在 `src/lib` 而不是留在 Mock Provider 里：
 * 这些函数有**两个**使用方，且它们不该互相依赖 ——
 * - Mock Provider 用它构造确定性向量（`buildDeterministicEmbedding`）；
 * - RAG 检索层用它计算「词面覆盖度」（hybrid 检索里的稀疏侧信号）。
 * 若留在 Provider 里，RAG 层就要 import Provider 的私有实现，
 * 一旦换成真实 Provider，检索层就会跟着一起塌。
 *
 * 全部是纯函数，确定、可穷举测试。
 */

/** 中日韩统一表意文字（含扩展 A）—— 中文需要按字切分 */
export const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
/** 拉丁字母 / 数字（英文词与规格数字） */
export const WORD_PATTERN = /[a-z0-9]+/g;

/**
 * 中文高频虚词。
 *
 * 剔除它们不是为了「分词更漂亮」，而是为了**让相似度有区分度**：
 * 「这个怎么保存？」与「那个怎么做？」共享「这/个/怎/么」四个字，
 * 不剔除的话两个毫不相关的问题也会得到不低的相似度，
 * 阈值判定就变成一个凭运气的东西。
 */
export const CJK_STOP_CHARS: ReadonlySet<string> = new Set([
  "的",
  "了",
  "是",
  "在",
  "我",
  "你",
  "他",
  "她",
  "它",
  "们",
  "这",
  "那",
  "个",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "和",
  "与",
  "或",
  "也",
  "都",
  "还",
  "就",
  "很",
  "有",
  "没",
  "不",
  "请",
  "问",
  "下",
  "会",
  "能",
  "要",
  "把",
  "被",
  "给",
  "对",
  "从",
  "到",
  "以",
  "及",
  "而",
  "但",
  "如",
  "果",
  "因",
  "为",
  "所",
  "之",
  "于",
  "其",
  "此",
  "该",
  "些",
  "么",
  "怎",
  "多",
  "少",
  "好",
  "可以",
  /**
   * 程度副词与语气助词。
   *
   * 为什么单独补这一组：「鲍鱼怎么保存**比较**好？」里的「比较」会被切成一个
   * 二字组，而《海产选购与规格说明》里恰好有「礼盒**比较**体面」——
   * 于是这条完全无关的切片靠一个虚词稳稳排到了《鲜活鲍鱼储存说明》前面。
   *
   * 这类词的特点是**不携带事实信息**，但长度足够、在语料里出现频率又高，
   * 对词袋哈希来说就是纯噪声源。
   */
  "比",
  "较",
  "什",
  "太",
  "挺",
  "更",
  "最",
  "超",
  "啥",
  "咋",
  "咱",
  "嘛",
  "啦",
  "哦",
  "哟",
  "呗",
  "咯",
  "哇",
  "嘞",
  "欸",
  "哈",
]);

/** 词元权重：二字组比单字更有区分度，拉丁词居中 */
export const TOKEN_WEIGHT = {
  bigram: 3,
  word: 2,
  char: 1,
} as const;

/**
 * 把一段文本切成（带权重的）词元。
 *
 * 中文没有空格，因此采用**单字 + 相邻二字**的组合：
 * - 单字保证「鲍鱼」「保存」这类短问句一定能命中知识里的对应字；
 * - 二字组（bigram）提供最低限度的语序信息，让「保存鲍鱼」与「鲍鱼保存」
 *   比「鲍鱼」和「海带」更像 —— 只有单字的话，这两组的相关性完全一样。
 *
 * 三条刻意的修剪，都是为了压住**特征散列的碰撞底噪**
 * （1024 维下，两段毫无关系的长文本也会有 0.05~0.12 的余弦，
 * 与真实信号同量级，阈值判定就失去意义）：
 * 1. 二字组只在**连续汉字段内**生成，不跨标点与数字（否则会造出「盒适」「冷保」这类不存在的词）；
 * 2. 含虚词的二字组直接丢弃（「鱼怎」「怎么」不是词，只会把不同问题拉到一起）；
 * 3. 词频饱和（`1 + ln(count)`），不按出现次数线性累加 —— 否则把同一个词写三遍
 *    就能靠堆词赢过真正相关但只提了一次的文档。
 *
 * 这是**刻意粗糙**的分词：真实模型用 BPE 与语义空间，Mock 只需要
 * 「相似的文本更靠近」这个性质成立即可（任务书第七节明确允许 hash-based
 * deterministic vector，并要求说明 Mock 向量不代表真实语义质量）。
 */
export function tokenizeForEmbedding(
  text: string,
): { token: string; weight: number }[] {
  const lower = text.toLowerCase();
  const tokens: { token: string; weight: number }[] = [];

  for (const match of lower.matchAll(WORD_PATTERN)) {
    tokens.push({ token: match[0], weight: TOKEN_WEIGHT.word });
  }

  const runs: string[][] = [];
  let current: string[] = [];
  for (const char of lower) {
    if (CJK_PATTERN.test(char)) {
      current.push(char);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }

  for (const run of runs) {
    for (const char of run) {
      if (!CJK_STOP_CHARS.has(char)) {
        tokens.push({ token: char, weight: TOKEN_WEIGHT.char });
      }
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      const left = run[index] ?? "";
      const right = run[index + 1] ?? "";
      if (CJK_STOP_CHARS.has(left) || CJK_STOP_CHARS.has(right)) {
        continue;
      }
      tokens.push({ token: `${left}${right}`, weight: TOKEN_WEIGHT.bigram });
    }
  }

  const counted = new Map<string, { weight: number; count: number }>();
  for (const token of tokens) {
    const existing = counted.get(token.token);
    if (existing) {
      existing.count += 1;
    } else {
      counted.set(token.token, { weight: token.weight, count: 1 });
    }
  }

  return [...counted.entries()].map(([token, entry]) => ({
    token,
    weight: entry.count > 1 ? entry.weight * (1 + Math.log(entry.count)) : entry.weight,
  }));
}

/**
 * 词面覆盖度：查询的内容词元里，有多大比例**原样出现**在被检索文本中。
 *
 * 为什么检索层需要它（而不是只用向量相似度）：
 * 相似度回答的是「这两段文本整体像不像」，它会被**文本长度**与
 * **词频**干扰 —— 一段啰嗦地把「鲍鱼」写了三遍的《礼盒说明》，
 * 在词袋向量上可以压过真正讲储存的《储存说明》。
 * 覆盖度回答的是另一个问题：「问题里的关键概念，这段材料**提到了几个**」，
 * 它与长度无关、与重复无关（去重后只算一次），恰好补上前者的短板。
 *
 * 这两者合起来就是工业界常见的 **hybrid 检索**（dense + sparse）。
 * 真实 Provider 下稀疏侧依然有价值（专有名词、型号、地名这类
 * 语义模型也容易忽略的精确匹配），因此它不是给 Mock 打的补丁。
 *
 * 度量方式刻意选「命中词数 / 查询词数」而不是加权求和：
 * 归一化之后阈值才有跨查询的可比性，否则长问句永远比短问句得分低。
 * 查询去重后的词元数为 0 时（「在吗」这种全是虚词的输入）返回 0。
 */

/**
 * 覆盖度分母的**上限**。
 *
 * 为什么分母不能直接用全量查询词元数：真实提问里的铺垫不计入信息量。
 * 「主播说今天现捞的，鲍鱼怎么保存比较好？」有 19 个内容词元，
 * 而真正决定答案的只有「鲍鱼 / 保存」两个 —— 拿 19 当分母，
 * 一份完全正确的《鲜活鲍鱼储存说明》也只能拿到 0.16，
 * 于是「答得上来」被稀释成「依据不足」，而且是**问得越啰嗦越答不上来**。
 *
 * 取 6 是标定出来的，不是拍的：把权重与分母上限做了 24 组穷举，
 * 只有 cap=6 这一档能同时满足「8 条关键问题全部落在正确的文档上」
 * 与「可行阈值带最宽」（详见 `src/rag/retriever.ts` 的档位说明）。
 * cap=4 会把「命中 4 个无关词元」也算成完全覆盖，直接导致检索命中文档错位。
 */
export const COVERAGE_TOKEN_CAP = 6;

/**
 * 启用稀疏侧所需的最少查询词元数。
 *
 * 覆盖度是一个**比例**度量，查询词元太少时它会退化成 0/1 的二值信号：
 * 「多久能到？」剥掉虚词后只剩一个「久」字，任何偶然含「久」的切片都会拿到 1.0，
 * 排到所有真正相关的切片前面。这种情况下稀疏侧提供的是噪声而非信号，
 * 因此直接不启用，退回纯向量判定。
 */
export const MIN_COVERAGE_QUERY_TOKENS = 2;

/**
 * 一次查询的（可复用）覆盖度计算器。
 *
 * 之所以做成工厂而不是 `lexicalCoverage(query, text)` 直接把查询传进去：
 * 一次检索要拿同一个查询去比几十条候选切片，逐条重新分词是纯浪费；
 * 更重要的是它把「这个查询到底能不能算覆盖度」这件事显式暴露成 `measurable`，
 * 而不是让调用方从 `tokenCount` 去猜。
 */
export interface QueryCoverage {
  /** 查询去重后的内容词元数（**未**按上限截断，供调用方判断信号强弱） */
  tokenCount: number;
  /** 是否启用了稀疏侧；为 false 时 `coverageOf` 恒返回 0 */
  measurable: boolean;
  /** 命中比例，落在 0~1 */
  coverageOf(text: string): number;
}

export function createQueryCoverage(query: string): QueryCoverage {
  const tokens = new Set(tokenizeForEmbedding(query).map((item) => item.token));
  const tokenCount = tokens.size;
  const measurable = tokenCount >= MIN_COVERAGE_QUERY_TOKENS;
  const denominator = Math.min(tokenCount, COVERAGE_TOKEN_CAP);

  return {
    tokenCount,
    measurable,
    coverageOf(text: string): number {
      if (!measurable || denominator === 0) {
        return 0;
      }
      const textTokens = new Set(tokenizeForEmbedding(text).map((item) => item.token));
      let matched = 0;
      for (const token of tokens) {
        if (textTokens.has(token)) {
          matched += 1;
        }
      }
      // 命中数可能超过分母（分母被 cap 截断过），此处封顶到 1
      return Math.min(1, matched / denominator);
    },
  };
}

/**
 * 单次比较的便捷包装。
 *
 * 批量比较请用 `createQueryCoverage` —— 它对每个候选都重新分词查询，
 * 只适合测试与一次性判断，放进检索循环里就是 O(候选数) 次重复分词。
 */
export function lexicalCoverage(query: string, text: string): number {
  return createQueryCoverage(query).coverageOf(text);
}
