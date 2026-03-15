import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FREE_TRIAL_DAILY_LIMIT,
  FREE_TRIAL_PROFILE_ID,
  FREE_TRIAL_PROFILE_NAME,
  SUPPORTED_LANGUAGES,
} from '../lib/constants';
import {
  loadConfig, saveConfig, loadAvailableTracks, loadProfiles, saveProfiles,
  migrateToProfiles, findProfile, createProfile, PROVIDER_PRESETS,
  DEFAULT_CONFIG,
  type LLMConfig, type ApiProvider, type ApiProfile, type CaptionTrack,
} from '../lib/storage';

// ─── 常量 ────────────────────────────────────────────────────────────────

const PROVIDERS: { value: ApiProvider; label: string }[] = [
  { value: 'openai',      label: 'OpenAI' },
  { value: 'deepseek',    label: 'DeepSeek' },
  { value: 'zhipu',       label: '智谱清言 (GLM)' },
  { value: 'kimi',        label: 'Kimi (Moonshot)' },
  { value: 'siliconflow', label: '硅基流动 (SiliconFlow)' },
  { value: 'custom',      label: '自定义 / 第三方中转' },
];

const ENGINE_OPTIONS = [
  { value: 'google'    as const, label: 'Google Translate (免费)' },
  { value: 'microsoft' as const, label: 'Microsoft Translate (免费)' },
  { value: 'llm'       as const, label: 'LLM 大模型翻译' },
];

type Tab = 'settings' | 'api';

// ─── 通用样式 ────────────────────────────────────────────────────────────

const inputCls =
  'w-full rounded-lg bg-gray-800 border border-gray-700 text-white text-sm px-3 py-2 ' +
  'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-gray-500';
const selectCls = inputCls + ' appearance-none cursor-pointer pr-8';
const labelCls  = 'block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5';
const inlineLabelCls = 'text-xs font-medium text-gray-400 uppercase tracking-wider shrink-0 w-24';

function SelectArrow() {
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-400">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  );
}

// ─── 主组件 ──────────────────────────────────────────────────────────────

