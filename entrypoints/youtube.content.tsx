import cssText from './style.css?inline';
import { createRoot } from 'react-dom/client';
import { useState, useEffect, useCallback } from 'react';
import { normalizeYTJson3, normalizeYTXml } from './lib/subtitle-normalizer';
import type { SubtitleItem } from './lib/subtitle-normalizer';
import { chunkIntoSentences, applyBlockTranslations, applySentenceText } from './lib/sentence-chunker';
import { startSlidingWindow, stop as stopSlidingWindow } from './lib/sliding-window-translator';
import SubtitleOverlay from './components/SubtitleOverlay';
import AnalysisPopover, { type AnalysisRequest } from './components/AnalysisPopover';
import { loadConfig, type CaptionTrack, type LLMConfig } from './lib/storage';

// ─── 全局字幕数据（跨组件通信）────────────────────────────────────────────
let globalSubtitles: SubtitleItem[] = [];
let globalListeners: Array<(subs: SubtitleItem[]) => void> = [];

// ─── 翻译协调状态 ─────────────────────────────────────────────────────────
let originItems: SubtitleItem[] = [];     // 已归一化的原文字幕
let pendingBaseUrl: string | null = null; // baseUrl 先于原文到达时暂存
let lastKnownBaseUrl: string | null = null; // 缓存上次 baseUrl（CC 开关重触发用）
let translationInProgress = false;        // 防止重复触发
let currentVideoId = '';                  // 当前视频 ID（检测视频切换）
let availableTracks: CaptionTrack[] = []; // 当前视频可用的字幕轨道
let currentPrimaryLang = 'auto';          // 当前显示的主字幕语言
let skipInterceptedData = false;          // 正在加载指定语言时跳过拦截数据
let ccAutoToggleDone = false;             // 标记本视频是否已完成自动 CC 切换

function isYouTubeAdShowing(): boolean {
  const player = document.querySelector('#movie_player, .html5-video-player');
  return !!player?.classList.contains('ad-showing');
}

function setGlobalSubtitles(subs: SubtitleItem[]) {
  globalSubtitles = subs;
  globalListeners.forEach(fn => fn(subs));
}

function useGlobalSubtitles(): SubtitleItem[] {
  const [subs, setSubs] = useState<SubtitleItem[]>(globalSubtitles);
  useEffect(() => {
    globalListeners.push(setSubs);
    return () => {
      globalListeners = globalListeners.filter(fn => fn !== setSubs);
    };
  }, []);
  return subs;
}

// ─── React 根组件 ────────────────────────────────────────────────────────
function App() {
  const subtitles = useGlobalSubtitles();
  const [analysisReq, setAnalysisReq] = useState<AnalysisRequest | null>(null);

  const handleAnalysisRequest = useCallback((req: AnalysisRequest) => {
    setAnalysisReq(req);
  }, []);

  const handleCloseAnalysis = useCallback(() => {
    setAnalysisReq(null);
  }, []);

  return (
    <>
      <SubtitleOverlay subtitles={subtitles} onAnalysisRequest={handleAnalysisRequest} />
      {/* AnalysisPopover 在 App 顶层，不受字幕显隐影响 */}
      <AnalysisPopover request={analysisReq} onClose={handleCloseAnalysis} />
    </>
  );
}

// ─── 翻译拉取 + 降级逻辑 ─────────────────────────────────────────────────

/** 将翻译轨道按 startTime 合并到原文 */
function mergeTranslations(origin: SubtitleItem[], trans: SubtitleItem[]) {
  const transMap = new Map<string, string>();
  for (const item of trans) {
    transMap.set(item.startTime.toFixed(2), item.text);
  }
  for (const item of origin) {
    const tr = transMap.get(item.startTime.toFixed(2));
    if (tr && tr !== item.text) item.translation = tr;
  }
}

/** 向页面发送翻译状态通知（用户可在控制台和 UI 中看到） */
function notifyTranslationStatus(engine: string, status: 'loading' | 'success' | 'error', detail?: string) {
  const msg = status === 'loading' ? `🔄 正在使用 ${engine} 翻译…`
            : status === 'success' ? `✅ ${engine} 翻译完成${detail ? ': ' + detail : ''}`
            : `❌ ${engine} 翻译失败${detail ? ': ' + detail : ''}`;
  console.log(`[翻译状态] ${msg}`);
  // 后续可通过 postMessage 更新 UI 状态栏
}

