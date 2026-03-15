/**
 * Microsoft Translator 翻译引擎
 *
 * 使用 Microsoft Edge 内置的翻译 API 端点（无需 API Key）。
 * 通过 Edge/Bing 公开的 translator API 进行免费翻译。
 *
 * 工作原理：
 * 1. 先获取临时 auth token（匿名，无需 Key）
 * 2. 使用 token 调用 Microsoft Translator API 批量翻译
 */

const AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const TRANSLATE_URL = 'https://api.cognitive.microsofttranslator.com/translate';
const API_VERSION = '3.0';
const MAX_ITEMS_PER_BATCH = 50;   // Microsoft API 单次最多 50 条
const MAX_CHARS_PER_BATCH = 5000; // 单批最大字符数
const BATCH_DELAY = 300;          // 批次间延迟 (ms)

/** YouTube tlang → Microsoft Translator 语言代码映射 */
const LANG_MAP: Record<string, string> = {
  'zh-Hans': 'zh-Hans',
  'zh-Hant': 'zh-Hant',
  'ja': 'ja',
  'ko': 'ko',
  'en': 'en',
  'es': 'es',
  'fr': 'fr',
  'de': 'de',
  'pt': 'pt',
  'ru': 'ru',
  'ar': 'ar',
  'hi': 'hi',
  'it': 'it',
  'nl': 'nl',
  'tr': 'tr',
  'vi': 'vi',
  'th': 'th',
  'id': 'id',
};

function toMSLang(code: string): string {
  return LANG_MAP[code] || code;
}

// ─── Auth Token 缓存 ────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;

/**
 * 获取 Microsoft 翻译认证 Token（匿名、免费）
 * Token 有效期约 10 分钟
 */
async function getAuthToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  const res = await fetch(AUTH_URL);
  if (!res.ok) {
    throw new Error(`Microsoft Auth failed: HTTP ${res.status}`);
  }

  cachedToken = await res.text();
  // Token 有效期约 10 分钟，我们提前 1 分钟刷新
  tokenExpiry = now + 9 * 60 * 1000;

  return cachedToken;
}

/**
 * 翻译一批文本
 */
async function translateChunk(
  texts: string[],
  targetLang: string,
  sourceLang: string,
  token: string,
): Promise<string[]> {
  const params = new URLSearchParams({
    'api-version': API_VERSION,
    to: targetLang,
  });
  if (sourceLang !== 'auto') {
    params.set('from', sourceLang);
  }

  const body = texts.map(t => ({ Text: t.replace(/[\r\n]+/g, ' ').trim() }));

  const res = await fetch(`${TRANSLATE_URL}?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Microsoft Translate HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data: Array<{ translations: Array<{ text: string; to: string }> }> = await res.json();

  return data.map(item => item.translations?.[0]?.text ?? '');
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
  const tl = toMSLang(targetLang);
  const sl = sourceLang === 'auto' ? 'auto' : toMSLang(sourceLang);

  // 获取认证 token
  const token = await getAuthToken();

  // ── 按条数 + 字符数分批 ───────────────────────────────────────────────
  const batches: string[][] = [];
  let cur: string[] = [];
  let curLen = 0;

  for (const t of texts) {
    if ((cur.length >= MAX_ITEMS_PER_BATCH || curLen + t.length > MAX_CHARS_PER_BATCH) && cur.length > 0) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(t);
    curLen += t.length;
  }
  if (cur.length > 0) batches.push(cur);

  // ── 逐批翻译 ─────────────────────────────────────────────────────────
  const all: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, BATCH_DELAY));
    try {
      const translated = await translateChunk(batches[i], tl, sl, token);
      all.push(...translated);
    } catch (err: any) {
      // Token 过期时重试一次
      if (err.message?.includes('401') || err.message?.includes('403')) {
        cachedToken = null;
        tokenExpiry = 0;
        const newToken = await getAuthToken();
        const translated = await translateChunk(batches[i], tl, sl, newToken);
        all.push(...translated);
      } else {
        throw err;
      }
    }
  }

  return all;
}
