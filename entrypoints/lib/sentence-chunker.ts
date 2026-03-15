/**
 * 句块聚合算法 (Sentence Chunker)
 *
 * YouTube 字幕按 2~3 秒切片，一句话经常被拆成多个短片段。
 * 逐片段翻译会导致语序倒置 / 切分失真。
 *
 * 本模块提供「聚合 → 翻译 → 回映」三步工作流：
 *
 * 1. chunkIntoSentences()
 *    遍历原始 SubtitleItem[]，遇到句末标点（. ? ! 等）就将之前
 *    累积的片段合并为一个 SentenceBlock。
 *
 * 2. 翻译引擎只需翻译 blocks.map(b => b.fullText)，
 *    返回等长的 translations[]。
 *
 * 3. applyBlockTranslations()
 *    将每个 block 的译文回映到 block 内所有原始 SubtitleItem。
 *    同一 block 内的所有短片段共享同一条完整译文。
 */

import type { SubtitleItem } from './subtitle-normalizer';

// ─── 数据结构 ────────────────────────────────────────────────────────────

export interface SentenceBlock {
  /** 该 block 包含的原始 SubtitleItem 索引（在 items[] 中） */
  indices: number[];
  /** 拼接后的完整句子文本（已清洗 \n） */
  fullText: string;
}

// ─── 句末标点正则 ─────────────────────────────────────────────────────────

/**
 * 判断一个片段是否以「句子结尾」收束。
 *
 * 覆盖：
 *   英文句号 . / 问号 ? / 感叹号 ! / 省略号 … / 右方括号 ]
 *   中文句号 。 / 问号 ？ / 感叹号 ！ / 右引号 」/ 右书名号 》
 *
 * 允许句末标点后跟引号 / 括号 / 空格。
 */
const SENTENCE_END_RE = /[.?!…。？！」》\]]["'）)】\s]*$/;

/**
 * 额外缩写白名单 —— 以这些结尾时不视为句末。
 * 避免 "Dr." "U.S." "Mr." 等触发误断。
 */
const ABBREV_RE = /\b(?:Mr|Mrs|Ms|Dr|Prof|Jr|Sr|vs|etc|Inc|Ltd|Co|U\.S|U\.K)\.\s*$/i;

/**
 *「延续型」结尾 —— 以逗号/分号/冒号/破折号等结尾时，
 * 即便下一句以大写开头也不认为是句子边界。
 */
const CONTINUATION_END_RE = /[,;:\-–—]\s*$/;
const CONTINUATION_WORD_RE = /\b(?:and|or|but|nor|for|yet|so|because|although|though|unless|if|when|while|where|which|who|whom|whose|that|than|as|to|of|in|on|at|by|with|from|into|the|a|an|is|are|was|were|be|been|being|have|has|had|not|also|just|then|even|only|still|about)\s*$/i;

/**
 * 下一片段是否以大写字母开头（表示可能是新句开始）。
 * 以 [ 或 ( 开头的也算新句开始。
 */
function startsWithUppercase(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t[0] === '[' || t[0] === '(') return true;
  return t[0] >= 'A' && t[0] <= 'Z';
}

// ─── 最大 block 尺寸 ─────────────────────────────────────────────────────

/** 防止极端情况下 block 过大（如整段演讲无句号） */
const MAX_BLOCK_SIZE = 8;

/**
 * CJK 内容的字符数上限。
 * CJK 每个字符信息密度远高于拉丁字母，同一个 block 内
 * 如果累积的 CJK 字符数超过此值就应该强制 flush，
 * 避免翻译成英文后产生一整段过长文本。
 */
const MAX_CJK_CHARS = 45;

/** CJK 统一表意文字 + 常见扩展区 + 日文假名 + 韩文音节 */
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u3040-\u30FF\u31F0-\u31FF\uAC00-\uD7AF]/g;

/** 统计文本中 CJK 字符数 */
function countCJK(text: string): number {
  const m = text.match(CJK_RE);
  return m ? m.length : 0;
}

// ─── 核心算法 ────────────────────────────────────────────────────────────

