/**
 * 中文文本切片（S5 · 任务书第十一 / 十二节）
 *
 * 为什么不能「按固定字符数暴力切」：
 * 一份物流说明被从「福建省内次日达，华东华南」处切断，前半段落进上一块、
 * 后半段落进下一块，两块**单独看都是不完整的政策**。检索命中其中一块后，
 * 模型拿到的是一句被拦腰截断的话 —— 它只能猜后半句是什么，而"猜"
 * 正是这个项目一直在防的事。
 *
 * 因此切分顺序是「从粗到细」，能不切就不切：
 *   标题 → 空行（段落）→ 句号 → 最后才是硬切
 * 每一级都只在**上一级切不动时**才启用，且切点必须落在语义边界上。
 *
 * 两个刻意的设计：
 * 1. **参数集中**（`DEFAULT_CHUNKING_CONFIG`），不散落魔法数字 ——
 *    chunk 大小会影响索引时的调用次数与检索粒度，调它的时候必须能一眼看到全部相关参数。
 * 2. **overlap 用「上一块的尾部」而不是「上一块的最后一整句」**：
 *    尾部重叠能保证跨界的半个句子在两块里都能读到，这正是 overlap 存在的理由；
 *    按句重叠在句子本身就超过窗口时会退化成零重叠。
 *
 * 全部为纯函数，可被单测穷举（任务书第三十九节要求覆盖中文段落 / 超长 / 空文本 / overlap）。
 */

/** 切片配置 */
export interface ChunkingConfig {
  /**
   * 单块最大字符数。
   *
   * 取 320 而不是 512/1024：中文的一个字承载的信息量约等于英文的 1.5~2 个 token，
   * 320 字已经接近一段完整政策的长度；再大就会把「储存」与「售后」两件事
   * 塞进同一块，检索命中后引用来源就说不清了。
   */
  maxChunkSize: number;
  /** 相邻块的重叠字符数（保证跨界句可读） */
  overlap: number;
  /**
   * 单块最小字符数。
   *
   * 短于它的尾块会被**并入上一块**而不是独立成块：一个 8 个字的碎片
   * 会以极高概率被任何问题命中（它几乎没有区分度），排在检索结果里只会挤掉真正的答案。
   */
  minChunkSize: number;
  /** 单份文档最大切片数（防止一份超长文档把索引拖垮） */
  maxChunks: number;
  /** 标题行最大长度（超过这个长度的「标题」其实是正文） */
  maxHeadingLength: number;
}

/** 默认配置：所有参数集中在这里，改切片行为只改这一处 */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxChunkSize: 320,
  overlap: 48,
  minChunkSize: 40,
  maxChunks: 200,
  maxHeadingLength: 30,
};

/** 一个切片（纯文本视图，不含 id / 向量 —— 那些由索引服务补） */
export interface DocumentChunk {
  /** 从 0 开始的序号 */
  index: number;
  content: string;
  /** 所属章节标题；识别不到为空串 */
  section: string;
  /** 在原文中的起止字符下标（含重叠时用首个单元的位置，用于回溯原文） */
  start: number;
  end: number;
}

interface Unit {
  text: string;
  start: number;
  end: number;
}

interface Section {
  title: string;
  units: Unit[];
}

/** 统一换行符并去掉首尾空白（\r\n / \r 在中文文本里很常见） */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/**
 * 是否像一个小标题。
 *
 * 判定刻意保守（宁可漏判、不可错判）：把正文里的一句话当成标题，
 * 会让后续所有切片都挂上一个错误的「section」，比没有 section 更误导人。
 * 因此要求：单行、足够短、不以句末标点结尾、且不含句末标点。
 */
