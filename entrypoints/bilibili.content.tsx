import cssText from './style.css?inline';
import { createRoot } from 'react-dom/client';
import { useState, useEffect, useCallback } from 'react';
import { normalizeBiliSubtitle } from './lib/subtitle-normalizer';
import type { SubtitleItem } from './lib/subtitle-normalizer';
import { chunkIntoSentences, applyBlockTranslations, applySentenceText } from './lib/sentence-chunker';
import { startSlidingWindow, stop as stopSlidingWindow } from './lib/sliding-window-translator';
import SubtitleOverlay from './components/SubtitleOverlay';
import AnalysisPopover, { type AnalysisRequest } from './components/AnalysisPopover';
import { type CaptionTrack, type LLMConfig } from './lib/storage';

// ─── 全局字幕数据（跨组件通信）────────────────────────────────────────────
let globalSubtitles: SubtitleItem[] = [];
let globalListeners: Array<(subs: SubtitleItem[]) => void> = [];

// ─── 翻译协调状态 ─────────────────────────────────────────────────────────
let originItems: SubtitleItem[] = [];
let translationInProgress = false;
let currentVideoId = '';
let availableTracks: CaptionTrack[] = [];
let currentPrimaryLang = 'auto';

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
      <AnalysisPopover request={analysisReq} onClose={handleCloseAnalysis} />
    </>
  );
}

// ─── 翻译管线（两级降级：LLM → Google Translate）─────────────────────────

/** 翻译状态日志 */
function notifyTranslationStatus(engine: string, status: 'loading' | 'success' | 'error', detail?: string) {
  const msg = status === 'loading' ? `🔄 正在使用 ${engine} 翻译…`
            : status === 'success' ? `✅ ${engine} 翻译完成${detail ? ': ' + detail : ''}`
            : `❌ ${engine} 翻译失败${detail ? ': ' + detail : ''}`;
  console.log(`[翻译状态] ${msg}`);
}

/**
 * 拉取翻译并合并到原文字幕
 *
 * B站翻译管线（两级降级）：
 * 1. LLM 大模型（滑动窗口预翻译）──(失败)──▸
 * 2. Google Translate (gtx)
 *
 * 两条路径均先做句块聚合再翻译。
 */
async function fetchAndApplyTranslation(items: SubtitleItem[]) {
  if (translationInProgress || items.length === 0) return;

  // ── 检查翻译开关 ───────────────────────────────────────────
  const stored = (await browser.storage.local.get(['targetLang', 'llmConfig'])) as {
    targetLang?: string;
    llmConfig?: Partial<LLMConfig>;
  };
  const llmConfig = stored.llmConfig ?? {};

  if (llmConfig.translationEnabled === false) {
    console.log('⛔ 翻译已关闭，跳过翻译流程');
    const blocks = chunkIntoSentences(items);
    applySentenceText(items, blocks);
    setGlobalSubtitles([...items]);
    return;
  }

  translationInProgress = true;

  const targetLang: string = (stored.targetLang as string) || llmConfig.targetLang || 'zh-Hans';
  const useLLM = llmConfig.translateEngine === 'llm' && !!llmConfig.apiKey;
  const useMicrosoft = llmConfig.translateEngine === 'microsoft';

  // ── 预处理：句块聚合 ──────────────────────────────────────────────────
  const blocks = chunkIntoSentences(items);
  const blockTexts = blocks.map(b => b.fullText);
  console.log(`🧩 句块聚合完成: ${items.length} 个片段 → ${blocks.length} 个句块`);

  // ── 策略 1: LLM 大模型翻译（滑动窗口）─────────────────────────────────
  if (useLLM) {
    notifyTranslationStatus(`LLM (${llmConfig.model || 'unknown'})`, 'loading');

    applySentenceText(items, blocks);
    setGlobalSubtitles([...items]);

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
    return;
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
    }
  } catch (e: any) {
    notifyTranslationStatus(fallbackEngine, 'error', e.message);
    console.warn(`⚠️ ${fallbackEngine} 失败:`, e);
  }

  translationInProgress = false;
}

// ─── 字幕轨道加载 ─────────────────────────────────────────────────────────

/** 获取指定字幕轨道的 JSON 并处理 */
async function fetchSubtitleTrack(track: CaptionTrack) {
  let subtitleUrl = track.baseUrl;
  if (subtitleUrl.startsWith('//')) {
    subtitleUrl = 'https:' + subtitleUrl;
  }

  console.log(`🔄 获取字幕: ${track.languageName} (${track.languageCode})`);

  try {
    // B站字幕通常允许跨域 (CORS: *)，直接 fetch 即可
    const res = await fetch(subtitleUrl);
    const json = await res.json();

    if (json?.body && Array.isArray(json.body)) {
      const items = normalizeBiliSubtitle(json.body);
      if (items.length > 0) {
        console.log(`📝 B站字幕归一化完成: ${items.length} 条`);
        originItems = items;
        translationInProgress = false;
        stopSlidingWindow();
        currentPrimaryLang = track.languageCode;
        setGlobalSubtitles(items);
        await fetchAndApplyTranslation(originItems);
        return true;
      }
    }
  } catch (err: any) {
    console.warn('⚠️ 直接 fetch 字幕失败，尝试通过 Background:', err.message);
    // 降级：通过 Background Service Worker 代理获取
    try {
      const response = await browser.runtime.sendMessage({
        action: 'FETCH_SUBTITLES_JSON',
        url: subtitleUrl,
      });
      if (response?.success) {
        const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        if (data?.body && Array.isArray(data.body)) {
          const items = normalizeBiliSubtitle(data.body);
          if (items.length > 0) {
            console.log(`📝 B站字幕归一化完成 (via BG): ${items.length} 条`);
            originItems = items;
            translationInProgress = false;
            stopSlidingWindow();
            currentPrimaryLang = track.languageCode;
            setGlobalSubtitles(items);
            await fetchAndApplyTranslation(originItems);
            return true;
          }
        }
      }
    } catch (e2: any) {
      console.error('⚠️ Background fetch 也失败:', e2.message);
    }
  }

  return false;
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
  await fetchAndApplyTranslation(originItems);
}

