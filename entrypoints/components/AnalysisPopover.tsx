import { useState, useEffect, useRef, useCallback } from 'react';
import { extractJsonFromLLM } from '../lib/llm-api';
import type { LLMConfig } from '../lib/storage';

type UiLang = 'zh' | 'en';

const UI_LANG_STORAGE_KEY = 'uiLang';

const I18N = {
  zh: {
    panelTitle: 'AI 语法分析',
    unpin: '取消固定',
    pin: '固定窗口',
    close: '关闭',
    loading: 'AI 分析中…',
    analysisRequestFailed: 'AI 分析请求失败',
    checkConfig: '请检查 API Key 配置或网络连接',
    clickChunk: '点击语块查看详细解析',
    translation: '翻译',
    chunkDetail: '语块详解',
    meaning: '释义',
    grammar: '语法',
    reading: '读音',
    detailLoading: '详细分析加载中…',
    detailNotReady: '详细分析暂未加载',
    parseFailed: '解析失败',
  },
  en: {
    panelTitle: 'AI Grammar Analysis',
    unpin: 'Unpin',
    pin: 'Pin panel',
    close: 'Close',
    loading: 'Analyzing with AI...',
    analysisRequestFailed: 'AI analysis request failed',
    checkConfig: 'Check your API key settings or network connection',
    clickChunk: 'Click a chunk to view detailed analysis',
    translation: 'Translation',
    chunkDetail: 'Chunk Detail',
    meaning: 'Meaning',
    grammar: 'Grammar',
    reading: 'Pronunciation',
    detailLoading: 'Loading detailed analysis...',
    detailNotReady: 'Detailed analysis is not ready yet',
    parseFailed: 'Parse failed',
  },
} as const;

// ─── 数据结构 ─────────────────────────────────────────────────────────────

/** Stage 1: 快速结构（翻译 + 语块基础标签） */
interface FastChunk {
  text: string;
  role: string;
}
interface FastStruct {
  translation: string;
  chunks: FastChunk[];
}

/** Stage 2: 语块深度详解（与 FastChunk 按索引一一对应） */
interface ChunkDetail {
  feature: string;
  reading?: string;
  meaning: string;
  grammar: string[];
  notes: string;
}

/** 完整语法块（合并两阶段数据的视图类型，保留导出兼容） */
export interface GrammarChunk {
  text: string;
  role: string;
  feature: string;
  reading?: string;
  meaning: string;
  grammar: string[];
  notes: string;
}

/** 外部兼容类型 */
export interface GrammarAnalysis {
  translation: string;
  chunks: GrammarChunk[];
}

export interface AnalysisRequest {
  /** 用户点击的原文 */
  sentence: string;
  /** 翻译文本（若有） */
  translation?: string;
  /** 触发点击的屏幕坐标 */
  anchorX: number;
  anchorY: number;
}

interface AnalysisPopoverProps {
  request: AnalysisRequest | null;
  onClose: () => void;
  /** 窗口不透明度 0.3~1.0 */
  opacity?: number;
}

// ─── 无趣的 feature 标签（不值得在卡片底部渲染）───────────────────────────

const BORING_FEATURES = new Set([
  '名词', '动词', '形容词', '副词', '代词', '介词', '连词', '冠词',
  '助词', '感叹词', '数词', '量词', '叹词',
  'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition',
  'conjunction', 'article', 'particle', 'interjection', 'determiner',
]);

// ─── 语块高亮色（用于 role 标签）──────────────────────────────────────────

const ROLE_COLORS = [
  'text-sky-400',
  'text-emerald-400',
  'text-amber-400',
  'text-purple-400',
  'text-rose-400',
  'text-teal-400',
  'text-indigo-400',
  'text-pink-400',
  'text-cyan-400',
  'text-lime-400',
];

const CHUNK_BG_COLORS = [
  'bg-sky-500/15 border-sky-400/25',
  'bg-emerald-500/15 border-emerald-400/25',
  'bg-amber-500/15 border-amber-400/25',
  'bg-purple-500/15 border-purple-400/25',
  'bg-rose-400/15 border-rose-400/25',
  'bg-teal-400/15 border-teal-400/25',
  'bg-indigo-500/15 border-indigo-400/25',
  'bg-pink-400/15 border-pink-400/25',
  'bg-cyan-400/15 border-cyan-400/25',
  'bg-lime-400/15 border-lime-400/25',
];

