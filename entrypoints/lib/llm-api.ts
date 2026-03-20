/**
 * LLM API 代理层
 *
 * 在 Background Service Worker 中运行，封装统一的 OpenAI 兼容接口调用。
 * 支持 OpenAI / DeepSeek / 任何兼容 OpenAI Chat Completions 的第三方 API。
 */

import { resolveActiveProfiles } from './storage';
import type { LLMConfig } from './storage';
import { TRIAL_API_BASE_URL } from './constants';

// ─── Prompt 工程 ─────────────────────────────────────────────────────────

const LANG_NAME: Record<string, string> = {
  'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese',
  'ja': 'Japanese', 'ko': 'Korean', 'en': 'English',
  'es': 'Spanish', 'fr': 'French', 'de': 'German',
  'pt': 'Portuguese', 'ru': 'Russian', 'ar': 'Arabic',
  'hi': 'Hindi', 'it': 'Italian', 'nl': 'Dutch',
  'tr': 'Turkish', 'vi': 'Vietnamese', 'th': 'Thai', 'id': 'Indonesian',
};

function langLabel(code: string) {
  return LANG_NAME[code] ?? code;
}

const JSON_ONLY_SUFFIX = [
  'Return valid JSON only.',
  'Do not output markdown.',
  'Do not wrap in code fences.',
  'Do not include explanations before or after the JSON.',
].join('\n');

function buildTranslatePrompt(targetLang: string): string {
  return [
    `You are a professional subtitle translator.`,
    `Translate the following text into ${langLabel(targetLang)}.`,
    `Rules:`,
    `- Output ONLY the translated text, one line per input line.`,
    `- Preserve the original line count exactly.`,
    `- Do NOT add explanations, notes, or numbering.`,
    `- Keep proper nouns, brand names, and technical terms as-is when appropriate.`,
    `- Use natural, fluent ${langLabel(targetLang)} suitable for video subtitles.`,
  ].join('\n');
}

function buildGrammarPrompt(targetLang: string): string {
  return [
    `You are an expert language learning assistant specializing in sentence structure analysis.`,
    `Respond ONLY with a valid JSON object (no markdown, no code fences, no extra text).`,
    `Use ${langLabel(targetLang)} for all explanation values.`,
    ``,
    `JSON schema:`,
    `{`,
    `  "translation": "natural fluent translation of the full sentence",`,
    `  "chunks": [`,
    `    {`,
    `      "text": "original text fragment (a meaningful grammar unit)",`,
    `      "role": "The logical identity or narrative function of the chunk in the sentence (e.g. [执行者], [动作], [对象], [时间], [地点], [手段], [条件], [状态描述], [转折]). Use short bracket-style labels in ${langLabel(targetLang)}.",`,
    `      "feature": "Noteworthy grammatical forms, tense, or structures (e.g. 过去式, 被动语态, 动词不定式, 现在完成时, 比较级, 复数). If it's just a basic word with no special form, use empty string.",`,
    `      "reading": "pronunciation hint if applicable (e.g. furigana for Japanese, pinyin for Chinese). Omit if not needed.",`,
    `      "meaning": "translation/meaning of this specific chunk in context of the full sentence",`,
    `      "grammar": ["grammar point 1", "grammar point 2"],`,
    `      "notes": "any additional context, usage notes, or related expressions (optional, can be empty string)"`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Rules:`,
    `- "chunks": Split the ENTIRE sentence into consecutive, non-overlapping grammar units. Every character must belong to exactly one chunk. Concatenating all chunk texts must reproduce the original sentence exactly (including spaces/punctuation).`,
    `- Each chunk is a meaningful syntactic/semantic unit (subject, verb phrase, object, adverbial, particle, conjunction, etc).`,
    `- "role": Focus on WHAT the chunk is doing in the story of the sentence (Who, What, Where, How, Why) rather than strict traditional syntax. Use short bracket-style labels in ${langLabel(targetLang)}. Keep labels concise (2-5 chars ideal).`,
    `- "feature": Highlight useful grammatical states or transformations (tense, voice, mood, degree, plurality, etc). Avoid boring labels like '名词' or '动词' unless truly necessary — use empty string for plain basic words.`,
    `- "reading": For Japanese, provide hiragana reading for kanji. For Chinese, provide pinyin. For other languages, omit this field.`,
    `- "meaning": Provide the meaning/translation of each chunk in the context of the full sentence.`,
    `- "grammar": 1-3 concise grammar observations for language learners. Focus on conjugation, particles, patterns, etc.`,
    `- "notes": Optional extra info like formality level, common collocations, or similar expressions. Use empty string if nothing notable.`,
    `- "translation": A single natural translation of the full sentence.`,
    `- Aim for 3-10 chunks depending on sentence complexity.`,
    '',
    JSON_ONLY_SUFFIX,
  ].join('\n');
}

function buildFastStructPrompt(targetLang: string): string {
  return [
    `You are a language analysis assistant. Be extremely concise and fast.`,
    `Respond ONLY with a valid JSON object (no markdown, no code fences, no extra text).`,
    ``,
    `JSON schema:`,
    `{`,
    `  "translation": "natural fluent translation in ${langLabel(targetLang)}",`,
    `  "chunks": [`,
    `    { "text": "original text fragment", "role": "[短标签]" }`,
    `  ]`,
    `}`,
    ``,
    `Rules:`,
    `- Split the sentence into consecutive, non-overlapping grammar units (3-10 chunks).`,
    `- "role": bracket-style label in ${langLabel(targetLang)} describing the chunk's narrative function, e.g. [执行者] [动作] [对象] [时间] [手段]. Keep to 2-5 chars.`,
    `- Concatenating all chunk "text" values MUST reproduce the original sentence exactly (including spaces/punctuation).`,
    `- "translation": a single natural translation of the full sentence in ${langLabel(targetLang)}.`,
    `- Output ONLY the JSON object. Be fast.`,
    '',
    JSON_ONLY_SUFFIX,
  ].join('\n');
}