function App() {
  const [config, setConfig]           = useState<LLMConfig>(DEFAULT_CONFIG);
  const [profiles, setProfiles]       = useState<ApiProfile[]>([]);
  const [loaded, setLoaded]           = useState(false);
  const [tab, setTab]                 = useState<Tab>('settings');
  const [editingId, setEditingId]     = useState<string>('');        // 当前编辑的 profile ID
  const [availableTracks, setAvailableTracks] = useState<CaptionTrack[]>([]);
  const [displayOpen, setDisplayOpen] = useState(false);             // 显示设置折叠
  const [shortcutsOpen, setShortcutsOpen] = useState(false);       // 快捷键折叠
  const [testStatus, setTestStatus]   = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [toast, setToast]             = useState('');

  // 用 ref 追踪最新 config/profiles，避免 debounce 闭包问题
  const latestConfig   = useRef(config);
  const latestProfiles = useRef(profiles);
  latestConfig.current   = config;
  latestProfiles.current = profiles;

  // ── 预热 enable_thinking 兼容性缓存（尽量不让用户首次翻译失败）──────
  const primeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPrimedKey = useRef<string>('');
  useEffect(() => {
    if (!loaded) return;
    if (!config.translationEnabled) return;
    if (config.translateEngine !== 'llm') return;

    const p = findProfile(profiles, config.translateProfileId);
    if (!p?.apiKey || !p.apiEndpoint || !p.model) return;

    const key = `${p.apiEndpoint}|${p.model}`;
    if (key === lastPrimedKey.current) return;
    lastPrimedKey.current = key;

    if (primeTimer.current) clearTimeout(primeTimer.current);
    primeTimer.current = setTimeout(() => {
      browser.runtime.sendMessage({
        action: 'PRIME_THINKING_SUPPORT',
        profile: { apiKey: p.apiKey, apiEndpoint: p.apiEndpoint, model: p.model },
      }).catch(() => void 0);
    }, 600);

    return () => {
      if (primeTimer.current) clearTimeout(primeTimer.current);
    };
  }, [loaded, config.translationEnabled, config.translateEngine, config.translateProfileId, profiles]);

  // ── 预热分析配置（非试用）：分析更常触发网络请求，尽量避免首次失败 ──
  const primeAnalysisTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPrimedAnalysisKey = useRef<string>('');
  useEffect(() => {
    if (!loaded) return;
    // 免费试用走 Cloudflare Worker，不需要也不应该在此处预热第三方模型能力
    if (config.analysisProfileId === FREE_TRIAL_PROFILE_ID) return;

    const p = findProfile(profiles, config.analysisProfileId);
    if (!p?.apiKey || !p.apiEndpoint || !p.model) return;

    const key = `${p.apiEndpoint}|${p.model}`;
    if (key === lastPrimedAnalysisKey.current) return;
    lastPrimedAnalysisKey.current = key;

    if (primeAnalysisTimer.current) clearTimeout(primeAnalysisTimer.current);
    primeAnalysisTimer.current = setTimeout(() => {
      browser.runtime.sendMessage({
        action: 'PRIME_THINKING_SUPPORT',
        profile: { apiKey: p.apiKey, apiEndpoint: p.apiEndpoint, model: p.model },
      }).catch(() => void 0);
    }, 600);

    return () => {
      if (primeAnalysisTimer.current) clearTimeout(primeAnalysisTimer.current);
    };
  }, [loaded, config.analysisProfileId, profiles]);

  // ── 初始化 ─────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const { config: cfg, profiles: profs } = await migrateToProfiles();
      const tracks = await loadAvailableTracks();
      setConfig(cfg);
      setProfiles(profs);
      setEditingId(profs[0]?.id ?? '');
      setAvailableTracks(tracks);
      setLoaded(true);
    })();

    const onStorageChange = (changes: { [key: string]: any }) => {
      if (changes.availableTracks?.newValue) {
        setAvailableTracks(changes.availableTracks.newValue);
      }
    };
    browser.storage.onChanged.addListener(onStorageChange);
    return () => browser.storage.onChanged.removeListener(onStorageChange);
  }, []);

  // ── 自动保存 config（防抖 400ms）────────────────────────────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistConfig = useCallback((cfg: LLMConfig) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await saveConfig(cfg);
      // 同步 targetLang 给 content script
      await browser.storage.local.set({ targetLang: cfg.targetLang });
    }, 400);
  }, []);

  const updateConfig = useCallback(<K extends keyof LLMConfig>(key: K, value: LLMConfig[K]) => {
    setConfig(prev => {
      const next = { ...prev, [key]: value };
      persistConfig(next);
      return next;
    });
  }, [persistConfig]);

  // ── 自动保存 profiles（防抖 400ms）─────────────────────────────────
  const profTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistProfiles = useCallback((profs: ApiProfile[]) => {
    if (profTimer.current) clearTimeout(profTimer.current);
    profTimer.current = setTimeout(() => saveProfiles(profs), 400);
  }, []);

  // ── Profile CRUD helpers ───────────────────────────────────────────
  const currentProfile = profiles.find(p => p.id === editingId) ?? profiles[0];

  const updateCurrentProfile = useCallback((patch: Partial<ApiProfile>) => {
    setProfiles(prev => {
      const next = prev.map(p => (p.id === editingId ? { ...p, ...patch, tested: undefined } : p));
      persistProfiles(next);
      return next;
    });
  }, [editingId, persistProfiles]);

  const handleProviderChange = useCallback((provider: ApiProvider) => {
    const preset = PROVIDER_PRESETS[provider];
    updateCurrentProfile({
      provider,
      apiEndpoint: preset.endpoint || currentProfile?.apiEndpoint || '',
      model: preset.model || currentProfile?.model || '',
    });
  }, [updateCurrentProfile, currentProfile]);

  const addProfile = useCallback(() => {
    const np = createProfile();
    setProfiles(prev => {
      const next = [...prev, np];
      persistProfiles(next);
      return next;
    });
    setEditingId(np.id);
    setTestStatus('idle');
  }, [persistProfiles]);

  const deleteProfile = useCallback(() => {
    if (profiles.length <= 1) return;
    setProfiles(prev => {
      const next = prev.filter(p => p.id !== editingId);
      persistProfiles(next);
      // 如果删除的是当前翻译/分析引用的 profile，重置为第一个
      setConfig(cfg => {
        let changed = false;
        const patch: Partial<LLMConfig> = {};
        if (cfg.translateProfileId === editingId) {
          patch.translateProfileId = next[0]?.id ?? '';
          changed = true;
        }
        if (cfg.analysisProfileId === editingId) {
          patch.analysisProfileId = FREE_TRIAL_PROFILE_ID;
          changed = true;
        }
        if (changed) {
          const updated = { ...cfg, ...patch };
          persistConfig(updated);
          return updated;
        }
        return cfg;
      });
      setEditingId(next[0]?.id ?? '');
      return next;
    });
    setTestStatus('idle');
  }, [editingId, profiles.length, persistProfiles, persistConfig]);

  // ── API 连通性测试 ─────────────────────────────────────────────────
  const testApi = useCallback(async () => {
    if (!currentProfile) return;
    setTestStatus('testing');
    try {
      const resp = await browser.runtime.sendMessage({
        action: 'TEST_API_PROFILE',
        profile: {
          apiKey: currentProfile.apiKey,
          apiEndpoint: currentProfile.apiEndpoint,
          model: currentProfile.model,
        },
      });
      const ok = resp?.success === true;
      setTestStatus(ok ? 'ok' : 'fail');
      // 持久化测试状态
      setProfiles(prev => {
        const next = prev.map(p => (p.id === editingId ? { ...p, tested: ok } : p));
        saveProfiles(next);
        return next;
      });
      if (!ok) setToast(resp?.error ?? '连接失败');
    } catch {
      setTestStatus('fail');
      setToast('测试请求出错');
    }
  }, [currentProfile, editingId]);

  // ── 渲染 ───────────────────────────────────────────────────────────

  if (!loaded) {
    return <div className="w-80 p-6 bg-gray-950 text-gray-500 text-center text-sm">加载中…</div>;
  }

  // 找到翻译/分析使用的 profile 名称
  const translateProfile = findProfile(profiles, config.translateProfileId);
  const isTrialAnalysis = config.analysisProfileId === FREE_TRIAL_PROFILE_ID;
  const analysisProfile  = isTrialAnalysis ? null : findProfile(profiles, config.analysisProfileId);

  return (
    <div className="w-80 bg-gray-950 text-white font-sans max-h-[580px] flex flex-col">
      {/* ── 标题栏 ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-900 border-b border-gray-800">
        <span className="text-lg">🌐</span>
        <h1 className="text-sm font-semibold tracking-wide">Lintro</h1>
      </div>

      {/* ── Tab 栏 ────────────────────────────────────────────────── */}
      <div className="flex border-b border-gray-800">
        {([
          ['settings', '设置'],
          ['api',      'API 配置'],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex-1 text-xs font-medium py-2.5 transition-colors border-b-2 ${
              tab === key
                ? 'text-blue-400 border-blue-400 bg-gray-900/50'
                : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── 内容区域 ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4">

        {/* ═══════════════════  翻译设置 Tab ═══════════════════════ */}
        {tab === 'settings' && (
          <div className="space-y-3">

            {/* Lintro 总开关 */}
            <div className="flex items-center justify-between">
              <label className={labelCls + ' mb-0'}>Lintro 字幕</label>
              <button
                onClick={() => updateConfig('translationEnabled', !config.translationEnabled)}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  config.translationEnabled ? 'bg-blue-500' : 'bg-gray-600'
                }`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  config.translationEnabled ? 'translate-x-5' : 'translate-x-0'
                }`} />
              </button>
            </div>

            {/* 主字幕语言 */}
            <div className="flex items-center gap-2">
              <label className={inlineLabelCls}>主字幕语言</label>
              <div className="relative flex-1">
                <select value={config.primarySubLang}
                  onChange={e => updateConfig('primarySubLang', e.target.value)}
                  className={selectCls}>
                  <option value="auto">自动 (视频默认)</option>
                  {availableTracks.map(t => (
                    <option key={t.languageCode} value={t.languageCode}>
                      {t.languageName}{t.kind === 'asr' ? ' (自动生成)' : ''}
                    </option>
                  ))}
                </select>
                <SelectArrow />
              </div>
            </div>
            {availableTracks.length === 0 && (
              <p className="text-[10px] text-gray-500 -mt-2 pl-26">打开 YouTube / Bilibili 视频后可选择字幕</p>
            )}

            {/* 翻译目标语言 */}
            <div className="flex items-center gap-2">
              <label className={inlineLabelCls}>目标语言</label>
              <div className="relative flex-1">
                <select value={config.targetLang}
                  onChange={e => updateConfig('targetLang', e.target.value)}
                  className={selectCls}>
                  {SUPPORTED_LANGUAGES.map(l => (
                    <option key={l.code} value={l.code}>{l.name}</option>
                  ))}
                </select>
                <SelectArrow />
              </div>
            </div>

            {/* 翻译引擎 */}
            <div className="border-t border-gray-800 pt-2.5">
              <div className="flex items-center gap-2 mb-2">
                <label className={inlineLabelCls}>翻译引擎</label>
                <div className="relative flex-1">
                  <select value={config.translateEngine}
                    onChange={e => updateConfig('translateEngine', e.target.value as 'llm' | 'google' | 'microsoft')}
                    className={selectCls}>
                    {ENGINE_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <SelectArrow />
                </div>
              </div>

              {/* LLM 翻译时：选择使用的 API 配置 */}
              {config.translateEngine === 'llm' && (
                <div className="flex items-center gap-2">
                  <label className={inlineLabelCls}>翻译配置</label>
                  <div className="relative flex-1">
                    <select value={config.translateProfileId}
                      onChange={e => updateConfig('translateProfileId', e.target.value)}
                      className={selectCls}>
                      {profiles.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}{p.tested === true ? ' ✅' : p.tested === false ? ' ❌' : ''}
                        </option>
                      ))}
                    </select>
                    <SelectArrow />
                  </div>
                </div>
              )}
            </div>

            {/* AI 分析引擎配置选择 */}
            <div className="border-t border-gray-800 pt-2.5">
              <div className="flex items-center gap-2">
                <label className={inlineLabelCls}>分析配置</label>
                <div className="relative flex-1">
                  <select value={config.analysisProfileId}
                    onChange={e => updateConfig('analysisProfileId', e.target.value)}
                    className={selectCls}>
                    <option value={FREE_TRIAL_PROFILE_ID}>{FREE_TRIAL_PROFILE_NAME}（每日 {FREE_TRIAL_DAILY_LIMIT} 次）</option>
                    {profiles.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.tested === true ? ' ✅' : p.tested === false ? ' ❌' : ''}
                      </option>
                    ))}
                  </select>
                  <SelectArrow />
                </div>
              </div>
            </div>

            {/* ── 显示设置（可折叠）──────────────────────────────────── */}
            <div className="border-t border-gray-800 pt-2.5">
              <button onClick={() => setDisplayOpen(o => !o)}
                className="flex items-center justify-between w-full group">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">🎨</span>
                  <label className={labelCls + ' mb-0 cursor-pointer'}>显示设置</label>
                </div>
                <svg className={`w-4 h-4 text-gray-500 transition-transform ${displayOpen ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              <div className={`overflow-hidden transition-all duration-300 ${
                displayOpen ? 'max-h-[800px] opacity-100 mt-3' : 'max-h-0 opacity-0'
              }`}>
                {/* 字幕字体 */}
                <SliderField label="字幕字体大小" unit="px"
                  value={config.subtitleFontSize} min={12} max={32} step={1}
                  onChange={v => updateConfig('subtitleFontSize', v)} />
                {/* 分析窗口字体 */}
                <SliderField label="分析窗口字体大小" unit="px"
                  value={config.analysisFontSize} min={10} max={24} step={1}
                  onChange={v => updateConfig('analysisFontSize', v)} />
                {/* 分析窗口透明度 */}
                <SliderField label="分析窗口透明度" unit="%"
                  value={Math.round(config.popoverOpacity * 100)} min={30} max={100} step={5}
                  onChange={v => updateConfig('popoverOpacity', v / 100)} />

                {/* 字幕位置 */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] text-gray-500">字幕位置</span>
                  <div className="flex gap-1">
                    {(['top', 'bottom'] as const).map(pos => (
                      <button key={pos}
                        onClick={() => updateConfig('subtitlePosition', pos)}
                        className={`px-2.5 py-1 rounded text-[10px] transition-colors ${
                          config.subtitlePosition === pos
                            ? 'bg-blue-500/30 text-blue-300 border border-blue-500/50'
                            : 'bg-gray-800 text-gray-500 border border-gray-700 hover:text-gray-300'
                        }`}>
                        {pos === 'top' ? '顶部' : '底部'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 字幕背景样式 */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] text-gray-500">字幕背景</span>
                  <div className="flex gap-1">
                    {([
                      { value: 'none' as const, label: '无' },
                      { value: 'semi' as const, label: '半透明' },
                      { value: 'solid' as const, label: '实色' },
                    ]).map(opt => (
                      <button key={opt.value}
                        onClick={() => updateConfig('subtitleBgStyle', opt.value)}
                        className={`px-2.5 py-1 rounded text-[10px] transition-colors ${
                          config.subtitleBgStyle === opt.value
                            ? 'bg-blue-500/30 text-blue-300 border border-blue-500/50'
                            : 'bg-gray-800 text-gray-500 border border-gray-700 hover:text-gray-300'
                        }`}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 原文颜色 */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] text-gray-500">原文颜色</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-gray-500">{config.subtitleOriginalColor}</span>
                    <input type="color" value={config.subtitleOriginalColor}
                      onChange={e => updateConfig('subtitleOriginalColor', e.target.value)}
                      className="w-6 h-6 rounded border border-gray-700 cursor-pointer bg-transparent [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded" />
                  </div>
                </div>

                {/* 译文颜色 */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] text-gray-500">译文颜色</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-gray-500">{config.subtitleTranslationColor}</span>
                    <input type="color" value={config.subtitleTranslationColor}
                      onChange={e => updateConfig('subtitleTranslationColor', e.target.value)}
                      className="w-6 h-6 rounded border border-gray-700 cursor-pointer bg-transparent [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded" />
                  </div>
                </div>

                {/* 原文/译文顺序 */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] text-gray-500">显示顺序</span>
                  <button
                    onClick={() => updateConfig('subtitleOriginalFirst', !config.subtitleOriginalFirst)}
                    className="text-[10px] px-2.5 py-1 rounded bg-gray-800 border border-gray-700
                               text-gray-400 hover:text-gray-200 transition-colors">
                    {config.subtitleOriginalFirst ? '原文在上 ↕' : '译文在上 ↕'}
                  </button>
                </div>

                {/* 遮盖模式 */}
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="text-[10px] text-gray-500 block">遮盖模式</span>
                    <span className="text-[9px] text-gray-600">隐藏译文，点击/快捷键显示</span>
                  </div>
                  <button
                    onClick={() => updateConfig('coverMode', !config.coverMode)}
                    className={`relative w-10 h-5 rounded-full transition-colors ${
                      config.coverMode ? 'bg-blue-500' : 'bg-gray-600'
                    }`}>
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      config.coverMode ? 'translate-x-5' : 'translate-x-0'
                    }`} />
                  </button>
                </div>
              </div>
            </div>

            {/* ── 快捷键（可折叠）─────────────────────────────── */}
            <div className="border-t border-gray-800 pt-2.5">
              <button onClick={() => setShortcutsOpen(o => !o)}
                className="flex items-center justify-between w-full group">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">⌨️</span>
                  <label className={labelCls + ' mb-0 cursor-pointer'}>快捷键</label>
                </div>
                <svg className={`w-4 h-4 text-gray-500 transition-transform ${shortcutsOpen ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <div className={`overflow-hidden transition-all duration-300 ${
                shortcutsOpen ? 'max-h-[400px] opacity-100 mt-3' : 'max-h-0 opacity-0'
              }`}>
                <p className="text-[10px] text-gray-500 mb-2">
                  在视频页面按下组合键触发。点击输入框后按新组合键修改。
                </p>
                <div className="space-y-2">
                  <HotkeyField label="触发 AI 分析" icon="🧠"
                    value={config.hotkeyAnalysis}
                    onChange={v => updateConfig('hotkeyAnalysis', v)} />
                  <HotkeyField label="重播当前句" icon="🔁"
                    value={config.hotkeyReplay}
                    onChange={v => updateConfig('hotkeyReplay', v)} />
                  <HotkeyField label="显示遮盖译文" icon="👁"
                    value={config.hotkeyReveal}
                    onChange={v => updateConfig('hotkeyReveal', v)} />
                </div>
              </div>
            </div>

            {/* 状态摘要 */}
            <div className="rounded-lg bg-gray-800/50 border border-gray-700/50 px-3 py-2 text-[11px] text-gray-400 space-y-0.5">
              <p>
                <span className="text-gray-500">翻译：</span>
                <span className={config.translationEnabled ? 'text-white' : 'text-gray-600'}>
                  {!config.translationEnabled
                    ? '已关闭'
                    : config.translateEngine === 'llm'
                      ? `${translateProfile.name} (${translateProfile.model})`
                      : config.translateEngine === 'microsoft'
                        ? 'Microsoft Translate'
                        : 'Google Translate'}
                </span>
              </p>
              <p>
                <span className="text-gray-500">分析：</span>
                <span className="text-emerald-300">
                  {isTrialAnalysis
                    ? `${FREE_TRIAL_PROFILE_NAME}（每日 ${FREE_TRIAL_DAILY_LIMIT} 次）`
                    : analysisProfile?.apiKey
                      ? `${analysisProfile.name} (${analysisProfile.model})`
                    : '未配置 — 请在 API 配置中添加'}
                </span>
              </p>
              <p>
                <a
                  href="https://github.com/p1aymaker9/lintro"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-gray-400 hover:text-gray-200 transition-colors"
                >
                  了解项目或赞助开源 <span aria-hidden>↗️</span>
                </a>
              </p>
            </div>
          </div>
        )}

        {/* ═══════════════════  API 配置 Tab ═══════════════════════ */}
        {tab === 'api' && (
          <div className="space-y-4">

            {/* Profile 选择器 + 新建 */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <select value={editingId}
                  onChange={e => { setEditingId(e.target.value); setTestStatus('idle'); }}
                  className={selectCls}>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.tested === true ? ' ✅' : p.tested === false ? ' ❌' : ''}
                    </option>
                  ))}
                </select>
                <SelectArrow />
              </div>
              <button onClick={addProfile}
                className="shrink-0 w-9 h-9 rounded-lg bg-gray-800 border border-gray-700
                           hover:bg-gray-700 text-blue-400 text-lg flex items-center justify-center
                           transition-colors" title="新建配置">
                ＋
              </button>
            </div>

            {/* 当前 Profile 编辑 */}
            {currentProfile && (
              <>
                {/* 名称 */}
                <div>
                  <label className={labelCls}>配置名称</label>
                  <input type="text"
                    value={currentProfile.name}
                    onChange={e => updateCurrentProfile({ name: e.target.value })}
                    placeholder="给这组配置起个名字…"
                    className={inputCls} />
                </div>

                {/* 供应商 */}
                <div>
                  <label className={labelCls}>API 供应商</label>
                  <div className="relative">
                    <select value={currentProfile.provider}
                      onChange={e => handleProviderChange(e.target.value as ApiProvider)}
                      className={selectCls}>
                      {PROVIDERS.map(p => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                    <SelectArrow />
                  </div>
                </div>

                {/* API Key */}
                <div>
                  <label className={labelCls}>API Key</label>
                  <input type="password"
                    value={currentProfile.apiKey}
                    onChange={e => updateCurrentProfile({ apiKey: e.target.value })}
                    placeholder="sk-..."
                    className={inputCls} />
                </div>

                {/* Endpoint */}
                <div>
                  <label className={labelCls}>API Endpoint</label>
                  <input type="text"
                    value={currentProfile.apiEndpoint}
                    onChange={e => updateCurrentProfile({ apiEndpoint: e.target.value })}
                    placeholder="https://api.openai.com/v1/chat/completions"
                    className={inputCls} />
                </div>

                {/* Model */}
                <div>
                  <label className={labelCls}>模型名称</label>
                  <input type="text"
                    value={currentProfile.model}
                    onChange={e => updateCurrentProfile({ model: e.target.value })}
                    placeholder="gpt-4o-mini"
                    className={inputCls} />
                </div>

                {/* 测试按钮 */}
                <button onClick={testApi}
                  disabled={testStatus === 'testing' || !currentProfile.apiKey}
                  className={`w-full rounded-lg text-sm font-medium py-2.5 transition-colors
                    focus:outline-none focus:ring-2 focus:ring-blue-400 flex items-center justify-center gap-2
                    ${testStatus === 'ok'
                      ? 'bg-emerald-600/20 border border-emerald-500/40 text-emerald-300'
                      : testStatus === 'fail'
                        ? 'bg-red-600/20 border border-red-500/40 text-red-300'
                        : 'bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white'
                    }`}>
                  {testStatus === 'testing' && (
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                  )}
                  {testStatus === 'idle' && '🔌 测试连接'}
                  {testStatus === 'testing' && '测试中…'}
                  {testStatus === 'ok' && '✅ 连接成功'}
                  {testStatus === 'fail' && '❌ 连接失败'}
                </button>

                {/* 失败提示 */}
                {testStatus === 'fail' && toast && (
                  <p className="text-[10px] text-red-400 text-center">{toast}</p>
                )}

                {/* 删除按钮 */}
                {profiles.length > 1 && (
                  <button onClick={deleteProfile}
                    className="w-full text-[10px] text-gray-500 hover:text-red-400 py-2
                               border border-dashed border-gray-800 hover:border-red-400/40
                               rounded-lg transition-colors mt-2">
                    🗑️ 删除此配置
                  </button>
                )}
              </>
            )}
          </div>
        )}


      </div>
    </div>
  );
}

// ─── Slider 通用组件 ─────────────────────────────────────────────────────

function SliderField({ label, unit, value, min, max, step, onChange }: {
  label: string; unit: string;
  value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-3">
      <label className="text-[10px] text-gray-500 block mb-1">
        {label}: {value}{unit}
      </label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseInt(e.target.value))}
        className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer
                   accent-blue-500 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                   [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-400
                   [&::-webkit-slider-thumb]:appearance-none"
      />
      <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
        <span>{min}{unit}</span><span>{max}{unit}</span>
      </div>
    </div>
  );
}

// ─── 快捷键输入组件 ──────────────────────────────────────────────────────

function HotkeyField({ label, icon, value, onChange }: {
  label: string; icon: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [recording, setRecording] = useState(false);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 忽略仅修饰键
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

    const parts: string[] = [];
    if (e.ctrlKey)  parts.push('Ctrl');
    if (e.altKey)   parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey)  parts.push('Meta');
    // 普通键名大写化
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    parts.push(key);
    onChange(parts.join('+'));
    setRecording(false);
  }, [onChange]);

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs w-5 text-center">{icon}</span>
      <span className="text-[11px] text-gray-300 flex-1">{label}</span>
      <input
        readOnly={!recording}
        value={recording ? '按下组合键…' : value}
        onFocus={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={recording ? handleKeyDown : undefined}
        className={`w-28 text-center text-[11px] rounded-md px-2 py-1.5 border outline-none cursor-pointer transition-colors ${
          recording
            ? 'bg-blue-500/20 border-blue-500/50 text-blue-300 animate-pulse'
            : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
        }`}
      />
    </div>
  );
}

export default App;