const CHUNK_ACTIVE_BG = [
  'bg-sky-500/35 border-sky-400/50',
  'bg-emerald-500/35 border-emerald-400/50',
  'bg-amber-500/35 border-amber-400/50',
  'bg-purple-500/35 border-purple-400/50',
  'bg-rose-400/35 border-rose-400/50',
  'bg-teal-400/35 border-teal-400/50',
  'bg-indigo-500/35 border-indigo-400/50',
  'bg-pink-400/35 border-pink-400/50',
  'bg-cyan-400/35 border-cyan-400/50',
  'bg-lime-400/35 border-lime-400/50',
];

// ─── 主组件 ──────────────────────────────────────────────────────────────

export default function AnalysisPopover({ request, onClose, opacity = 0.95 }: AnalysisPopoverProps) {
  const [uiLang, setUiLang] = useState<UiLang>('zh');
  const uiLangRef = useRef<UiLang>('zh');
  const t = I18N[uiLang];
  const [fastStruct, setFastStruct] = useState<FastStruct | null>(null);
  const [details, setDetails] = useState<ChunkDetail[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // 当前展开的语块索引（点击切换展示详解，无需二次请求）
  const [activeChunkIdx, setActiveChunkIdx] = useState<number | null>(null);

  // 缓存最后一次有效 request，pin 后即使 request 变 null 也能保持显示
  const lastReqRef = useRef<AnalysisRequest | null>(null);

  useEffect(() => {
    (async () => {
      const stored = (await browser.storage.local.get(UI_LANG_STORAGE_KEY)) as Record<string, unknown>;
      const next = stored[UI_LANG_STORAGE_KEY] === 'en' ? 'en' : 'zh';
      setUiLang(next);
      uiLangRef.current = next;
    })().catch(() => {
      // Keep zh fallback.
    });
  }, []);

  // ── 字体大小 ──────────────────────────────────────────────────────
  const [fontSize, setFontSize] = useState(14);
  useEffect(() => {
    browser.storage.local.get('llmConfig').then(result => {
      const cfg = (result as { llmConfig?: Partial<LLMConfig> }).llmConfig ?? {};
      if (typeof cfg.analysisFontSize === 'number') setFontSize(cfg.analysisFontSize);
    });
  }, []);

  // ── 拖拽状态 ──────────────────────────────────────────────────────
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  // 当新 request 到来时更新缓存
  useEffect(() => {
    if (request) {
      lastReqRef.current = request;
      setPos(null);
      setActiveChunkIdx(null);
    }
  }, [request]);

  // 计算显示用的 request：pinned 时保持缓存值
  const displayReq = request ?? (pinned ? lastReqRef.current : null);

  // ── 点击外部关闭（未固定时）—— 使用 composedPath 兼容 Shadow DOM ──
  useEffect(() => {
    if (!displayReq || pinned) return;

    const handler: EventListener = (evt) => {
      const e = evt as MouseEvent;
      const path = (typeof e.composedPath === 'function' ? e.composedPath() : []) as EventTarget[];
      if (panelRef.current && path.includes(panelRef.current)) return;
      onClose();
    };

    const timer = setTimeout(() => {
      const root = panelRef.current?.getRootNode();
      if (root && root !== document) {
        (root as ShadowRoot).addEventListener('click', handler, true);
      }
      document.addEventListener('click', handler, true);
    }, 200);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handler, true);
      const root = panelRef.current?.getRootNode();
      if (root && root !== document) {
        (root as ShadowRoot).removeEventListener('click', handler, true);
      }
    };
  }, [displayReq, pinned, onClose]);

  // ── 两段式异步加载：Stage 1 快速结构 → Stage 2 深度详解 ────────────
  useEffect(() => {
    if (!request) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setFastStruct(null);
    setDetails(null);
    setActiveChunkIdx(null);
    if (!pinned) setPinned(false);

    (async () => {
      try {
        // ── Stage 1: 快速结构（翻译 + 语块切分）──────────────────────
        const r1 = await browser.runtime.sendMessage({
          action: 'CALL_LLM_FAST_STRUCT',
          text: request.sentence,
        });

        if (cancelled) return;

        if (!r1?.success) {
          setError(r1?.error || I18N[uiLangRef.current].analysisRequestFailed);
          setLoading(false);
          return;
        }

        const fast = extractJsonFromLLM<FastStruct>(r1.content ?? '');
        setFastStruct(fast);
        setLoading(false); // Stage 1 完成，立即渲染语块卡片

        // ── Stage 2: 深度详解（后台静默加载）─────────────────────────
        setDetailLoading(true);
        try {
          const chunkDesc = fast.chunks
            .map((c, i) => `${i + 1}. "${c.text}" ${c.role}`)
            .join('\n');

          const r2 = await browser.runtime.sendMessage({
            action: 'CALL_LLM_DEEP_DETAIL',
            text: request.sentence,
            context: chunkDesc,
          });

          if (cancelled) return;

          if (r2?.success) {
            const deep = extractJsonFromLLM<{ chunk_details: ChunkDetail[] }>(r2.content ?? '');
            setDetails(deep.chunk_details);
          } else {
            console.warn('Stage 2 deep detail 失败:', r2?.error);
          }
        } catch (e2) {
          console.warn('Stage 2 deep detail 异常:', e2);
        } finally {
          if (!cancelled) setDetailLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          console.error('AI 语法分析失败:', e);
          setError(e.message || I18N[uiLangRef.current].parseFailed);
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [request]);

  // ── 语块点击 → 切换展开/收起（纯本地，无网络请求）─────────────────
  const handleChunkClick = useCallback((idx: number) => {
    setActiveChunkIdx(prev => prev === idx ? null : idx);
  }, []);

  // ── 拖拽实现 ──────────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;

    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragStartRef.current = {
      mx: e.clientX, my: e.clientY,
      px: rect.left, py: rect.top,
    };

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const dx = ev.clientX - dragStartRef.current.mx;
      const dy = ev.clientY - dragStartRef.current.my;
      setPos({ x: dragStartRef.current.px + dx, y: dragStartRef.current.py + dy });
    };

    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // ── 关闭处理 ──────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    setPinned(false);
    lastReqRef.current = null;
    setPos(null);
    setActiveChunkIdx(null);
    onClose();
  }, [onClose]);

  // ── 不渲染 ────────────────────────────────────────────────────────
  if (!displayReq) return null;

  // ── 获取视频播放器边界（兼容 YouTube 和 B站）─────────────────────────
  const getPlayerRect = (): DOMRect | null => {
    const player = document.querySelector('.html5-video-player')
      || document.querySelector('.bpx-player-container')
      || document.querySelector('#bilibili-player');
    return player?.getBoundingClientRect() ?? null;
  };

  // ── 面板定位（限制在视频播放器范围内）──────────────────────────────
  const PANEL_W = 420;
  const PANEL_H_EST = 400;
  const MARGIN = 8;
  const playerRect = getPlayerRect();

  let panelStyle: React.CSSProperties;

  if (pos) {
    let finalX = pos.x;
    let finalY = pos.y;
    if (playerRect) {
      finalX = Math.max(playerRect.left + MARGIN, Math.min(finalX, playerRect.right - PANEL_W - MARGIN));
      finalY = Math.max(playerRect.top + MARGIN, Math.min(finalY, playerRect.bottom - 100));
    }
    panelStyle = {
      position: 'fixed', left: finalX, top: finalY, width: PANEL_W,
      maxHeight: playerRect ? playerRect.height - MARGIN * 2 : 'calc(100vh - 40px)',
      zIndex: 99999, pointerEvents: 'auto', opacity,
    };
  } else if (playerRect) {
    const top = Math.max(playerRect.top + MARGIN, Math.min(displayReq.anchorY - 100, playerRect.bottom - PANEL_H_EST));
    const left = Math.max(playerRect.left + MARGIN, playerRect.right - PANEL_W - MARGIN);
    panelStyle = {
      position: 'fixed', top, left,
      width: Math.min(PANEL_W, playerRect.width - MARGIN * 2),
      maxHeight: playerRect.height - MARGIN * 2,
      zIndex: 99999, pointerEvents: 'auto', opacity,
    };
  } else {
    panelStyle = {
      position: 'fixed',
      top: Math.max(60, Math.min(displayReq.anchorY - 100, window.innerHeight - 500)),
      right: 16, width: PANEL_W,
      maxHeight: 'calc(100vh - 120px)',
      zIndex: 99999, pointerEvents: 'auto', opacity,
    };
  }

  // 基础字号比例
  const fs = fontSize;
  const fsChunkText = fs;                    // 语块原文
  const fsRoleLabel = Math.max(9, fs - 5);   // semantic_role 标签
  const fsPosLabel  = Math.max(8, fs - 6);   // pos 标签
  const fsTranslation = fs;                  // 翻译文
  const fsDetail = Math.max(11, fs - 2);     // 详解区

  return (
    <div ref={panelRef} style={panelStyle}
         className="rounded-xl bg-gray-900/95 border border-white/10
                    shadow-2xl text-gray-100 overflow-hidden flex flex-col">

      {/* ── 标题栏（可拖拽）─────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 shrink-0
                      cursor-grab active:cursor-grabbing select-none"
           onMouseDown={handleDragStart}>
        <span className="font-semibold text-white/90 text-xs tracking-wide uppercase">
          {t.panelTitle}
        </span>
        <div className="flex items-center gap-1"
             onMouseDown={e => e.stopPropagation()}>
          <button
            onClick={() => setPinned(p => !p)}
            className={`p-1.5 rounded-md transition-colors ${
              pinned ? 'bg-blue-500/30 text-blue-300' : 'text-gray-400 hover:text-white hover:bg-white/10'
            }`}
            title={pinned ? t.unpin : t.pin}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                 fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5"/>
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2z"/>
            </svg>
          </button>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            title={t.close}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── 主内容区 ──────────────────────────────────────────────── */}
      <div className="overflow-y-auto flex-1 scrollbar-thin">

        {/* 加载态 */}
        {loading && (
          <div className="flex items-center justify-center py-10 gap-2">
            <div className="w-4 h-4 border-2 border-blue-400/40 border-t-blue-400 rounded-full animate-spin" />
            <span className="text-blue-300/70 text-xs">{t.loading}</span>
          </div>
        )}

        {/* 错误态 */}
        {error && !loading && (
          <div className="py-6 text-center px-4">
            <p className="text-red-400/90 text-xs mb-2">⚠ {error}</p>
            <p className="text-gray-500 text-xs">{t.checkConfig}</p>
          </div>
        )}

        {/* 分析结果（Stage 1 到达后立即渲染） */}
        {fastStruct && !loading && (
          <>
            {/* ═══ 上层：语法块卡片 ═══════════════════════════════════ */}
            <div className="px-3 pt-3 pb-2">
              <div className="flex flex-wrap gap-1 items-end">
                {fastStruct.chunks.map((chunk, i) => {
                  const detail = details?.[i];
                  const colorIdx = i % CHUNK_BG_COLORS.length;
                  const isActive = activeChunkIdx === i;
                  const bgCls = isActive ? CHUNK_ACTIVE_BG[colorIdx] : CHUNK_BG_COLORS[colorIdx];
                  const roleColor = ROLE_COLORS[colorIdx];

                  return (
                    <button
                      key={i}
                      onClick={() => handleChunkClick(i)}
                      className={`flex flex-col items-center rounded-lg border px-2 py-1.5
                                  transition-all cursor-pointer hover:scale-105 max-w-full
                                  ${bgCls} ${isActive ? 'ring-1 ring-white/30' : ''}`}
                    >
                      {/* 顶部：逻辑角色标签（高亮色） */}
                      <span className={`leading-none mb-0.5 whitespace-nowrap font-medium ${roleColor}`}
                            style={{ fontSize: fsRoleLabel }}>
                        {chunk.role}
                      </span>
                      {/* 中间：原文（主体） */}
                      <span className="text-white font-medium leading-snug text-center break-all"
                            style={{ fontSize: fsChunkText }}>
                        {chunk.text}
                      </span>
                      {/* 底部：语法特征标签（Stage 2 到达后显示，空或无聊标签不渲染） */}
                      {detail?.feature && !BORING_FEATURES.has(detail.feature) ? (
                        <span className="text-gray-500 leading-none mt-0.5 whitespace-nowrap"
                              style={{ fontSize: fsPosLabel }}>
                          {detail.feature}
                        </span>
                      ) : detailLoading ? (
                        <span className="text-gray-600 leading-none mt-0.5 whitespace-nowrap animate-pulse"
                              style={{ fontSize: fsPosLabel }}>
                          ···
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <p className="text-gray-600 mt-1.5 text-center" style={{ fontSize: fsPosLabel }}>
                {t.clickChunk}
              </p>
            </div>

            {/* ═══ 下层面板 ═══════════════════════════════════════════ */}
            <div className="border-t border-white/10 px-4 py-3 space-y-2.5">

              {/* 全句翻译（始终显示） */}
              <section>
                <h3 className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">{t.translation}</h3>
                <p className="text-blue-200/90 leading-relaxed" style={{ fontSize: fsTranslation }}>
                  {fastStruct.translation}
                </p>
              </section>

              {/* 语块详解 */}
              {activeChunkIdx !== null && (() => {
                const chunk = fastStruct.chunks[activeChunkIdx];
                const detail = details?.[activeChunkIdx];
                const colorIdx = activeChunkIdx % CHUNK_ACTIVE_BG.length;
                return (
                  <section className="border-t border-white/5 pt-2.5">
                    <div className="flex items-center gap-2 mb-1.5">
                      <h3 className="text-[10px] uppercase tracking-widest text-gray-500">
                        {t.chunkDetail}
                      </h3>
                      <span className={`font-medium px-1.5 py-0.5 rounded border
                        ${CHUNK_ACTIVE_BG[colorIdx]}`} style={{ fontSize: fsDetail }}>
                        {chunk.text}
                      </span>
                    </div>

                    {detail ? (
                      <div className="space-y-2">
                        {/* 释义 */}
                        <div>
                          <span className="text-[10px] text-gray-500 mr-1.5">{t.meaning}</span>
                          <span className="text-white/90" style={{ fontSize: fsDetail }}>
                            {detail.meaning}
                          </span>
                        </div>

                        {/* 语法要点 */}
                        {detail.grammar && detail.grammar.length > 0 && (
                          <div>
                            <span className="text-[10px] text-gray-500 block mb-0.5">{t.grammar}</span>
                            <ul className="space-y-0.5">
                              {detail.grammar.map((g, gi) => (
                                <li key={gi} className="text-gray-300/90 leading-relaxed flex gap-1.5"
                                    style={{ fontSize: fsDetail }}>
                                  <span className="text-yellow-400/70 shrink-0">•</span>
                                  <span>{g}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* 注音 */}
                        {detail.reading && (
                          <div>
                            <span className="text-[10px] text-gray-500 mr-1.5">{t.reading}</span>
                            <span className="text-gray-400" style={{ fontSize: fsDetail }}>
                              {detail.reading}
                            </span>
                          </div>
                        )}

                        {/* 补充说明 */}
                        {detail.notes && (
                          <div>
                            <span className="text-[10px] text-gray-500 mr-1.5">💡</span>
                            <span className="text-gray-400" style={{ fontSize: fsDetail }}>
                              {detail.notes}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : detailLoading ? (
                      <div className="flex items-center gap-2 py-3">
                        <div className="w-3 h-3 border-2 border-blue-400/40 border-t-blue-400 rounded-full animate-spin" />
                        <span className="text-blue-300/70 text-xs">{t.detailLoading}</span>
                      </div>
                    ) : (
                      <p className="text-gray-500 text-xs py-2">{t.detailNotReady}</p>
                    )}
                  </section>
                );
              })()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