/**
 * 拉取翻译并合并到原文字幕
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  翻译管线（三级降级）                                    │
 * │                                                         │
 * │  1. LLM 大模型  ──(失败)──▸                             │
 * │  2. YouTube 官方 tlang ──(失败)──▸                      │
 * │  3. Google Translate (gtx)                              │
 * │                                                         │
 * │  对 LLM / Google 两条路径，先做句块聚合再翻译：         │
 * │    聚合 → 翻译 → 回映                                   │
 * │  YouTube 官方翻译自带对齐，走 mergeTranslations 路径。  │
 * └─────────────────────────────────────────────────────────┘
 */
async function fetchAndApplyTranslation(baseUrl: string, items: SubtitleItem[]) {
  if (translationInProgress || items.length === 0) return;

  // ── 检查翻译开关 ───────────────────────────────────────────
  const stored = (await browser.storage.local.get(['targetLang', 'llmConfig'])) as {
    targetLang?: string;
    llmConfig?: Partial<LLMConfig>;
  };
  const llmConfig = stored.llmConfig ?? {};

  if (llmConfig.translationEnabled === false) {
    console.log('⛔ 翻译已关闭，跳过翻译流程');
    // 即使关闭翻译，也回填 sentenceText 以便 AI 分析使用
    const blocks = chunkIntoSentences(items);
    applySentenceText(items, blocks);
    setGlobalSubtitles([...items]);
    return;
  }

  translationInProgress = true;

  // 读取用户完整配置
  const targetLang: string = (stored.targetLang as string) || llmConfig.targetLang || 'zh-Hans';
  const useLLM = llmConfig.translateEngine === 'llm' && !!llmConfig.apiKey;
  const useMicrosoft = llmConfig.translateEngine === 'microsoft';

  // ── 预处理：句块聚合 ──────────────────────────────────────────────────
  const blocks = chunkIntoSentences(items);
  const blockTexts = blocks.map(b => b.fullText);
  console.log(`🧩 句块聚合完成: ${items.length} 个片段 → ${blocks.length} 个句块`);
  blocks.slice(0, 5).forEach((b, i) => {
    console.log(`  句块[${i}] (片段 ${b.indices[0]}~${b.indices[b.indices.length - 1]}): "${b.fullText.slice(0, 80)}${b.fullText.length > 80 ? '…' : ''}"`);
  });

  // ── 策略 0: LLM 大模型翻译 —— 滑动窗口预翻译 ──────────────────────────
  if (useLLM) {
    notifyTranslationStatus(`LLM (${llmConfig.model || 'unknown'})`, 'loading');

    // 先回填 sentenceText（AI 分析可立即使用完整句）
    applySentenceText(items, blocks);
    setGlobalSubtitles([...items]);

    // 启动滑动窗口预翻译（异步分批，按播放进度提前翻译）
    startSlidingWindow({
      items,
      blocks,
      onUpdate: (updatedItems) => {
        setGlobalSubtitles(updatedItems);
      },
      sendTranslate: async (texts) => {
        const result = await browser.runtime.sendMessage({
          action: 'LLM_BATCH_TRANSLATE',
          texts,
        });
        return result ?? { success: false, error: 'no response' };
      },
    });

    console.log(`🪟 滑动窗口预翻译已启动 (${blocks.length} 个句块，LLM: ${llmConfig.model})`);
    translationInProgress = false;
    return; // 翻译由滑动窗口异步完成，不走降级
  }

  // ── 策略 1: YouTube 官方翻译 (tlang) ——仅当 engine=google 时尝试 ────
  // YouTube 官方翻译自带时间对齐，不需要句块聚合
  if (!useMicrosoft) {
    notifyTranslationStatus('YouTube 官方翻译', 'loading');
    const transUrl = baseUrl + '&fmt=json3&tlang=' + targetLang;
    console.log('🌐 尝试 YouTube 官方翻译:', transUrl);

    try {
      const resp = await browser.runtime.sendMessage({
        action: 'FETCH_SUBTITLES_JSON',
        url: transUrl,
      });

      if (resp?.success && resp.data) {
        const parsed = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
        if (parsed?.events) {
          const transItems = normalizeYTJson3(parsed);
          if (transItems.length > 0) {
            mergeTranslations(items, transItems);
            const count = items.filter(i => i.translation).length;
            notifyTranslationStatus('YouTube 官方翻译', 'success', `${count}/${items.length} 条`);
            console.log('📋 YouTube 翻译样本 (前5条):');
            items.slice(0, 5).forEach((it, idx) => {
              console.log(`  [${idx}] "${it.text}" → "${it.translation ?? '(无)'}"`);
            });
            setGlobalSubtitles([...items]);
            translationInProgress = false;
            return;
          }
        }
      }
      notifyTranslationStatus('YouTube 官方翻译', 'error', '数据为空或无 events');
    } catch (e: any) {
      notifyTranslationStatus('YouTube 官方翻译', 'error', e.message);
      console.warn('⚠️ YouTube 翻译拉取失败:', e);
    }
  }

  // ── 策略 2: Microsoft / Google Translate 保底（使用句块聚合）───────────
  const fallbackEngine = useMicrosoft ? 'Microsoft Translate' : 'Google Translate';
  const fallbackAction = useMicrosoft ? 'MICROSOFT_BATCH_TRANSLATE' : 'BATCH_TRANSLATE';
  notifyTranslationStatus(fallbackEngine, 'loading');
  console.log(`⚡ ${fallbackEngine} 翻译... 发送 ${blocks.length} 个句块`);
  try {
    const result = await browser.runtime.sendMessage({
      action: fallbackAction,
      texts: blockTexts,
      targetLang,
    });

    if (result?.success && result.translations) {
      applyBlockTranslations(items, blocks, result.translations);
      const count = items.filter(i => i.translation).length;
      notifyTranslationStatus(fallbackEngine, 'success', `${count}/${items.length} 条`);
      setGlobalSubtitles([...items]);
    } else {
      notifyTranslationStatus(fallbackEngine, 'error', result?.error || '返回失败');
      console.warn(`⚠️ ${fallbackEngine} 返回失败:`, result?.error);
    }
  } catch (e: any) {
    notifyTranslationStatus(fallbackEngine, 'error', e.message);
    console.warn(`⚠️ ${fallbackEngine} 失败:`, e);
  }

  translationInProgress = false;
}