function buildDeepDetailPrompt(targetLang: string): string {
  return [
    `You are an expert language learning assistant.`,
    `You will receive an original sentence and a numbered list of structural chunks extracted from it.`,
    `Provide detailed linguistic analysis for EACH chunk.`,
    `Respond ONLY with a valid JSON object (no markdown, no code fences, no extra text).`,
    `Use ${langLabel(targetLang)} for all explanation values.`,
    ``,
    `JSON schema:`,
    `{`,
    `  "chunk_details": [`,
    `    {`,
    `      "feature": "Noteworthy grammatical forms, tense, or structures (e.g. 过去式, 被动语态, 比较级). Use empty string for plain basic words.",`,
    `      "reading": "pronunciation hint if applicable (furigana/pinyin). Use empty string if not needed.",`,
    `      "meaning": "meaning/translation of this chunk in context",`,
    `      "grammar": ["grammar point 1", "grammar point 2"],`,
    `      "notes": "additional notes (can be empty string)"`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Rules:`,
    `- Output exactly ONE entry per input chunk, in the SAME order. Array length MUST match the number of input chunks.`,
    `- "feature": Highlight useful grammatical states or transformations. Avoid boring labels like '名词' or '动词' — use empty string for plain basic words.`,
    `- "reading": For Japanese provide hiragana for kanji, for Chinese provide pinyin. For other languages use empty string.`,
    `- "meaning": The specific meaning of this chunk in context of the full sentence.`,
    `- "grammar": 1-3 concise grammar observations for language learners.`,
    `- "notes": Optional extra info. Use empty string if nothing notable.`,
    '',
    JSON_ONLY_SUFFIX,
  ].join('\n');
}

// ─── 可热更新的 Prompt（从 CF 后端拉取，失败回退内置）──────────────────

const PROMPT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type RemotePromptBundle = {
  ok: true;
  version: string;
  lang: string;
  prompts: Record<PromptType, string>;
};

function promptCacheKey(lang: string) {
  return `promptBundle:${lang}`;
}

async function loadCachedPromptBundle(lang: string): Promise<RemotePromptBundle | null> {
  try {
    const key = promptCacheKey(lang);
    const res = (await browser.storage.local.get(key)) as Record<string, unknown>;
    const record = res[key] as { fetchedAt?: number; bundle?: RemotePromptBundle } | undefined;
    if (!record?.bundle || typeof record.fetchedAt !== 'number') return null;
    if (Date.now() - record.fetchedAt > PROMPT_CACHE_TTL_MS) return null;
    if (record.bundle.ok !== true || !record.bundle.prompts) return null;
    return record.bundle;
  } catch {
    return null;
  }
}

async function fetchAndCachePromptBundle(lang: string): Promise<RemotePromptBundle | null> {
  try {
    const url = `${TRIAL_API_BASE_URL}/api/prompt/system-bundle?lang=${encodeURIComponent(lang)}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const data = (await res.json()) as RemotePromptBundle;
    if (data?.ok !== true || !data.prompts) return null;
    const key = promptCacheKey(lang);
    await browser.storage.local.set({
      [key]: {
        fetchedAt: Date.now(),
        bundle: data,
      }
    });
    return data;
  } catch {
    return null;
  }
}

