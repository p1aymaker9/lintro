/**
 * Google Translate 免 Key 保底翻译引擎
 *
 * 使用 client=gtx 公开 API，无需 API Key。
 * 通过 \n 连接多句文本一次性发送，减少请求数。
 */

const API = 'https://translate.googleapis.com/translate_a/single';
const MAX_CHARS = 4500;       // 每批最大字符数
const BATCH_DELAY = 350;      // 批次间延迟 (ms)，避免限流

/** YouTube tlang → Google Translate 语言代码映射 */
const LANG_MAP: Record<string, string> = {
  'zh-Hans': 'zh-CN',
  'zh-Hant': 'zh-TW',
};

function toGTLang(code: string): string {
  return LANG_MAP[code] || code;
}

/**
 * 不可见占位符 —— 用来分隔多段文本。
 * Google Translate 会保留此标记并原样输出，
 * 比 \n 可靠，因为 \n 会与原文内嵌的换行混淆。
 */
const SEP = '\n\n|||\n\n';
const SEP_RE = /\s*\|\|\|\s*/;

/**
 * 翻译一批文本
 */
async function translateChunk(
  texts: string[],
  tl: string,
  sl: string,
): Promise<string[]> {
  // 清洗每段文本中的 \n → 空格，防止与分隔符冲突
  const cleaned = texts.map(t => t.replace(/[\r\n]+/g, ' ').trim());
  const joined = cleaned.join(SEP);

  const url = `${API}?${new URLSearchParams({
    client: 'gtx',
    sl,
    tl,
    dt: 't',
    q: joined,
  })}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);

  const data = await res.json();

  // 响应格式: [[["translated", "source", ...], ...], null, "en", ...]
  // data[0] 是翻译段数组，每段 [0] 为译文
  const segments: any[] = data[0] ?? [];
  const full = segments.map((s: any[]) => s[0] ?? '').join('');

  // 用 ||| 标记拆回各段
  const parts = full.split(SEP_RE);

  const result: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push((parts[i] ?? '').trim());
  }
  return result;
}

/**
 * 批量翻译字幕文本
 *
 * @param texts      原文数组
 * @param targetLang YouTube tlang 代码 (如 'zh-Hans')
 * @param sourceLang 源语言代码 (默认 'auto')
 * @returns 翻译后的文本数组（与输入等长）
 */
export async function batchTranslate(
  texts: string[],
  targetLang: string,
  sourceLang = 'auto',
): Promise<string[]> {
  const tl = toGTLang(targetLang);
  const sl = toGTLang(sourceLang);

  // ── 按字符数分批 ─────────────────────────────────────────────────────
  const batches: string[][] = [];
  let cur: string[] = [];
  let curLen = 0;

  for (const t of texts) {
    if (curLen + t.length + 1 > MAX_CHARS && cur.length > 0) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(t);
    curLen += t.length + 1;
  }
  if (cur.length > 0) batches.push(cur);

  // ── 逐批翻译 ─────────────────────────────────────────────────────────
  const all: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, BATCH_DELAY));
    const translated = await translateChunk(batches[i], tl, sl);
    all.push(...translated);
  }

  return all;
}