// ─── 字幕语言切换 ─────────────────────────────────────────────────────────

/** 从 baseUrl 中剥离 fmt / tlang 参数 */
function stripTimedtextParams(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('fmt');
    u.searchParams.delete('tlang');
    return u.toString();
  } catch {
    return rawUrl.replace(/[&?]fmt=[^&]*/g, '').replace(/[&?]tlang=[^&]*/g, '');
  }
}

/** 主动加载指定语言的字幕轨道 */
async function fetchSpecificTrack(track: CaptionTrack) {
  const fetchUrl = track.baseUrl + '&fmt=json3';
  console.log(`🔄 切换主字幕: ${track.languageName} (${track.languageCode})`);
  try {
    const resp = await browser.runtime.sendMessage({
      action: 'FETCH_SUBTITLES_JSON',
      url: fetchUrl,
    });
    if (resp?.success && resp.data) {
      const parsed = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
      if (parsed?.events) {
        const items = normalizeYTJson3(parsed);
        if (items.length > 0) {
          originItems = items;
          translationInProgress = false;
          stopSlidingWindow();
          currentPrimaryLang = track.languageCode;
          skipInterceptedData = false;
          const baseUrl = stripTimedtextParams(track.baseUrl);
          lastKnownBaseUrl = baseUrl;
          setGlobalSubtitles(items);
          await fetchAndApplyTranslation(baseUrl, originItems);
          return;
        }
      }
    }
    console.warn('⚠️ 获取特定轨道字幕失败，保留当前字幕');
    skipInterceptedData = false;
  } catch (e: any) {
    console.warn('⚠️ 获取特定轨道字幕错误:', e.message);
    skipInterceptedData = false;
  }
}

/** 重新翻译当前字幕（目标语言切换后触发） */
async function retranslateCurrentSubtitles() {
  if (originItems.length === 0) return;
  for (const item of originItems) {
    item.translation = undefined;
  }
  translationInProgress = false;
  stopSlidingWindow();
  setGlobalSubtitles([...originItems]);
  if (lastKnownBaseUrl) {
    await fetchAndApplyTranslation(lastKnownBaseUrl, originItems);
  }
}