async function getHotSystemPrompt(promptType: PromptType, targetLang: string): Promise<string | null> {
  const cached = await loadCachedPromptBundle(targetLang);
  const cachedPrompt = cached?.prompts?.[promptType];
  if (cachedPrompt) return cachedPrompt;

  const fetched = await fetchAndCachePromptBundle(targetLang);
  const fetchedPrompt = fetched?.prompts?.[promptType];
  return fetchedPrompt || null;
}

// ─── JSON 提取器（兼容推理模型）─────────────────────────────────────────

/**
 * 从 LLM 响应中安全提取 JSON 对象。
 *
 * 推理模型（如 DeepSeek R1）会输出 <think>...</think> 标签包裹的思考过程，
 * 直接 JSON.parse 会崩溃。此函数：
 *   1. 剥离 <think>...</think> 块（支持多段、嵌套、跨行）
 *   2. 剥离 Markdown 代码围栏 ```json ... ```
 *   3. 定位并提取第一个完整 JSON 对象 {...}
 *   4. 解析并返回；全部失败则抛出明确错误
 */
export function extractJsonFromLLM<T = any>(raw: string): T {
  let text = raw;

  // ── 步骤 1: 剥离 <think>...</think> ──────────────────────────────────
  // 支持多段 <think> 块、跨行、嵌套闭合
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 处理未闭合的 <think>（模型截断情况）
  text = text.replace(/<think>[\s\S]*/gi, '');

  // ── 步骤 2: 剥离 Markdown 代码围栏 ──────────────────────────────────
  text = text.replace(/```(?:json)?\s*\n?/gi, '').replace(/\n?\s*```/g, '');

  text = text.trim();

  // ── 步骤 3: 直接尝试解析 ────────────────────────────────────────────
  try {
    return JSON.parse(text) as T;
  } catch {
    // 继续尝试提取
  }

  // ── 步骤 4: 定位第一个 {...} 对象（处理前后有杂文的情况）─────────────
  const firstBrace = text.indexOf('{');
  if (firstBrace >= 0) {
    // 从第一个 { 开始，用计数器找到匹配的 }
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = firstBrace; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = text.slice(firstBrace, i + 1);
          try {
            return JSON.parse(jsonStr) as T;
          } catch {
            break; // 提取到的片段仍无法解析
          }
        }
      }
    }
  }

  // ── 全部失败 ────────────────────────────────────────────────────────
  // 截取前 200 字符用于调试
  const preview = raw.slice(0, 200).replace(/\n/g, '↵');
  throw new Error(
    `无法从 AI 响应中提取 JSON。` +
    `若使用推理模型（如 DeepSeek R1），请尝试切换为非推理模型（如 DeepSeek V3、GPT-4o-mini）。` +
    `\n响应预览: ${preview}…`
  );
}

// ─── API 请求 ────────────────────────────────────────────────────────────

export type PromptType = 'translate' | 'grammar_analysis' | 'fast_struct' | 'deep_detail';

export interface CallLLMPayload {
  promptType: PromptType;
  text: string;
  context?: string;
}

export interface CallLLMResult {
  success: boolean;
  content?: string;
  error?: string;
}

/** 允许覆盖默认 LLM 配置（用于 AI 分析使用独立引擎） */
export interface LLMConfigOverride {
  apiKey: string;
  apiEndpoint: string;
  model: string;
  targetLang: string;
}

// ─── 可选参数兼容（reasoning / response_format / enable_thinking）───────

type FeatureSupportRecord = {
  checkedAt: number;
  supported: boolean;
};

type OptionalFeature = 'enable_thinking' | 'reasoning' | 'response_format' | 'chat_template_kwargs';

const FEATURE_SUPPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function featureSupportKey(endpoint: string, model: string, feature: OptionalFeature) {
  return `featureSupport:${feature}:${getEndpointHost(endpoint)}:${model}`;
}

