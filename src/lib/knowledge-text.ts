/**
 * 知识文本处理纯函数（S5）
 *
 * 只有一个函数，但它决定了「知识缺口会不会失控」。
 *
 * 缺口面板的价值在于**聚合**：商家想知道「有哪些问题我答不上来、各被问了多少次」，
 * 而不是看 30 行语气略有差别的同一句话。因此去重键必须做规范化 ——
 * 而规范化规则一定要集中定义：服务层算键、仓储层建唯一索引，
 * 一旦两边规则不同，唯一约束就形同虚设（同一句话算出两个键，各插一行）。
 *
 * 规则刻意保守，只处理**确定安全**的差异：
 * - 全角/半角与大小写；
 * - 标点与空白；
 * - 句首客套（请问 / 麻烦 / 你好…）与句尾语气助词（吗 / 呢 / 吧…）。
 *
 * 刻意**不做**同义词替换与分词：「咋保存」和「怎么保存」在规则里仍是两句，
 * 这会让面板少聚合一部分。但同义词表一旦开始维护就没有尽头，
 * 而且猜错会把两个不相关的问题合并成一条 —— 那种错误商家无从发现，
 * 比「少聚合一点」危险得多。第一版宁少勿错（任务书第二十二节）。
 */

/** 全角 ASCII（FF01–FF5E）与全角空格 → 半角 */
function toHalfWidth(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x3000) {
      result += " ";
    } else if (code >= 0xff01 && code <= 0xff5e) {
      result += String.fromCodePoint(code - 0xfee0);
    } else {
      result += char;
    }
  }
  return result;
}

/** 标点与空白：中英文常见符号一并剔除 */
const PUNCTUATION_PATTERN =
  /[\s，。；：、！？…—～·「」『』《》〈〉【】（）〔〕“”‘’"'`,.!?;:()[\]{}<>~\-_+*/\\|@#$%^&=]/g;

/** 句首客套：可叠加（「你好，请问一下…」），因此循环剥离 */
const POLITE_PREFIXES = [
  "请问",
  "麻烦问一下",
  "麻烦问下",
  "麻烦",
  "想问一下",
  "想问下",
  "我想问一下",
  "我想问下",
  "想问",
  "你好",
  "您好",
  "老板",
  "客服",
] as const;

/** 句尾语气助词 */
const TAIL_PARTICLES_PATTERN = /[吗呢吧啊呀嘛哦啦哈哟]+$/;

/**
 * 规范化问题文本，作为知识缺口的去重键。
 *
 * 规范化后可能为空（用户只发了「？」或「在吗」）——
 * 那属于「无效提问」，调用方应据此跳过缺口记录，而不是拿空串当键
 * （空串聚合会把所有无意义提问混成一条）。
 */
export function normalizeQuestion(question: string): string {
  let text = toHalfWidth(question).toLowerCase();

  text = text.replace(PUNCTUATION_PATTERN, "");

  let changed = true;
  while (changed && text.length > 0) {
    changed = false;
    for (const prefix of POLITE_PREFIXES) {
      if (text.length > prefix.length && text.startsWith(prefix)) {
        text = text.slice(prefix.length);
        changed = true;
      }
    }
  }

  return text.replace(TAIL_PARTICLES_PATTERN, "");
}

/**
 * 会话列表里的一行预览。
 *
 * 为什么要在仓储层截断而不是交给 CSS：`lastMessage` 会进数据库查询结果、
 * 也会进测试断言，长度不受控时「同一段数据在两个数据源下长度不同」会很难查。
 * 截断长度取 40 —— 会话列表一行大约能放这么多汉字。
 */
export function buildMessagePreview(content: string, maxLength = 40): string {
  const text = content.replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
