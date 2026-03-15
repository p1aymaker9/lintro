import { useState, useEffect, useRef, useCallback } from 'react';
import type { SubtitleItem } from '../lib/subtitle-normalizer';
import type { AnalysisRequest } from './AnalysisPopover';

interface SubtitleOverlayProps {
  subtitles: SubtitleItem[];
  onAnalysisRequest: (req: AnalysisRequest) => void;
}

/**
 * 字幕叠加层组件
 *
 * 使用 requestAnimationFrame 高频轮询 <video> 的 currentTime，
 * 实时匹配当前应显示的字幕条目。
 *
 * UI 设计：
 * - 绝对定位在视频底部
 * - 深色半透明背景
 * - 上行原文，下行翻译
 * - 点击字幕触发 AI 语法分析（发送完整聚合句）
 */
export default function SubtitleOverlay({ subtitles, onAnalysisRequest }: SubtitleOverlayProps) {
  const [currentItem, setCurrentItem] = useState<SubtitleItem | null>(null);
  const rafRef = useRef<number>(0);
  const lastIndexRef = useRef<number>(-1);
  const [translationRevealed, setTranslationRevealed] = useState(false); // 遮盖模式下临时显示

  // ── 控制栏可见时自动上移（兼容 YouTube / Bilibili）─────────────────
  // YouTube:  .html5-video-player 带 ytp-autohide  → 控制栏已隐藏
  // Bilibili: .bpx-player-container 带 bpx-player-transition-end-hide → 控制栏已隐藏
  const [controlsVisible, setControlsVisible] = useState(false);
  useEffect(() => {
    let observer: MutationObserver | null = null;
    let retryTimer: ReturnType<typeof setTimeout>;

    const setup = (): boolean => {
      // YouTube
      const ytPlayer = document.querySelector('.html5-video-player');
      if (ytPlayer) {
        const update = () => setControlsVisible(!ytPlayer.classList.contains('ytp-autohide'));
        update();
        observer = new MutationObserver(update);
        observer.observe(ytPlayer, { attributes: true, attributeFilter: ['class'] });
        return true;
      }
      // Bilibili (bpx-player)
      const biliPlayer = document.querySelector('.bpx-player-container');
      if (biliPlayer) {
        const update = () =>
          setControlsVisible(!biliPlayer.classList.contains('bpx-player-transition-end-hide'));
        update();
        observer = new MutationObserver(update);
        observer.observe(biliPlayer, { attributes: true, attributeFilter: ['class'] });
        return true;
      }
      return false;
    };

    if (!setup()) {
      // 元素尚未挂载，1s 后重试一次
      retryTimer = setTimeout(() => setup(), 1000);
    }

    return () => {
      clearTimeout(retryTimer);
      observer?.disconnect();
    };
  }, []);

  // ── 显示配置（全量读取 + 实时监听）────────────────────────────────
  const [subtitleFontSize, setSubtitleFontSize] = useState(18);
  const [subtitlePosition, setSubtitlePosition] = useState<'top' | 'bottom'>('bottom');
  const [originalColor, setOriginalColor] = useState('#ffffff');
  const [translationColor, setTranslationColor] = useState('#93c5fd');
  const [bgStyle, setBgStyle] = useState<'none' | 'semi' | 'solid'>('semi');
  const [originalFirst, setOriginalFirst] = useState(true);
  const [coverMode, setCoverMode] = useState(false);
  const [hotkeyAnalysis, setHotkeyAnalysis] = useState('Alt+A');
  const [hotkeyReplay, setHotkeyReplay] = useState('Alt+R');
  const [hotkeyReveal, setHotkeyReveal] = useState('Alt+S');
  const [enabled, setEnabled] = useState(true); // Lintro 总开关

  const applyConfig = useCallback((cfg: any) => {
    if (cfg.subtitleFontSize != null) setSubtitleFontSize(cfg.subtitleFontSize);
    if (cfg.subtitlePosition) setSubtitlePosition(cfg.subtitlePosition);
    if (cfg.subtitleOriginalColor) setOriginalColor(cfg.subtitleOriginalColor);
    if (cfg.subtitleTranslationColor) setTranslationColor(cfg.subtitleTranslationColor);
    if (cfg.subtitleBgStyle) setBgStyle(cfg.subtitleBgStyle);
    if (cfg.subtitleOriginalFirst != null) setOriginalFirst(cfg.subtitleOriginalFirst);
    if (cfg.coverMode != null) setCoverMode(cfg.coverMode);
    if (cfg.hotkeyAnalysis) setHotkeyAnalysis(cfg.hotkeyAnalysis);
    if (cfg.hotkeyReplay) setHotkeyReplay(cfg.hotkeyReplay);
    if (cfg.hotkeyReveal) setHotkeyReveal(cfg.hotkeyReveal);
    if (cfg.translationEnabled != null) setEnabled(cfg.translationEnabled);
  }, []);

  useEffect(() => {
    browser.storage.local.get('llmConfig').then(result => {
      applyConfig(result.llmConfig ?? {});
    });
    const onChanged = (changes: { [key: string]: any }) => {
      const newCfg = changes.llmConfig?.newValue;
      if (newCfg) applyConfig(newCfg);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [applyConfig]);

  // 二分查找当前时间对应的字幕
  const findSubtitle = useCallback(
    (time: number): SubtitleItem | null => {
      if (subtitles.length === 0) return null;

      // 从上次位置附近线性搜索（局部性原理，绝大多数情况 O(1)）
      const lastIdx = lastIndexRef.current;
      if (lastIdx >= 0 && lastIdx < subtitles.length) {
        const item = subtitles[lastIdx];
        if (time >= item.startTime && time < item.endTime) return item;
        // 检查下一条
        if (lastIdx + 1 < subtitles.length) {
          const next = subtitles[lastIdx + 1];
          if (time >= next.startTime && time < next.endTime) {
            lastIndexRef.current = lastIdx + 1;
            return next;
          }
        }
      }

      // 回退到二分查找
      let lo = 0, hi = subtitles.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const item = subtitles[mid];
        if (time < item.startTime) {
          hi = mid - 1;
        } else if (time >= item.endTime) {
          lo = mid + 1;
        } else {
          lastIndexRef.current = mid;
          return item;
        }
      }
      return null;
    },
    [subtitles]
  );

  useEffect(() => {
    const video = document.querySelector('video');
    if (!video || subtitles.length === 0) return;

    let prevText = '';

    const tick = () => {
      // ── 广告检测：YouTube 播放广告时 player 节点带有 .ad-showing ──
      const player = document.querySelector('.html5-video-player');
      if (player?.classList.contains('ad-showing')) {
        // 广告期间隐藏字幕
        if (prevText !== '') {
          prevText = '';
          setCurrentItem(null);
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const item = findSubtitle(video.currentTime);
      const text = item?.text ?? '';

      // 仅在字幕变化时更新 state，避免无意义 re-render
      if (text !== prevText) {
        prevText = text;
        setCurrentItem(item);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [subtitles, findSubtitle]);

  // ── 字幕切换时重置遮盖状态 ─────────────────────────────────────────
  const prevItemRef = useRef<SubtitleItem | null>(null);
  useEffect(() => {
    if (currentItem !== prevItemRef.current) {
      setTranslationRevealed(false);
      prevItemRef.current = currentItem;
    }
  }, [currentItem]);

  // ── 快捷键处理 ────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      if (e.metaKey) parts.push('Meta');
      if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      }
      const combo = parts.join('+');
      if (!combo || parts.length === 0) return;

      // 触发 AI 分析
      if (combo === hotkeyAnalysis && currentItem) {
        e.preventDefault();
        const sentence = currentItem.sentenceText || currentItem.text;
        onAnalysisRequest({
          sentence,
          translation: currentItem.translation,
          anchorX: window.innerWidth / 2,
          anchorY: window.innerHeight / 2,
        });
      }

      // 重播当前句
      if (combo === hotkeyReplay && currentItem) {
        e.preventDefault();
        const video = document.querySelector('video');
        if (video) {
          video.currentTime = currentItem.startTime;
          if (video.paused) video.play();
        }
      }

      // 遮盖模式下显示译文
      if (combo === hotkeyReveal && coverMode) {
        e.preventDefault();
        setTranslationRevealed(true);
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [hotkeyAnalysis, hotkeyReplay, hotkeyReveal, currentItem, coverMode, onAnalysisRequest]);

  // ── 点击字幕 → 触发 AI 分析（使用完整聚合句） ─────────────────────
  const handleSubtitleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!currentItem) return;
      e.stopPropagation();

      // 优先使用 sentenceText（完整聚合句），兜底用原文片段
      const sentence = currentItem.sentenceText || currentItem.text;

      onAnalysisRequest({
        sentence,
        translation: currentItem.translation,
        anchorX: e.clientX,
        anchorY: e.clientY,
      });
    },
    [currentItem, onAnalysisRequest]
  );

  if (!enabled || !currentItem) return null;

  // ── 计算样式 ──────────────────────────────────────────────────────
  const controlOffset = controlsVisible ? 68 : 12;
  const positionStyle = subtitlePosition === 'top'
    ? { top: 12, transition: 'top 0.2s ease' }
    : { bottom: controlOffset, transition: 'bottom 0.2s ease' };

  const bgClass = bgStyle === 'none'
    ? ''
    : bgStyle === 'solid'
      ? 'bg-black'
      : 'bg-black/70 backdrop-blur-sm';

  const showTranslation = currentItem.translation && (!coverMode || translationRevealed);

  const originalLine = (
    <p className="leading-relaxed font-medium tracking-wide"
       style={{ fontSize: subtitleFontSize, color: originalColor }}>
      {currentItem.text}
    </p>
  );

  const translationLine = showTranslation ? (
    <p className="leading-relaxed mt-1 opacity-90"
       style={{ fontSize: Math.max(12, subtitleFontSize - 2), color: translationColor }}>
      {currentItem.translation}
    </p>
  ) : coverMode && currentItem.translation ? (
    <p className="leading-relaxed mt-1 cursor-pointer select-none"
       style={{ fontSize: Math.max(12, subtitleFontSize - 2), color: translationColor }}
       onClick={e => { e.stopPropagation(); setTranslationRevealed(true); }}>
      <span className="inline-block bg-gray-600/80 rounded px-1 text-transparent hover:text-transparent">
        {currentItem.translation}
      </span>
    </p>
  ) : null;

  return (
    <div className="absolute left-0 right-0 flex justify-center z-[9999] px-4"
         style={{ pointerEvents: 'none', ...positionStyle }}>
      <div
        className={`max-w-[80%] rounded-lg px-5 py-3 text-center shadow-lg
                   cursor-pointer hover:bg-black/80 transition-colors ${bgClass}`}
        style={{ pointerEvents: 'auto' }}
        onClick={handleSubtitleClick}
        title="点击进行 AI 语法分析"
      >
        {originalFirst ? (
          <>{originalLine}{translationLine}</>
        ) : (
          <>{translationLine}{originalLine}</>
        )}
      </div>
    </div>
  );
}
