/**
 * 内容合规与事实扫描的共享词表与判定（S3-2 抽出）
 *
 * 为什么需要共享：
 * Brand Agent（品牌故事）与 Content Agent（营销文案）面对的是**同一批风险**——
 * 把别处的产地写进来、用广告法禁止的绝对化用语、复述老板明令禁止的表达。
 * S3-1 时这套词表只存在于 Brand Agent 一处；S3-2 出现第二处使用方后，
 * 就必须收敛：两份副本意味着「合规红线」会随版本慢慢分叉，
 * 而合规恰恰是最不能分叉的东西。
 *
 * 只共享**词表与判定**，不共享告警文案 ——
 * 「品牌文案中出现…」与「内容文案中出现…」的措辞要贴合各自的语境。
 *
 * 一条纪律：**只告警、不改写**。Agent 不替商家删词 ——
 * 改写会掩盖问题，让人以为风险已经处理过了。判断权归商家（技术文档 5.4）。
 */

/**
 * 其他海产产地（非本次商家所在地）。
 *
 * 用途：品牌故事与营销文案最容易犯的错是把别处的产地写进来
 * （「源自大连深海」「挪威三文鱼」），而输入里根本没有这些事实。
 * 命中即告警，让人去看一眼。
 * 刻意只收「明确是产地 / 海域」的词，避免把「鲜活」「海鲜」这类通用词卷进来造成误报。
 */
export const OTHER_ORIGIN_TERMS: readonly string[] = [
  "大连",
  "舟山",
  "青岛",
  "威海",
  "湛江",
  "北海",
  "东山岛",
  "南澳",
  "嵊泗",
  "烟台",
  "挪威",
  "智利",
  "日本",
  "北海道",
  "阿拉斯加",
  "冰岛",
  "加拿大",
  "新西兰",
  "澳洲",
  "澳大利亚",
  "厄瓜多尔",
  "越南",
  "泰国",
  "俄罗斯",
];

/**
 * 绝对化 / 无法证实的用语（技术文档合规红线）。
 * 含绝对化表述与医疗功效宣称 —— 两者在广告法下都不可用。
 */
export const ABSOLUTE_CLAIM_TERMS: readonly string[] = [
  "第一",
  "最好",
  "最强",
  "最优",
  "最佳",
  "最低价",
  "全网最低",
  "国家级",
  "世界级",
  "顶级",
  "唯一",
  "100%",
  "百分百",
  "纯天然",
  "无污染",
  "零添加",
  "包治",
  "治疗",
  "治愈",
  "防癌",
  "抗癌",
  "增强免疫力",
];

/** 词表里出现在语料中的词（保持词表顺序，便于输出稳定） */
export function findTermHits(corpus: string, terms: readonly string[]): string[] {
  return terms.filter((term) => corpus.includes(term));
}

/**
 * 疑似虚构的产地词：出现在产出里、但**输入依据中从未出现**。
 *
 * @param grounding 把所有「有据可依」的文本拼在一起（商家所在地、经营类目、
 *                  商品产地与名称、品牌档案里已有的表述…）。
 *                  命中词只要出现在这里，就说明商家本来就说过，不算编造。
 */
export function findUnsupportedOriginTerms(
  corpus: string,
  grounding: string,
  terms: readonly string[] = OTHER_ORIGIN_TERMS,
): string[] {
  return terms.filter((term) => corpus.includes(term) && !grounding.includes(term));
}

/** 命中的禁用表达（老板数字分身的红线，必须改写） */
export function findForbiddenHits(
  corpus: string,
  forbiddenPhrases: readonly string[],
): string[] {
  return forbiddenPhrases.filter((phrase) =>
    phrase.trim() ? corpus.includes(phrase.trim()) : false,
  );
}