function looksLikeUnknownParamError(text: string, paramName: string) {
  const t = text.toLowerCase();
  const p = paramName.toLowerCase();
  if (!t.includes(p)) return false;
  return /unknown|unrecognized|unsupported|invalid|unexpected|not allowed|extra inputs|additional properties/i.test(text);
}

async function loadThinkingSupport(endpoint: string, model: string): Promise<boolean | null> {
  try {
    const key = featureSupportKey(endpoint, model, 'enable_thinking');
    const res = (await browser.storage.local.get(key)) as Record<string, unknown>;
    const record = res[key] as FeatureSupportRecord | undefined;
    if (!record || typeof record.checkedAt !== 'number' || typeof record.supported !== 'boolean') return null;
    if (Date.now() - record.checkedAt > FEATURE_SUPPORT_TTL_MS) return null;
    return record.supported;
  } catch {
    return null;
  }
}

async function saveThinkingSupport(endpoint: string, model: string, supported: boolean): Promise<void> {
  try {
    const key = featureSupportKey(endpoint, model, 'enable_thinking');
    const record: FeatureSupportRecord = { checkedAt: Date.now(), supported };
    await browser.storage.local.set({ [key]: record });
  } catch {
    // ignore cache failures
  }
}

async function loadFeatureSupport(endpoint: string, model: string, feature: OptionalFeature): Promise<boolean | null> {
  try {
    const key = featureSupportKey(endpoint, model, feature);
    const res = (await browser.storage.local.get(key)) as Record<string, unknown>;
    const record = res[key] as FeatureSupportRecord | undefined;
    if (!record || typeof record.checkedAt !== 'number' || typeof record.supported !== 'boolean') return null;
    if (Date.now() - record.checkedAt > FEATURE_SUPPORT_TTL_MS) return null;
    return record.supported;
  } catch {
    return null;
  }
}

async function saveFeatureSupport(endpoint: string, model: string, feature: OptionalFeature, supported: boolean): Promise<void> {
  try {
    const key = featureSupportKey(endpoint, model, feature);
    const record: FeatureSupportRecord = { checkedAt: Date.now(), supported };
    await browser.storage.local.set({ [key]: record });
  } catch {
    // ignore cache failures
  }
}

function isJsonPromptType(promptType: PromptType) {
  return promptType === 'grammar_analysis' || promptType === 'fast_struct' || promptType === 'deep_detail';
}

function looksLikeReasoningParamError(text: string) {
  return looksLikeUnknownParamError(text, 'reasoning')
    || looksLikeUnknownParamError(text, 'reasoning.effort')
    || /reasoning\s*effort/i.test(text);
}

function looksLikeChatTemplateKwargsError(text: string) {
  return looksLikeUnknownParamError(text, 'chat_template_kwargs')
    || looksLikeUnknownParamError(text, 'chat_template_kwargs.enable_thinking')
    || /chat_template_kwargs/i.test(text);
}

function looksLikeResponseFormatError(text: string) {
  return looksLikeUnknownParamError(text, 'response_format')
    || /json_schema|json object|invalid response[_\s-]?format/i.test(text);
}

async function postChatCompletionsWithFallback(
  endpoint: string,
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: any } | { ok: false; status: number; errorText: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }

    const errorText = await res.text().catch(() => '');
    if (res.status !== 400) {
      return { ok: false, status: res.status, errorText };
    }

    let removedOptionalParam = false;

    if (body.reasoning && looksLikeReasoningParamError(errorText)) {
      delete body.reasoning;
      await saveFeatureSupport(endpoint, model, 'reasoning', false);
      removedOptionalParam = true;
    }

    if (body.response_format && looksLikeResponseFormatError(errorText)) {
      delete body.response_format;
      await saveFeatureSupport(endpoint, model, 'response_format', false);
      removedOptionalParam = true;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'enable_thinking') && looksLikeUnknownParamError(errorText, 'enable_thinking')) {
      delete body.enable_thinking;
      await saveFeatureSupport(endpoint, model, 'enable_thinking', false);
      await saveThinkingSupport(endpoint, model, false);
      removedOptionalParam = true;
    }

    if (body.chat_template_kwargs && looksLikeChatTemplateKwargsError(errorText)) {
      delete body.chat_template_kwargs;
      await saveFeatureSupport(endpoint, model, 'chat_template_kwargs', false);
      removedOptionalParam = true;
    }

    if (removedOptionalParam) {
      continue;
    }

    return { ok: false, status: res.status, errorText };
  }

  return { ok: false, status: 400, errorText: 'Too many retries while removing unsupported params' };
}

