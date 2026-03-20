/**
 * 滑动窗口预翻译 (Sliding Window Pre-translation)
 *
 * 当用户选择 LLM 引擎时，不再一次性发送全部句块翻译（延迟高），
 * 而是按播放进度分批预翻译，保证用户看到的字幕在到达前就已就绪。
 *
 * 工作原理：
 * 1. 视频开始播放时，立即翻译当前位置起的第一个窗口 (WINDOW_SIZE 个句块)
 * 2. RAF 持续监控 video.currentTime，当播放指针接近已翻译区域末尾时，
 *    提前触发下一个窗口的翻译
 * 3. 翻译结果缓存在原始 SubtitleItem[] 上，通过回调通知 UI 更新
 */

import type { SubtitleItem } from './subtitle-normalizer';
import type { SentenceBlock } from './sentence-chunker';

// 降噪：仅静默 console.log，保留 console.warn/error。
const console = Object.assign({}, globalThis.console, {
  log: (..._args: unknown[]) => {},
}) as Console;

// ─── 配置 ────────────────────────────────────────────────────────────────

/** 每次发送给 LLM 的句块数 */
const WINDOW_SIZE = 10;

/** 距离已翻译区域末尾还有多少个句块时，触发下一批预翻译 */
const PREFETCH_THRESHOLD = 3;

// ─── 类型 ────────────────────────────────────────────────────────────────

interface SWConfig {
  items: SubtitleItem[];
  blocks: SentenceBlock[];
  /** 翻译完成后的回调，参数为更新后的 items 副本 */
  onUpdate: (items: SubtitleItem[]) => void;
  /** 发送翻译请求（封装 browser.runtime.sendMessage） */
  sendTranslate: (texts: string[]) => Promise<{ success: boolean; translations?: string[]; error?: string }>;
}

// ─── 状态 ────────────────────────────────────────────────────────────────

let items: SubtitleItem[] = [];
let blocks: SentenceBlock[] = [];
let onUpdate: SWConfig['onUpdate'] = () => {};
let sendTranslate: SWConfig['sendTranslate'] = async () => ({ success: false });

let translatedSet = new Set<number>();   // 已完成翻译的 block 索引
let inFlightSet = new Set<number>();     // 正在翻译中的 block 索引
let rafId = 0;
let active = false;

// ─── 公开 API ────────────────────────────────────────────────────────────

/**
 * 启动滑动窗口预翻译。
 * 调用后会立即翻译第一个窗口，并开始 RAF 监控播放进度。
 */
export function startSlidingWindow(config: SWConfig): void {
  stop(); // 先停掉旧实例

  items = config.items;
  blocks = config.blocks;
  onUpdate = config.onUpdate;
  sendTranslate = config.sendTranslate;
  translatedSet = new Set();
  inFlightSet = new Set();
  active = true;

  // 立即翻译第一个窗口（从 block 0 开始）
  void translateWindow(0);

  // 启动播放进度监控
  startMonitor();
}

/**
 * 停止滑动窗口。切换视频 / 切换引擎时调用。
 */
export function stop(): void {
  active = false;
  cancelAnimationFrame(rafId);
  translatedSet.clear();
  inFlightSet.clear();
}

/**
 * 返回当前翻译进度 (0~1)。
 */
export function progress(): number {
  if (blocks.length === 0) return 1;
  return translatedSet.size / blocks.length;
}

// ─── 内部实现 ────────────────────────────────────────────────────────────

/** 找到 time 所在的 block 索引（线性扫描，blocks 通常 < 200） */
function findBlockAtTime(time: number): number {
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    const firstIdx = block.indices[0];
    const lastIdx = block.indices[block.indices.length - 1];
    if (firstIdx >= items.length || lastIdx >= items.length) continue;

    const start = items[firstIdx].startTime;
    const end = items[lastIdx].endTime;
    if (time >= start && time < end) return b;
  }
  // 如果在所有 block 之前，返回 0
  if (blocks.length > 0 && items.length > 0) {
    const firstStart = items[blocks[0].indices[0]].startTime;
    if (time < firstStart) return 0;
  }
  return -1;
}

