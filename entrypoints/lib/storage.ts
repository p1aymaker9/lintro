/**
 * 插件配置存储服务
 *
 * 统一管理所有用户配置项的读写，提供类型安全的默认值。
 * 支持多 API Profile（用户可保存多组 API 配置以便对比不同模型）。
 */

import { FREE_TRIAL_PROFILE_ID } from './constants';

// ─── 类型定义 ────────────────────────────────────────────────────────────

export type ApiProvider = 'openai' | 'deepseek' | 'zhipu' | 'kimi' | 'siliconflow' | 'custom';

/** 一组可复用的 API 凭据配置 */
export interface ApiProfile {
  id: string;
  name: string;
  provider: ApiProvider;
  apiKey: string;
  apiEndpoint: string;
  model: string;
  /** 上次测试结果: true=可用, false=失败, undefined=未测试 */
  tested?: boolean;
}

export interface LLMConfig {
  /** 翻译总开关 */
  translationEnabled: boolean;
  /** 翻译引擎: llm / google / microsoft */
  translateEngine: 'llm' | 'google' | 'microsoft';

  // ── Profile 引用 ───────────────────────────────────
  /** 翻译引擎使用的 Profile ID */
  translateProfileId: string;
  /** AI 分析引擎使用的 Profile ID */
  analysisProfileId: string;

  // ── 向后兼容（已弃用，迁移后清空）─────────────────
  /** @deprecated 使用 translateProfileId */
  apiProvider?: ApiProvider;
  /** @deprecated */ apiKey?: string;
  /** @deprecated */ apiEndpoint?: string;
  /** @deprecated */ model?: string;
  /** @deprecated 使用 analysisProfileId */
  analysisProvider?: ApiProvider;
  /** @deprecated */ analysisApiKey?: string;
  /** @deprecated */ analysisEndpoint?: string;
  /** @deprecated */ analysisModel?: string;

  // ── 通用 ──────────────────────────────────────────
  /** 翻译目标语言 */
  targetLang: string;
  /** 分析窗口透明度 0.3~1.0 */
  popoverOpacity: number;
  /** 主字幕语言: 'auto' 或具体语言代码 */
  primarySubLang: string;

  // ── 显示设置 ──────────────────────────────────────
  /** 字幕字体大小 (px) */
  subtitleFontSize: number;
  /** 分析窗口字体大小 (px) */
  analysisFontSize: number;
  /** 字幕位置: top / bottom */
  subtitlePosition: 'top' | 'bottom';
  /** 原文字体颜色 */
  subtitleOriginalColor: string;
  /** 译文字体颜色 */
  subtitleTranslationColor: string;
  /** 字幕背景样式: none / semi / solid */
  subtitleBgStyle: 'none' | 'semi' | 'solid';
  /** 原文/译文顺序: true=原文在上 */
  subtitleOriginalFirst: boolean;
  /** 遮盖模式: 隐藏译文，点击显示 */
  coverMode: boolean;

  // ── 快捷键配置 ────────────────────────────────────
  /** 触发 AI 分析快捷键 */
  hotkeyAnalysis: string;
  /** 重播当前句快捷键 */
  hotkeyReplay: string;
  /** 遮盖模式下显示译文快捷键 */
  hotkeyReveal: string;
}

// ─── 预设配置 ────────────────────────────────────────────────────────────