function shouldSendQwenChatTemplateKwargs(model: string) {
  const m = (model || '').toLowerCase();
  return m.includes('qwen') && /qwen\s*3|qwen3/.test(m);
}

export async function primeEnableThinkingSupport(profile: {
  apiKey: string;
  apiEndpoint: string;
  model: string;
}): Promise<void> {
  if (!profile.apiKey || !profile.apiEndpoint || !profile.model) return;
  // 仅保留兼容 API，避免首次探测请求增加时延。
  // 真正支持性由真实请求自动降级并缓存。
  await loadThinkingSupport(profile.apiEndpoint, profile.model);
}

/**
 * 调用 LLM API（标准 OpenAI Chat Completions 格式）
 * @param configOverride 可选配置覆盖，优先于存储的配置
 */
export async function callLLM(
  payload: CallLLMPayload,
  configOverride?: LLMConfigOverride,
): Promise<CallLLMResult> {
  // 优先使用调用方传入的 override；若缺失则回退到 resolveActiveProfiles
  let apiKey = configOverride?.apiKey;
  let apiEndpoint = configOverride?.apiEndpoint;
  let model = configOverride?.model;
  let targetLang = configOverride?.targetLang;

  if (!apiKey || !apiEndpoint || !model || !targetLang) {
    const resolved = await resolveActiveProfiles();
    apiKey      = apiKey      || resolved.translate.apiKey;
    apiEndpoint = apiEndpoint || resolved.translate.apiEndpoint;
    model       = model       || resolved.translate.model;
    targetLang  = targetLang  || resolved.translate.targetLang;
  }

  // 校验
  if (!apiKey) {
    return { success: false, error: '未配置 API Key，请在插件设置中填写' };
  }
  if (!apiEndpoint) {
    return { success: false, error: '未配置 API Endpoint' };
  }

  // 构造 System Prompt
  const systemPrompt =
    (await getHotSystemPrompt(payload.promptType, targetLang))
    ?? (() => {
      switch (payload.promptType) {
        case 'translate':    return buildTranslatePrompt(targetLang);
        case 'fast_struct':  return buildFastStructPrompt(targetLang);
        case 'deep_detail':  return buildDeepDetailPrompt(targetLang);
        default:             return buildGrammarPrompt(targetLang);
      }
    })();

  // 构造用户消息
  let userContent = payload.text;
  if (payload.context) {
    userContent = `[Context]\n${payload.context}\n\n[Text to process]\n${payload.text}`;
  }

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userContent },
    ],
    temperature: (payload.promptType === 'translate' || payload.promptType === 'fast_struct') ? 0.3 : 0.5,
    max_tokens: payload.promptType === 'fast_struct' ? 1024 : 4096,
  };

  // 新策略：优先使用现代推理控制，失败后自动降级。
  const reasoningSupport = await loadFeatureSupport(apiEndpoint, model, 'reasoning');
  if (reasoningSupport !== false) {
    body.reasoning = { effort: 'none' };
  }

  // 兼容 DeepSeek 等端点的老参数（若不支持会自动移除并缓存）。
  const enableThinkingSupport = await loadFeatureSupport(apiEndpoint, model, 'enable_thinking');
  if (enableThinkingSupport !== false) {
    body.enable_thinking = false;
  }

  // Qwen 3.x/3.5: some gateways honor `chat_template_kwargs.enable_thinking=false`.
  if (shouldSendQwenChatTemplateKwargs(model)) {
    const qwenKwargsSupport = await loadFeatureSupport(apiEndpoint, model, 'chat_template_kwargs');
    if (qwenKwargsSupport !== false) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
  }

  // JSON 任务优先使用 response_format 约束，提升可解析稳定性。
  if (isJsonPromptType(payload.promptType)) {
    const responseFormatSupport = await loadFeatureSupport(apiEndpoint, model, 'response_format');
    if (responseFormatSupport !== false) {
      body.response_format = { type: 'json_object' };
    }
  }

  try {
    const request = await postChatCompletionsWithFallback(apiEndpoint, apiKey, model, body);

    if (!request.ok) {
      return { success: false, error: `HTTP ${request.status}: ${request.errorText.slice(0, 200)}` };
    }

    if (body.reasoning) await saveFeatureSupport(apiEndpoint, model, 'reasoning', true);
    if (body.response_format) await saveFeatureSupport(apiEndpoint, model, 'response_format', true);
    if (Object.prototype.hasOwnProperty.call(body, 'enable_thinking')) {
      await saveFeatureSupport(apiEndpoint, model, 'enable_thinking', true);
      await saveThinkingSupport(apiEndpoint, model, true);
    }
    if (body.chat_template_kwargs) await saveFeatureSupport(apiEndpoint, model, 'chat_template_kwargs', true);

    const data = request.data;
    const content = data?.choices?.[0]?.message?.content?.trim();

    if (!content) {
      return { success: false, error: 'LLM 返回了空内容' };
    }

    return { success: true, content };
  } catch (err: any) {
    return { success: false, error: `请求失败: ${err.message}` };
  }
}