// ─── Shadow DOM 挂载 ─────────────────────────────────────────────────────

async function mountShadowUI() {
  // 等待 B站 播放器容器出现
  const waitForPlayer = (): Promise<HTMLElement> =>
    new Promise(resolve => {
      const check = () => {
        const player =
          document.querySelector('.bpx-player-container') ||
          document.querySelector('#bilibili-player') ||
          document.querySelector('.bilibili-player-video-wrap');
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
  player.style.position = 'relative';

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

  console.log('Language Learner: B站 Shadow DOM UI 已挂载');
}

// ─── Content Script 入口 ─────────────────────────────────────────────────

export default defineContentScript({
  matches: ['*://*.bilibili.com/video/*'],
  cssInjectionMode: 'ui',
  async main() {
    console.log('Language Learner: Bilibili Content script mounted.');

    // 1. 将 extractor 注入到页面的 Main World
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('/extractor.js');
    (document.head || document.documentElement).appendChild(script);

    // 2. 挂载 Shadow DOM UI
    mountShadowUI();

    // 辅助：从 URL 中提取视频 ID (BV号或av号)
    function getVideoId(): string {
      const match = window.location.pathname.match(/\/video\/(BV[A-Za-z0-9]+|av\d+)/i);
      return match?.[1] || '';
    }
    currentVideoId = getVideoId();

    // 3. 监听存储变化（语言热切换）
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
            await fetchSubtitleTrack(track);
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

    // 4. 监听来自 extractor 的消息
    window.addEventListener('message', async (event) => {
      const { type, payload } = event.data || {};

      switch (type) {
        // ── 字幕轨道列表 ──────────────────────────────────────────────
        case 'BILI_CAPTIONS_EXTRACTED': {
          const tracks = payload;
          if (!tracks || !Array.isArray(tracks) || tracks.length === 0) return;

          console.log('Content (Bili): 收到字幕轨道:', tracks.map((t: any) => t.lan));

          // 映射并存储可用轨道（供 popup 读取）
          availableTracks = tracks.map((t: any) => ({
            languageCode: t.lan,
            languageName: t.lan_doc,
            baseUrl: t.subtitle_url,
          }));
          browser.storage.local.set({ availableTracks });

          // 重置状态
          originItems = [];
          translationInProgress = false;
          currentPrimaryLang = 'auto';
          stopSlidingWindow();
          setGlobalSubtitles([]);

          // 确定要加载的字幕轨道
          const cfg = ((await browser.storage.local.get('llmConfig')) as { llmConfig?: Partial<LLMConfig> }).llmConfig ?? {};
          const primaryLang = cfg.primarySubLang || 'auto';

          let targetTrack: CaptionTrack | undefined;
          if (primaryLang !== 'auto') {
            targetTrack = availableTracks.find(t => t.languageCode === primaryLang);
          }
          if (!targetTrack) {
            // 默认选第一条轨道
            targetTrack = availableTracks[0];
          }

          if (targetTrack) {
            await fetchSubtitleTrack(targetTrack);
          }
          break;
        }

        // ── 直接拦截到的字幕内容（备用路径）──────────────────────────
        case 'BILI_SUBTITLE_BODY': {
          // 只在尚未获取到字幕数据时处理
          if (originItems.length > 0) break;

          const { body } = payload;
          if (!body || !Array.isArray(body) || body.length === 0) break;

          console.log(`Content (Bili): 直接拦截到字幕数据 (${body.length} 条)`);
          const items = normalizeBiliSubtitle(body);
          if (items.length > 0) {
            originItems = items;
            translationInProgress = false;
            stopSlidingWindow();
            setGlobalSubtitles(items);
            await fetchAndApplyTranslation(originItems);
          }
          break;
        }
      }
    });

    // 5. 监听 B站 SPA 导航（URL 变化检测）
    let lastUrl = window.location.href;
    const checkUrlChange = () => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        const newId = getVideoId();
        if (newId && newId !== currentVideoId) {
          console.log(`🔄 检测到 B站 视频切换: ${currentVideoId} → ${newId}`);
          currentVideoId = newId;
          // 重置全部状态
          originItems = [];
          translationInProgress = false;
          currentPrimaryLang = 'auto';
          availableTracks = [];
          stopSlidingWindow();
          setGlobalSubtitles([]);
          browser.storage.local.set({ availableTracks: [] });
        }
      }
    };

    // 轮询 URL 变化 + popstate 监听
    setInterval(checkUrlChange, 1000);
    window.addEventListener('popstate', checkUrlChange);
  }
});