export const PROVIDER_PRESETS: Record<ApiProvider, { endpoint: string; model: string }> = {
  openai:      { endpoint: 'https://api.openai.com/v1/chat/completions',              model: 'gpt-4o-mini' },
  deepseek:    { endpoint: 'https://api.deepseek.com/v1/chat/completions',            model: 'deepseek-chat' },
  zhipu:       { endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',   model: 'glm-4-flash' },
  kimi:        { endpoint: 'https://api.moonshot.cn/v1/chat/completions',              model: 'moonshot-v1-8k' },
  siliconflow: { endpoint: 'https://api.siliconflow.cn/v1/chat/completions',           model: 'Qwen/Qwen3-VL-30B-A3B-Instruct' },
  custom:      { endpoint: '',                                                         model: '' },
};

// ─── 默认值 ──────────────────────────────────────────────────────────────

const DEFAULT_PROFILE_ID = 'default';

export function createDefaultProfile(): ApiProfile {
  return {
    id: DEFAULT_PROFILE_ID,
    name: '默认配置',
    provider: 'openai',
    apiKey: '',
    apiEndpoint: PROVIDER_PRESETS.openai.endpoint,
    model: PROVIDER_PRESETS.openai.model,
  };
}

export const DEFAULT_CONFIG: LLMConfig = {
  translationEnabled: true,
  translateEngine: 'google',

  translateProfileId: DEFAULT_PROFILE_ID,
  analysisProfileId: FREE_TRIAL_PROFILE_ID,

  targetLang: 'zh-Hans',
  popoverOpacity: 0.95,
  primarySubLang: 'auto',
  subtitleFontSize: 18,
  analysisFontSize: 14,

  subtitlePosition: 'bottom',
  subtitleOriginalColor: '#ffffff',
  subtitleTranslationColor: '#93c5fd',
  subtitleBgStyle: 'semi',
  subtitleOriginalFirst: true,
  coverMode: false,

  hotkeyAnalysis: 'Alt+A',
  hotkeyReplay: 'Alt+R',
  hotkeyReveal: 'Alt+S',
};

/** storage 中的 key */
const STORAGE_KEY = 'llmConfig';
const PROFILES_KEY = 'apiProfiles';

// ─── Profile CRUD ────────────────────────────────────────────────────────

/** 生成唯一 ID */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 读取所有 API Profile */
export async function loadProfiles(): Promise<ApiProfile[]> {
  const result = (await browser.storage.local.get(PROFILES_KEY)) as Record<string, unknown>;
  const raw = result[PROFILES_KEY];
  const profiles: ApiProfile[] = Array.isArray(raw) ? (raw as ApiProfile[]) : [];
  if (profiles.length === 0) {
    profiles.push(createDefaultProfile());
  }
  return profiles;
}

/** 保存所有 API Profile */
export async function saveProfiles(profiles: ApiProfile[]): Promise<void> {
  await browser.storage.local.set({ [PROFILES_KEY]: profiles });
}

/** 根据 ID 查找 Profile；找不到则返回第一个 */
export function findProfile(profiles: ApiProfile[], id: string): ApiProfile {
  return profiles.find(p => p.id === id) ?? profiles[0] ?? createDefaultProfile();
}

/** 新建一个空 Profile 并返回 */
export function createProfile(name?: string): ApiProfile {
  return {
    id: uid(),
    name: name || `配置 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
    provider: 'openai',
    apiKey: '',
    apiEndpoint: PROVIDER_PRESETS.openai.endpoint,
    model: PROVIDER_PRESETS.openai.model,
  };
}

// ─── Config 读写（含向后兼容迁移）────────────────────────────────────────

/** 读取完整配置（缺失字段用默认值填充，含向后兼容迁移） */
export async function loadConfig(): Promise<LLMConfig> {
  const result = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
  const stored = (result[STORAGE_KEY] ?? {}) as Partial<LLMConfig>;
  const config: LLMConfig = { ...DEFAULT_CONFIG, ...stored };
  if (!config.analysisProfileId) {
    config.analysisProfileId = FREE_TRIAL_PROFILE_ID;
  }
  return config;
}

/**
 * 一次性迁移: 将旧的内联 API 字段提取为 Profile（幂等）。
 * 在 Popup 初始化时调用一次。
 */
export async function migrateToProfiles(): Promise<{ config: LLMConfig; profiles: ApiProfile[] }> {
  const config = await loadConfig();
  let profiles = await loadProfiles();

  // 检查是否有旧内联字段需要迁移
  const hasOldTranslate = !!config.apiKey;
  const hasOldAnalysis  = !!config.analysisApiKey;

  if (hasOldTranslate || hasOldAnalysis) {
    // 迁移翻译配置
    if (hasOldTranslate) {
      const existing = profiles.find(p =>
        p.apiKey === config.apiKey && p.apiEndpoint === config.apiEndpoint && p.model === config.model
      );
      if (existing) {
        config.translateProfileId = existing.id;
      } else {
        const tp: ApiProfile = {
          id: uid(),
          name: `翻译 - ${config.apiProvider ?? 'custom'}`,
          provider: config.apiProvider ?? 'custom',
          apiKey: config.apiKey!,
          apiEndpoint: config.apiEndpoint ?? PROVIDER_PRESETS.openai.endpoint,
          model: config.model ?? PROVIDER_PRESETS.openai.model,
        };
        profiles.push(tp);
        config.translateProfileId = tp.id;
      }
    }

    // 迁移分析配置
    if (hasOldAnalysis) {
      const sameAsTranslate = config.analysisApiKey === config.apiKey
        && config.analysisEndpoint === config.apiEndpoint
        && config.analysisModel === config.model;

      if (sameAsTranslate) {
        config.analysisProfileId = config.translateProfileId;
      } else {
        const existing = profiles.find(p =>
          p.apiKey === config.analysisApiKey && p.apiEndpoint === config.analysisEndpoint && p.model === config.analysisModel
        );
        if (existing) {
          config.analysisProfileId = existing.id;
        } else {
          const ap: ApiProfile = {
            id: uid(),
            name: `分析 - ${config.analysisProvider ?? 'custom'}`,
            provider: config.analysisProvider ?? 'custom',
            apiKey: config.analysisApiKey!,
            apiEndpoint: config.analysisEndpoint ?? PROVIDER_PRESETS.openai.endpoint,
            model: config.analysisModel ?? PROVIDER_PRESETS.openai.model,
          };
          profiles.push(ap);
          config.analysisProfileId = ap.id;
        }
      }
    }

    // 清除旧字段
    delete config.apiKey;
    delete config.apiEndpoint;
    delete config.model;
    delete config.apiProvider;
    delete config.analysisApiKey;
    delete config.analysisEndpoint;
    delete config.analysisModel;
    delete config.analysisProvider;

    // 去除默认空 Profile（如果有迁移出的真实 Profile 了）
    if (profiles.length > 1) {
      profiles = profiles.filter(p => p.id !== DEFAULT_PROFILE_ID || p.apiKey);
    }

    await saveConfig(config);
    await saveProfiles(profiles);
  }

  const defaultProfile = profiles.find(p => p.id === DEFAULT_PROFILE_ID);
  if (
    !config.analysisProfileId ||
    (config.analysisProfileId === DEFAULT_PROFILE_ID && !defaultProfile?.apiKey)
  ) {
    config.analysisProfileId = FREE_TRIAL_PROFILE_ID;
    await saveConfig(config);
  }

  return { config, profiles };
}

/**
 * 解析当前激活的翻译/分析 API 配置。
 * 供 background.ts 使用，返回实际的 key/endpoint/model。
 */
export async function resolveActiveProfiles() {
  const config = await loadConfig();
  const profiles = await loadProfiles();

  const translateProfile = findProfile(profiles, config.translateProfileId);
  const analysisProfile  = findProfile(profiles, config.analysisProfileId);
  const useTrialAnalysis = config.analysisProfileId === FREE_TRIAL_PROFILE_ID;

  return {
    config,
    translate: {
      apiKey: translateProfile.apiKey,
      apiEndpoint: translateProfile.apiEndpoint,
      model: translateProfile.model,
      targetLang: config.targetLang,
    },
    analysis: {
      useTrial: useTrialAnalysis,
      apiKey: useTrialAnalysis ? '' : (analysisProfile.apiKey || translateProfile.apiKey),
      apiEndpoint: useTrialAnalysis ? '' : (analysisProfile.apiEndpoint || translateProfile.apiEndpoint),
      model: useTrialAnalysis ? 'free-trial' : (analysisProfile.model || translateProfile.model),
      targetLang: config.targetLang,
    },
  };
}

/** 保存完整配置 */
export async function saveConfig(config: LLMConfig): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: config });
}

/** 读取单个字段 */
export async function getConfigField<K extends keyof LLMConfig>(key: K): Promise<LLMConfig[K]> {
  const cfg = await loadConfig();
  return cfg[key];
}

// ─── 字幕轨道（每个视频的动态数据）──────────────────────────────────────

export interface CaptionTrack {
  languageCode: string;
  languageName: string;
  baseUrl: string;
  kind?: string; // 'asr' 表示自动生成
}

/** 保存当前视频可用的字幕轨道列表 */
export async function saveAvailableTracks(tracks: CaptionTrack[]): Promise<void> {
  await browser.storage.local.set({ availableTracks: tracks });
}

/** 读取当前视频可用的字幕轨道列表 */
export async function loadAvailableTracks(): Promise<CaptionTrack[]> {
  const result = (await browser.storage.local.get('availableTracks')) as { availableTracks?: unknown };
  return Array.isArray(result.availableTracks) ? (result.availableTracks as CaptionTrack[]) : [];
}