// ─── 自动 CC 开关（降低用户门槛）──────────────────────────────────────────
/**
 * 如果用户没有手动打开 CC 字幕，YouTube 不会发起 timedtext 请求，
 * 策略 A 无法拦截。此函数自动快速开关一次 CC 按钮，触发字幕数据加载，
 * 最终确保 CC 处于关闭状态，避免与扩展自身字幕重叠。
 *
 * 需在 tracks 发现且等待一段时间后仍未获取到字幕数据时调用。
 */
function autoCCToggle() {
  if (ccAutoToggleDone) return;
  ccAutoToggleDone = true;

  const ccBtn = document.querySelector('.ytp-subtitles-button') as HTMLButtonElement | null;
  if (!ccBtn) {
    console.log('AutoCC: 未找到 CC 按钮');
    return;
  }

  const isOn = ccBtn.getAttribute('aria-pressed') === 'true';

  if (isOn) {
    // CC 已开启，说明 timedtext 请求已/在发送；确保关闭以避免重叠
    console.log('AutoCC: CC 已开启，关闭以避免字幕重叠');
    ccBtn.click();
    return;
  }

  // CC 关闭 → 开启触发 timedtext 请求 → 等数据拦截到后再关闭
  console.log('AutoCC: 打开 CC 以触发字幕加载…');
  ccBtn.click();

  // 等拦截完成后关闭 CC（监听 originItems 填充或超时 3s）
  let waited = 0;
  const poll = setInterval(() => {
    waited += 200;
    if (originItems.length > 0 || waited >= 3000) {
      clearInterval(poll);
      // 再次检查 CC 状态，如果还是开着就关掉
      if (ccBtn.getAttribute('aria-pressed') === 'true') {
        ccBtn.click();
        console.log('AutoCC: 字幕数据已获取，CC 已自动关闭');
      }
    }
  }, 200);
}

// ─── Shadow DOM 挂载 ─────────────────────────────────────────────────────

async function mountShadowUI() {
  // 等待视频播放器容器出现
  const waitForPlayer = (): Promise<HTMLElement> =>
    new Promise(resolve => {
      const check = () => {
        const player = document.querySelector('.html5-video-player');
        if (player) return resolve(player as HTMLElement);
        setTimeout(check, 500);
      };
      check();
    });

  const player = await waitForPlayer();

  // 检查是否已挂载
  if (player.querySelector('#ll-subtitle-host')) return;

  // 创建 Host 容器
  const host = document.createElement('div');
  host.id = 'll-subtitle-host';
  host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:60;';
  player.style.position = 'relative'; // 确保 player 是定位参考

  // 附加 Shadow Root
  const shadow = host.attachShadow({ mode: 'open' });

  // 注入 Tailwind 样式到 Shadow DOM
  const styleEl = document.createElement('style');
  styleEl.textContent = cssText;
  shadow.appendChild(styleEl);

  // 创建 React 挂载点
  const mountPoint = document.createElement('div');
  mountPoint.id = 'll-react-root';
  shadow.appendChild(mountPoint);

  // 挂载到 DOM
  player.appendChild(host);

  // 启动 React
  const root = createRoot(mountPoint);
  root.render(<App />);

  console.log('Language Learner: Shadow DOM UI 已挂载');
}

// ─── Content Script 入口 ─────────────────────────────────────────────────

