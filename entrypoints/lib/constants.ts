/**
 * 支持的翻译目标语言列表
 * code 对应 YouTube timedtext API 的 tlang 参数
 */
export interface Language {
  code: string;
  name: string;
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'zh-Hans', name: '简体中文' },
  { code: 'zh-Hant', name: '繁体中文' },
  { code: 'ja',      name: '日语 (Japanese)' },
  { code: 'ko',      name: '韩语 (Korean)' },
  { code: 'en',      name: '英语 (English)' },
  { code: 'es',      name: '西班牙语 (Spanish)' },
  { code: 'fr',      name: '法语 (French)' },
  { code: 'de',      name: '德语 (German)' },
  { code: 'pt',      name: '葡萄牙语 (Portuguese)' },
  { code: 'ru',      name: '俄语 (Russian)' },
  { code: 'ar',      name: '阿拉伯语 (Arabic)' },
  { code: 'hi',      name: '印地语 (Hindi)' },
  { code: 'it',      name: '意大利语 (Italian)' },
  { code: 'nl',      name: '荷兰语 (Dutch)' },
  { code: 'tr',      name: '土耳其语 (Turkish)' },
  { code: 'vi',      name: '越南语 (Vietnamese)' },
  { code: 'th',      name: '泰语 (Thai)' },
  { code: 'id',      name: '印尼语 (Indonesian)' },
];

/** 默认目标语言 */
export const DEFAULT_TARGET_LANG = 'zh-Hans';

/** 免费试用分析配置 */
export const FREE_TRIAL_PROFILE_ID = 'trial';
export const FREE_TRIAL_PROFILE_NAME = '免费试用';
export const FREE_TRIAL_DAILY_LIMIT = 20;

/** Cloudflare Worker 试用 API 地址 */
export const TRIAL_API_BASE_URL = 'https://lintro-backend.ssa9ittarius.workers.dev';
export const TRIAL_API_URL = `${TRIAL_API_BASE_URL}/api/llm/trial`;

/** storage key */
export const STORAGE_KEY_TARGET_LANG = 'targetLang';