function isHeading(text: string, config: ChunkingConfig): boolean {
  const line = text.trim();
  if (line.length === 0 || line.length > config.maxHeadingLength) {
    return false;
  }
  if (line.includes("\n")) {
    return false;
  }
  // Markdown 标题语法是明确信号
  if (/^#{1,6}\s+/.test(line)) {
    return true;
  }
  // 以「一、」「1.」「1）」这类编号开头，且不长
  if (/^[0-9一二三四五六七八九十]+[.、)）]/.test(line)) {
    return true;
  }
  // 以冒号结尾也常被当作小节提示（如「储存方式：」），但此时视为标题会把
  // 紧跟在后面的内容割出去，因此只接受**不带句末标点**的短行
  return !/[。！？；.!?;]/.test(line);
}

/** 去掉标题前面的 Markdown 记号与编号，只留可读文字 */
function cleanHeading(text: string): string {
  return text
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[0-9一二三四五六七八九十]+[.、)）]\s*/, "")
    .replace(/[：:]\s*$/, "")
    .trim();
}

/** 把文本按空行切成段落，并保留每段在原文中的位置 */
function splitParagraphs(text: string): Unit[] {
  const paragraphs: Unit[] = [];
  const lines = text.split("\n");

  let cursor = 0;
  let bufferStart: number | null = null;
  let bufferLines: string[] = [];

  const flush = () => {
    if (bufferStart === null || bufferLines.length === 0) {
      return;
    }
    const joined = bufferLines.join("\n");
    paragraphs.push({
      text: joined,
      start: bufferStart,
      end: bufferStart + joined.length,
    });
    bufferStart = null;
    bufferLines = [];
  };

  for (const line of lines) {
    const lineLength = line.length;
    if (line.trim().length === 0) {
      flush();
    } else {
      if (bufferStart === null) {
        bufferStart = cursor;
      }
      bufferLines.push(line);
    }
    // +1 补回被 split 吃掉的那个换行符
    cursor += lineLength + 1;
  }
  flush();

  return paragraphs;
}

/**
 * 把过长的段落切成句子。
 *
 * 分隔符包含中文句末标点与换行；**分隔符本身保留在句尾**，
 * 否则「0-4℃」这类以数字结尾的句子会丢掉标点，读起来像被吞了字。
 */
function splitSentences(unit: Unit): Unit[] {
  const sentences: Unit[] = [];
  const pattern = /[^。！？；!?;\n]+[。！？；!?;]?/g;

  for (const match of unit.text.matchAll(pattern)) {
    const segment = match[0];
    if (segment.trim().length === 0) {
      continue;
    }
    const offset = match.index ?? 0;
    sentences.push({
      text: segment.trim(),
      start: unit.start + offset,
      end: unit.start + offset + segment.length,
    });
  }

  return sentences.length > 0 ? sentences : [unit];
}

/** 最后手段：按固定长度硬切（只对「一句话超过整块上限」这种极端情况生效） */
function hardSplit(unit: Unit, maxChunkSize: number): Unit[] {
  const pieces: Unit[] = [];
  for (let offset = 0; offset < unit.text.length; offset += maxChunkSize) {
    const text = unit.text.slice(offset, offset + maxChunkSize);
    pieces.push({
      text,
      start: unit.start + offset,
      end: unit.start + offset + text.length,
    });
  }
  return pieces;
}

/** 逐级降级地把一个段落拆成「不超过 maxChunkSize」的单元 */
function toBoundedUnits(unit: Unit, config: ChunkingConfig): Unit[] {
  if (unit.text.length <= config.maxChunkSize) {
    return [unit];
  }
  const sentences = splitSentences(unit);
  // 句子层没有继续拆分（说明整段就是一句话），才启用硬切
  if (sentences.length <= 1) {
    return hardSplit(unit, config.maxChunkSize);
  }
  return sentences.flatMap((sentence) =>
    sentence.text.length <= config.maxChunkSize
      ? [sentence]
      : hardSplit(sentence, config.maxChunkSize),
  );
}

/** 按标题把文本分成若干章节；无标题时整篇算一个章节（`title` 为空串） */
function splitSections(text: string, config: ChunkingConfig): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: "", units: [] };

  for (const paragraph of splitParagraphs(text)) {
    if (isHeading(paragraph.text, config)) {
      // 只有出现过内容或已有标题才收口，避免开头连续多个标题产出空章节
      if (current.units.length > 0 || current.title.length > 0) {
        sections.push(current);
      }
      current = { title: cleanHeading(paragraph.text), units: [] };
      continue;
    }
    current.units.push(...toBoundedUnits(paragraph, config));
  }

  if (current.units.length > 0 || current.title.length > 0) {
    sections.push(current);
  }

  return sections;
}