export default defineContentScript({
  matches: ['*://*.youtube.com/watch*'],
  cssInjectionMode: 'ui',
  async main() {
    console.log('Language Learner: Content script mounted.');

    // 1. 将 extractor 注入到页面的 Main World
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('/extractor.js');
    (document.head || document.documentElement).appendChild(script);

    // 2. 挂载 Shadow DOM UI
    mountShadowUI();

    // 辅助：从 URL 中提取视频 ID
    function getVideoId(): string {
      const params = new URLSearchParams(window.location.search);
      return params.get('v') || '';
    }
    currentVideoId = getVideoId();

    // 3. 检测 YouTube SPA 导航（视频切换）
    //    yt-navigate-finish 在 YouTube 单页导航完成后触发
    window.addEventListener('yt-navigate-finish', () => {
      const newId = getVideoId();
      if (newId && newId !== currentVideoId) {
        console.log(`🔄 检测到视频切换: ${currentVideoId} → ${newId}`);
        currentVideoId = newId;
        // 立即清空旧数据
        originItems = [];
        pendingBaseUrl = null;
        lastKnownBaseUrl = null;
        translationInProgress = false;
        currentPrimaryLang = 'auto';
        availableTracks = [];
        skipInterceptedData = false;
        ccAutoToggleDone = false;
        stopSlidingWindow();
        setGlobalSubtitles([]);
        browser.storage.local.set({ availableTracks: [] });
      }
    });

    // 4. 监听存储变化（语言热切换）
    browser.storage.onChanged.addListener(async (changes) => {
      const configChange = changes.llmConfig;
      if (!configChange) return;

      const oldCfg = (configChange.oldValue ?? {}) as Partial<LLMConfig>;
      const newCfg = (configChange.newValue ?? {}) as Partial<LLMConfig>;

      // 主字幕语言切换
      if (oldCfg.primarySubLang !== newCfg.primarySubLang) {
        const newLang = newCfg.primarySubLang || 'auto';
        console.log(`🌍 主字幕语言切换: ${oldCfg.primarySubLang || 'auto'} → ${newLang}`);
        if (newLang === 'auto') {
          currentPrimaryLang = 'auto';
        } else if (newLang !== currentPrimaryLang) {
          const track = availableTracks.find(t => t.languageCode === newLang);
          if (track) {
            await fetchSpecificTrack(track);
          } else {
            console.warn(`⚠️ 未找到语言 ${newLang} 的字幕轨道`);
          }
        }
      }

      // 翻译目标语言切换
      if (oldCfg.targetLang !== newCfg.targetLang && newCfg.targetLang) {
        console.log(`🌍 翻译目标语言切换: ${oldCfg.targetLang} → ${newCfg.targetLang}`);
        await retranslateCurrentSubtitles();
      }

      // Lintro 开关: 关→开 时重新触发翻译
      if (oldCfg.translationEnabled === false && newCfg.translationEnabled !== false) {
        console.log('🔄 Lintro 已重新启用，重新触发翻译');
        await retranslateCurrentSubtitles();
      }
    });

    // 5. 监听来自 extractor 的多策略数据
    window.addEventListener('message', async (event) => {
      const { type, payload } = event.data || {};

      switch (type) {
        // ── 字幕轨道列表（视频切换时重置状态）──────────────────────
        case 'YT_CAPTIONS_TRACKS': {
          if (isYouTubeAdShowing()) {
            console.log('⏭️ 广告播放中，忽略广告字幕轨道');
            break;
          }
          const tracks = payload;
          console.log('Content: 发现字幕轨道:', tracks.map((t: any) => t.languageCode));

          // 映射并存储可用轨道（供 popup 读取）
          availableTracks = tracks.map((t: any) => ({
            languageCode: t.languageCode,
            languageName: t.name?.simpleText || t.languageCode,
            baseUrl: t.baseUrl,
            kind: t.kind,
          }));
          browser.storage.local.set({ availableTracks });

          // 新视频 → 重置全部状态 + 清空显示
          originItems = [];
          pendingBaseUrl = null;
          lastKnownBaseUrl = null;
          translationInProgress = false;
          currentPrimaryLang = 'auto';
          skipInterceptedData = false;
          stopSlidingWindow();
          setGlobalSubtitles([]);

          // 如果用户指定了主字幕语言，主动加载对应轨道
          const cfg = ((await browser.storage.local.get('llmConfig')) as { llmConfig?: Partial<LLMConfig> }).llmConfig ?? {};
          const primaryLang = cfg.primarySubLang || 'auto';
          if (primaryLang !== 'auto') {
            const track = availableTracks.find(t => t.languageCode === primaryLang);
            if (track) {
              skipInterceptedData = true;
              fetchSpecificTrack(track);
            }
          } else {
            // 自动模式：等待 2 秒，若策略 A 未拦截到数据则自动开关 CC
            setTimeout(() => {
              if (originItems.length === 0 && availableTracks.length > 0) {
                console.log('AutoCC: 2s 内未拦截到字幕数据，尝试自动触发 CC…');
                autoCCToggle();
              }
            }, 2000);
          }
          break;
        }

        // ── 策略 A: 拦截到的完整字幕 JSON ────────────────────────────
        case 'YT_SUBTITLE_JSON': {
          if (isYouTubeAdShowing()) {
            console.log('⏭️ 广告播放中，忽略广告字幕数据');
            break;
          }
          if (skipInterceptedData) {
            console.log('⏭️ 跳过拦截数据（正在加载指定语言字幕）');
            break;
          }
          const { languageCode, languageName, data, source } = payload;
          console.log(`🔥🔥🔥 SUCCESS [${source}]! Subtitle [${languageCode}] (${languageName})`);

          const items = normalizeYTJson3(data);
          console.log(`📝 归一化完成: ${items.length} 条字幕`, items.slice(0, 3));

          if (items.length > 0) {
            originItems = items;
            // 清除旧翻译标记，允许重新触发（CC 开关场景）
            translationInProgress = false;
            stopSlidingWindow(); // 停止旧的滑动窗口
            setGlobalSubtitles(items); // 立即显示原文（翻译稍后到达）

            // baseUrl 若已先到达，现在触发翻译
            if (pendingBaseUrl) {
              const base = pendingBaseUrl;
              pendingBaseUrl = null;
              fetchAndApplyTranslation(base, originItems);
            } else if (lastKnownBaseUrl) {
              // CC 重新开启场景：用缓存的 baseUrl 重新触发翻译
              fetchAndApplyTranslation(lastKnownBaseUrl, originItems);
            }
          }
          break;
        }

        // ── 策略 A: 拦截到原始文本（XML 格式）──────────────────────
        case 'YT_SUBTITLE_RAW': {
          if (isYouTubeAdShowing()) {
            console.log('⏭️ 广告播放中，忽略广告字幕 XML');
            break;
          }
          if (skipInterceptedData) {
            console.log('⏭️ 跳过拦截数据（正在加载指定语言字幕）');
            break;
          }
          const { rawText, url, source } = payload;
          console.log(`🔥🔥🔥 SUCCESS [${source}]! Raw subtitle (${rawText.length} chars)`);

          const items = normalizeYTXml(rawText);
          console.log(`📝 XML 归一化完成: ${items.length} 条字幕`, items.slice(0, 3));

          if (items.length > 0) {
            originItems = items;
            translationInProgress = false;
            stopSlidingWindow();
            setGlobalSubtitles(items);

            if (pendingBaseUrl) {
              const base = pendingBaseUrl;
              pendingBaseUrl = null;
              fetchAndApplyTranslation(base, originItems);
            } else if (lastKnownBaseUrl) {
              fetchAndApplyTranslation(lastKnownBaseUrl, originItems);
            }
          }
          break;
        }

        // ── 策略 B: Player API 轨道信息 ────────────────────────────
        case 'YT_PLAYER_TRACKLIST': {
          const { tracklist, source } = payload;
          console.log(`📋 Player API tracklist [${source}]:`, tracklist);
          break;
        }

        // ── 策略 C: DOM 实时观测字幕 ────────────────────────────────
        case 'YT_CAPTION_REALTIME': {
          const { currentTime, text } = payload;
          console.log(`💬 [${currentTime.toFixed(1)}s] ${text}`);
          break;
        }

        // ── baseUrl 到达 → 触发翻译拉取 ────────────────────────────
        case 'YT_SUBTITLE_BASEURL': {
          if (isYouTubeAdShowing()) {
            console.log('⏭️ 广告播放中，忽略广告字幕 baseUrl');
            break;
          }
          const { baseUrl } = payload;
          console.log('📡 收到 baseUrl:', baseUrl);

          // 缓存 baseUrl 以便 CC 重新开启时复用
          lastKnownBaseUrl = baseUrl;

          // CC 开关场景：重置翻译状态，允许重新翻译
          translationInProgress = false;
          stopSlidingWindow();

          if (originItems.length > 0) {
            // 原文已就绪，立即拉取翻译
            fetchAndApplyTranslation(baseUrl, originItems);
          } else {
            // 原文尚未到达，暂存 baseUrl
            pendingBaseUrl = baseUrl;
            console.log('📡 等待原文字幕数据到达...');
          }
          break;
        }
      }
    });
  }
});