/**
 * 将字幕片段按「完整句子」聚合成 SentenceBlock[]。
 *
 * 三重判据：
 *   1. 当前片段以句末标点结尾 → 直接 flush
 *   2. 前瞻启发：当前片段不以逗号/连接词结尾，
 *      且下一片段以大写字母开头 → 认为是句子边界 → flush
 *   3. 累计片段数达到 maxSize → 强制 flush
 *
 * @param items      归一化后的原始字幕
 * @param maxSize    每个 block 最多包含的片段数（默认 8）
 * @returns          SentenceBlock 数组
 */
export function chunkIntoSentences(
  items: SubtitleItem[],
  maxSize: number = MAX_BLOCK_SIZE,
): SentenceBlock[] {
  if (items.length === 0) return [];

  const blocks: SentenceBlock[] = [];
  let curIndices: number[] = [];
  let curTexts: string[] = [];

  for (let i = 0; i < items.length; i++) {
    curIndices.push(i);
    curTexts.push(items[i].text);

    const trimmed = items[i].text.trim();

    // ── 判据 1: 句末标点 ─────────────────────────────────────────────
    const hitPunctuation =
      SENTENCE_END_RE.test(trimmed) && !ABBREV_RE.test(trimmed);

    // ── 判据 2: 前瞻启发式 ───────────────────────────────────────────
    let hitLookahead = false;
    if (
      !hitPunctuation &&
      curIndices.length >= 1 &&
      i + 1 < items.length
    ) {
      const nextText = items[i + 1].text;
      const endsWithContinuation =
        CONTINUATION_END_RE.test(trimmed) ||
        CONTINUATION_WORD_RE.test(trimmed);

      if (!endsWithContinuation && startsWithUppercase(nextText)) {
        hitLookahead = true;
      }
    }

    // ── 判据 3: CJK 字符数上限（防止 CJK→英文 时翻译过长）─────────
    const accumulated = curTexts.join(' ');
    const hitCJKLimit = countCJK(accumulated) >= MAX_CJK_CHARS;

    // ── 判据 4: 硬上限 ───────────────────────────────────────────────
    const hitMaxSize = curIndices.length >= maxSize;

    const shouldFlush =
      hitPunctuation || hitLookahead || hitCJKLimit || hitMaxSize;

    if (shouldFlush || i === items.length - 1) {
      // 构建 fullText：清除残留 \n，合并多余空格
      const fullText = curTexts
        .join(' ')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

      blocks.push({
        indices: [...curIndices],
        fullText,
      });
      curIndices = [];
      curTexts = [];
    }
  }

  return blocks;
}

// ─── 回映 ────────────────────────────────────────────────────────────────

/**
 * 将 block 级别的翻译结果回映到原始 SubtitleItem[]。
 *
 * 同一 block 内所有片段共享同一条完整翻译。
 * 这样在播放任何一个短片段时，UI 都显示完整句子的译文，
 * 消除了逐片段翻译的语序倒置问题。
 *
 * @param items         原始字幕（会被就地修改）
 * @param blocks        chunkIntoSentences 的输出
 * @param translations  翻译结果数组，与 blocks 等长
 */
export function applyBlockTranslations(
  items: SubtitleItem[],
  blocks: SentenceBlock[],
  translations: string[],
): void {
  for (let b = 0; b < blocks.length; b++) {
    const tr = translations[b]?.trim();

    // 无论翻译是否为空，都回填 sentenceText（用于 AI 分析）
    for (const idx of blocks[b].indices) {
      if (idx < items.length) {
        items[idx].sentenceText = blocks[b].fullText;
        if (tr) items[idx].translation = tr;
      }
    }
  }
}

/**
 * 仅回填 sentenceText（不写入 translation）。
 * 用于在翻译完成前就让 AI 分析能拿到完整句。
 */
export function applySentenceText(
  items: SubtitleItem[],
  blocks: SentenceBlock[],
): void {
  for (const b of blocks) {
    for (const idx of b.indices) {
      if (idx < items.length) {
        items[idx].sentenceText = b.fullText;
      }
    }
  }
}