/** 取上一块的尾部作为下一块的前缀（overlap） */
function tailOf(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) {
    return "";
  }
  return text.slice(text.length - overlap);
}

/**
 * 主入口：把一份文档正文切成检索用的切片。
 *
 * 返回的切片保证：
 * - `content` 已 trim 且非空（空切片一律不产出 —— 它在检索里会随机命中）；
 * - 除最后一块外，长度不超过 `maxChunkSize`（最后一块由 overlap 前缀 + 尾块构成，
 *   同样受控，因为拼接前会先判断是否放得下）；
 * - `index` 连续从 0 开始；
 * - 数量不超过 `maxChunks`（超出部分丢弃并**不静默** —— 见返回值下方的说明）。
 *
 * 关于 overlap 与 `start`：`start` 取本块**首个新单元**的位置，不含重叠前缀。
 * 重叠前缀来自上一块，指向它会让「这块从原文哪里开始」产生歧义。
 */
export function chunkDocument(
  text: string,
  options: Partial<ChunkingConfig> = {},
): DocumentChunk[] {
  const config: ChunkingConfig = { ...DEFAULT_CHUNKING_CONFIG, ...options };
  const normalized = normalizeText(text);
  if (normalized.length === 0) {
    return [];
  }

  // 极端情况下给出一个「上限为 1」的兜底，避免 maxChunks=0 时静默产出空数组
  const maxChunks = Math.max(1, Math.trunc(config.maxChunks));
  const sections = splitSections(normalized, config);

  const chunks: DocumentChunk[] = [];
  let carry = "";

  const emit = (content: string, section: string, start: number, end: number) => {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return;
    }
    chunks.push({ index: chunks.length, content: trimmed, section, start, end });
  };

  for (const section of sections) {
    let buffer = carry;
    let bufferStart = section.units[0]?.start ?? 0;
    let bufferEnd = bufferStart;

    for (const unit of section.units) {
      const projected =
        buffer.length === 0 ? unit.text.length : buffer.length + unit.text.length + 1;

      if (buffer.length > 0 && projected > config.maxChunkSize) {
        emit(buffer, section.title, bufferStart, bufferEnd);
        carry = tailOf(buffer, config.overlap);
        buffer = carry;
        bufferStart = unit.start;
      }

      if (buffer.length === 0) {
        bufferStart = unit.start;
      }
      buffer = buffer.length === 0 ? unit.text : `${buffer}\n${unit.text}`;
      bufferEnd = unit.end;
    }

    if (buffer.trim().length > 0) {
      /**
       * 尾块过短时并入上一块（同一章节内才合并）：
       * 一个 10 个字的碎片几乎没有区分度，被任何问题命中的概率都很高，
       * 排在结果里只会挤掉真正有信息量的块。
       */
      const isTiny = buffer.trim().length < config.minChunkSize;
      const previous = chunks[chunks.length - 1];
      if (isTiny && previous && previous.section === section.title) {
        previous.content = `${previous.content}\n${buffer.trim()}`;
        previous.end = Math.max(previous.end, bufferEnd);
      } else {
        emit(buffer, section.title, bufferStart, bufferEnd);
      }
    }

    carry = "";
  }

  /**
   * 超出上限时截断，并在最后一块上**明确标注**被截断 ——
   * 悄悄丢掉后半份文档会让「知识库里有这份文档、但问它答不上来」变成一个无法解释的现象。
   */
  if (chunks.length > maxChunks) {
    const limited = chunks.slice(0, maxChunks);
    const last = limited[limited.length - 1];
    if (last) {
      last.content = `${last.content}\n（本文档过长，超出 ${maxChunks} 段的部分未参与检索）`;
    }
    return limited;
  }

  return chunks;
}