/** 从 fromBlock 开始，找到下一个未翻译且未在途的连续窗口起点 */
function findNextWindow(fromBlock: number): number {
  for (let i = Math.max(0, fromBlock); i < blocks.length; i++) {
    if (!translatedSet.has(i) && !inFlightSet.has(i)) return i;
  }
  return -1;
}

/** 检查某个 block 位置附近是否需要预取 */
function needsPrefetch(currentBlock: number): boolean {
  // 查看从 currentBlock 往后 PREFETCH_THRESHOLD 个 block 是否都已翻译
  for (let i = currentBlock; i < Math.min(currentBlock + PREFETCH_THRESHOLD, blocks.length); i++) {
    if (!translatedSet.has(i) && !inFlightSet.has(i)) return true;
  }
  // 同时检查 PREFETCH_THRESHOLD 之后的范围
  const lookAheadEnd = Math.min(currentBlock + WINDOW_SIZE, blocks.length);
  for (let i = currentBlock + PREFETCH_THRESHOLD; i < lookAheadEnd; i++) {
    if (!translatedSet.has(i) && !inFlightSet.has(i)) return true;
  }
  return false;
}

/** RAF 播放进度监控 */
function startMonitor(): void {
  const video = document.querySelector('video');
  if (!video) return;

  const tick = () => {
    if (!active) return;

    const currentBlock = findBlockAtTime(video.currentTime);
    if (currentBlock >= 0 && needsPrefetch(currentBlock)) {
      const windowStart = findNextWindow(currentBlock);
      if (windowStart >= 0) {
        void translateWindow(windowStart);
      }
    }

    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
}

/** 翻译一个窗口的句块 */
async function translateWindow(fromBlock: number): Promise<void> {
  if (!active) return;

  // 收集窗口内需要翻译的 block 索引
  const windowIndices: number[] = [];
  for (let i = fromBlock; i < blocks.length && windowIndices.length < WINDOW_SIZE; i++) {
    if (!translatedSet.has(i) && !inFlightSet.has(i)) {
      windowIndices.push(i);
    }
  }

  if (windowIndices.length === 0) return;

  // 标记为在途
  for (const idx of windowIndices) inFlightSet.add(idx);

  const textsToTranslate = windowIndices.map(i => blocks[i].fullText);
  const rangeLabel = `${windowIndices[0]}~${windowIndices[windowIndices.length - 1]}`;

  console.log(`🪟 滑动窗口: 翻译句块 [${rangeLabel}] (${textsToTranslate.length} 块)`);

  try {
    const result = await sendTranslate(textsToTranslate);

    if (!active) return; // 可能已被 stop()

    if (result.success && result.translations) {
      // 将翻译回映到 items
      for (let j = 0; j < windowIndices.length; j++) {
        const blockIdx = windowIndices[j];
        const tr = result.translations[j]?.trim();
        const block = blocks[blockIdx];

        for (const itemIdx of block.indices) {
          if (itemIdx < items.length) {
            items[itemIdx].sentenceText = block.fullText;
            if (tr) items[itemIdx].translation = tr;
          }
        }
        translatedSet.add(blockIdx);
      }

      // 清除在途标记
      for (const idx of windowIndices) inFlightSet.delete(idx);

      // 通知 UI 更新
      onUpdate([...items]);

      const done = translatedSet.size;
      const total = blocks.length;
      console.log(`🪟 窗口 [${rangeLabel}] 翻译完成 (进度 ${done}/${total})`);
    } else {
      for (const idx of windowIndices) inFlightSet.delete(idx);
      console.warn(`⚠️ 窗口 [${rangeLabel}] 翻译失败:`, result.error);
    }
  } catch (e) {
    for (const idx of windowIndices) inFlightSet.delete(idx);
    console.warn(`⚠️ 窗口 [${rangeLabel}] 翻译异常:`, e);
  }
}