/**
 * 批量翻译字幕 — 将多行合并为一次 LLM 调用
 *
 * @param texts 原文数组
 * @param contextLines 可选上下文（如视频标题）
 * @returns 翻译后的文本数组（与输入等长）
 */
export async function llmBatchTranslate(
  texts: string[],
  contextLines?: string,
  configOverride?: LLMConfigOverride,
): Promise<string[]> {
  // 用编号标记以确保行对齐
  const numbered = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');

  // 解析翻译用的 API 配置
  let apiKey: string, apiEndpoint: string, model: string, targetLang: string;
  if (configOverride?.apiKey && configOverride?.apiEndpoint && configOverride?.model) {
    apiKey = configOverride.apiKey;
    apiEndpoint = configOverride.apiEndpoint;
    model = configOverride.model;
    targetLang = configOverride.targetLang || 'zh-Hans';
  } else {
    const resolved = await resolveActiveProfiles();
    apiKey = resolved.translate.apiKey;
    apiEndpoint = resolved.translate.apiEndpoint;
    model = resolved.translate.model;
    targetLang = resolved.translate.targetLang;
  }

  const systemPrompt = [
    (await getHotSystemPrompt('translate', targetLang)) ?? buildTranslatePrompt(targetLang),
    '',
    'Input lines are numbered like [1] text, [2] text, ...',
    'Output the translation for each line in the SAME numbered format.',
    'Do NOT skip or merge lines.',
  ].join('\n');

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: numbered },
    ],
    temperature: 0.3,
    max_tokens: 4096,
  };

  // 翻译批处理同样优先降低推理开销。
  const reasoningSupport = await loadFeatureSupport(apiEndpoint, model, 'reasoning');
  if (reasoningSupport !== false) {
    body.reasoning = { effort: 'none' };
  }

  const enableThinkingSupport = await loadFeatureSupport(apiEndpoint, model, 'enable_thinking');
  if (enableThinkingSupport !== false) {
    body.enable_thinking = false;
  }

  if (shouldSendQwenChatTemplateKwargs(model)) {
    const qwenKwargsSupport = await loadFeatureSupport(apiEndpoint, model, 'chat_template_kwargs');
    if (qwenKwargsSupport !== false) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
  }

  const request = await postChatCompletionsWithFallback(apiEndpoint, apiKey, model, body);
  if (!request.ok) {
    throw new Error(`LLM HTTP ${request.status}`);
  }

  if (body.reasoning) await saveFeatureSupport(apiEndpoint, model, 'reasoning', true);
  if (Object.prototype.hasOwnProperty.call(body, 'enable_thinking')) {
    await saveFeatureSupport(apiEndpoint, model, 'enable_thinking', true);
    await saveThinkingSupport(apiEndpoint, model, true);
  }
  if (body.chat_template_kwargs) await saveFeatureSupport(apiEndpoint, model, 'chat_template_kwargs', true);

  const data = request.data;
  const content: string = data?.choices?.[0]?.message?.content?.trim() ?? '';

  // 解析 [N] 格式的输出
  const lineMap = new Map<number, string>();
  const regex = /\[(\d+)\]\s*(.*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    lineMap.set(parseInt(match[1], 10), match[2].trim());
  }

  // 按原始顺序组装结果
  return texts.map((_, i) => lineMap.get(i + 1) ?? '');
}
