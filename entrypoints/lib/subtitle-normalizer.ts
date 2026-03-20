// ─── 标准字幕数据结构 ───────────────────────────────────────────────────────

/**
 * 归一化后的字幕条目
 */
export interface SubtitleItem {
  startTime: number;  // 开始时间（秒）
  endTime: number;    // 结束时间（秒）
  text: string;       // 原文文本
  translation?: string; // 翻译文本（后续 AI 填充）
  sentenceText?: string; // 该片段所属的完整聚合句原文
}

// ─── YouTube JSON3 格式 ──────────────────────────────────────────────────────

interface YTJson3Seg {
  utf8?: string;
  acAsrConf?: number;
}

interface YTJson3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: YTJson3Seg[];
  wWinId?: number;
  aAppend?: number;
}

interface YTJson3Data {
  wireMagic?: string;
  events?: YTJson3Event[];
}

/**
 * 将 YouTube JSON3 格式清洗为标准 SubtitleItem[]
 *
 * JSON3 结构：
 * {
 *   wireMagic: "pb3",
 *   events: [
 *     { tStartMs: 1230, dDurationMs: 4560, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
 *     ...
 *   ]
 * }
 *
 * 清洗规则：
 * 1. 过滤没有 segs 的 event
 * 2. 将 segs 中所有 utf8 字符串拼接
 * 3. 过滤空文本和纯换行符
 * 4. 毫秒转秒
 */
export function normalizeYTJson3(data: YTJson3Data): SubtitleItem[] {
  if (!data?.events) return [];

  const items: SubtitleItem[] = [];
  const lastIndexByWindow = new Map<number, number>();

  for (const event of data.events) {
    // 必须有 segs 和时间信息
    if (!event.segs || event.tStartMs == null) continue;

    // 拼接所有 seg 中的 utf8 文本
    // YouTube 用 \n 做视觉换行，非语义，统一替换为空格
    const text = event.segs
      .map(seg => seg.utf8 ?? '')
      .join('')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // 过滤空文本
    if (!text || /^\s*$/.test(text)) continue;

    const startTime = event.tStartMs / 1000;
    const duration = (event.dDurationMs ?? 0) / 1000;
    const endTime = startTime + duration;

    // YouTube 有时会把同一句后半段作为 aAppend 事件追加到同一窗口。
    // 若不合并，会出现只显示第一行/前半句的问题。
    const isAppend = event.aAppend === 1;
    const winId = event.wWinId;
    if (isAppend) {
      const idx = typeof winId === 'number' ? lastIndexByWindow.get(winId) : undefined;
      const targetIdx = typeof idx === 'number'
        ? idx
        : (items.length > 0 ? items.length - 1 : -1);

      if (targetIdx >= 0) {
        const prev = items[targetIdx];
        const mergedText = `${prev.text} ${text}`.replace(/\s{2,}/g, ' ').trim();
        // 避免重复追加完全相同内容
        if (mergedText !== prev.text) {
          prev.text = mergedText;
        }
        prev.endTime = Math.max(prev.endTime, endTime);
        if (typeof winId === 'number') {
          lastIndexByWindow.set(winId, targetIdx);
        }
        continue;
      }
    }

    items.push({ startTime, endTime, text });
    if (typeof winId === 'number') {
      lastIndexByWindow.set(winId, items.length - 1);
    }
  }

  return items;
}

// ─── Bilibili JSON 格式 ─────────────────────────────────────────────────────

interface BiliSubtitleBody {
  from: number;
  to: number;
  content: string;
}

/**
 * 将 B站字幕 JSON body 清洗为标准 SubtitleItem[]
 */
export function normalizeBiliSubtitle(
  body: BiliSubtitleBody[]
): SubtitleItem[] {
  if (!body || !Array.isArray(body)) return [];

  return body
    .filter(item => item.content && item.content.trim())
    .map(item => ({
      startTime: item.from,
      endTime: item.to,
      text: item.content.trim(),
    }));
}

// ─── XML 格式解析 ────────────────────────────────────────────────────────────

/**
 * 将 YouTube XML 字幕（旧格式）清洗为标准 SubtitleItem[]
 *
 * XML 格式：
 * <transcript>
 *   <text start="1.23" dur="4.56">Hello world</text>
 *   ...
 * </transcript>
 */
export function normalizeYTXml(xmlText: string): SubtitleItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const textNodes = doc.querySelectorAll('text');
  const items: SubtitleItem[] = [];

  textNodes.forEach(node => {
    const start = parseFloat(node.getAttribute('start') ?? '0');
    const dur = parseFloat(node.getAttribute('dur') ?? '0');
    // XML 中的 HTML entities 需要解码；\n → 空格
    const text = (node.textContent ?? '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!text || /^\s*$/.test(text)) return;

    items.push({
      startTime: start,
      endTime: start + dur,
      text,
    });
  });

  return items;
}
