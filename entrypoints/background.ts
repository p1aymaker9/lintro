import { batchTranslate } from './lib/google-translate';
import { batchTranslate as microsoftBatchTranslate } from './lib/microsoft-translate';
import { callLLM, llmBatchTranslate, primeEnableThinkingSupport } from './lib/llm-api';
import { resolveActiveProfiles } from './lib/storage';
import { getOrCreateDeviceId } from './lib/device-id';
import { callTrialLLM } from './lib/trial-api';

// 降噪：仅静默 console.log，保留 console.warn/error。
const console = Object.assign({}, globalThis.console, {
  log: (..._args: unknown[]) => {},
}) as Console;

/**
 * Background Service Worker — 调度员
 *
 * 不直接发起 fetch，而是负责管理 Offscreen Document 的生命周期，
 * 并将网络任务转发给运行在完整页面环境中的 offscreen.js。
 */
export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void getOrCreateDeviceId();
  });

  void getOrCreateDeviceId();

  /**
   * 确保 Offscreen Document 已创建且唯一存在
   */
  async function setupOffscreen() {
    // Chrome 116+ 支持 hasDocument，旧版本直接尝试创建
    if (typeof browser.offscreen?.hasDocument === 'function') {
      if (await browser.offscreen.hasDocument()) return;
    }
    try {
      await browser.offscreen.createDocument({
        url: browser.runtime.getURL('/offscreen.html'),
        reasons: ['DOM_PARSER'],
        justification: 'Fetch subtitle JSON without CORS and CSP restrictions',
      });
      console.log('Background: Offscreen document created.');
    } catch (err: any) {
      // 已存在时 createDocument 会抛出，静默忽略
      if (!err.message?.includes('already exists')) {
        console.error('Background: Failed to create offscreen document:', err.message);
      }
    }
  }

  function formatUnknownError(err: unknown) {
    if (err instanceof Error && err.message) return err.message;
    return String(err ?? 'Unknown error');
  }

  function respondUnhandled(sendResponse: (response?: any) => void, err: unknown, tag: string) {
    const message = `${tag}: ${formatUnknownError(err)}`;
    console.error('Background:', message);
    sendResponse({ success: false, error: message });
  }

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'FETCH_SUBTITLES_JSON') {
      (async () => {
        try {
          await setupOffscreen();
          console.log('Background: Forwarding fetch to Offscreen, URL:', message.url);

          // 将任务转发给离屏页面执行真实的 fetch
          const response = await browser.runtime.sendMessage({
            action: 'OFFSCREEN_FETCH',
            url: message.url,
          });

          sendResponse(response);
        } catch (err: unknown) {
          respondUnhandled(sendResponse, err, '字幕抓取失败');
        }
      })();

      return true; // 保持异步通信通道开启
    }

    // ── 预热：探测 enable_thinking 支持（避免首次翻译失败）──────────────
    if (message.action === 'PRIME_THINKING_SUPPORT') {
      try {
        const { apiKey, apiEndpoint, model } = message.profile ?? {};
        // 立即响应，不阻塞 UI；后台异步探测并缓存
        sendResponse({ success: true });
        void primeEnableThinkingSupport({ apiKey, apiEndpoint, model });
      } catch {
        sendResponse({ success: true });
      }
      return;
    }

    // ── Google Translate 保底翻译 ────────────────────────────────────
    if (message.action === 'BATCH_TRANSLATE') {
      (async () => {
        try {
          console.log(`Background: Google Translate ${message.texts.length} 句 → ${message.targetLang}`);
          const translations = await batchTranslate(
            message.texts,
            message.targetLang,
            message.sourceLang ?? 'auto',
          );
          sendResponse({ success: true, translations });
        } catch (err: any) {
          console.error('Background: Google Translate error:', err.message);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── Microsoft Translate 翻译 ─────────────────────────────────────
    if (message.action === 'MICROSOFT_BATCH_TRANSLATE') {
      (async () => {
        try {
          console.log(`Background: Microsoft Translate ${message.texts.length} 句 → ${message.targetLang}`);
          const translations = await microsoftBatchTranslate(
            message.texts,
            message.targetLang,
            message.sourceLang ?? 'auto',
          );
          sendResponse({ success: true, translations });
        } catch (err: any) {
          console.error('Background: Microsoft Translate error:', err.message);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── LLM API 代理 (单次) ──────────────────────────────────────────
    if (message.action === 'CALL_LLM_API') {
      (async () => {
        try {
          const { translate, analysis } = await resolveActiveProfiles();
          if (message.promptType === 'grammar_analysis' && analysis.useTrial) {
            console.log('Background: CALL_LLM_API grammar_analysis (free trial)');
            const result = await callTrialLLM({
              promptType: message.promptType,
              text: message.text,
              context: message.context,
              targetLang: analysis.targetLang,
            });
            sendResponse(result);
            return;
          }

          const override = (message.promptType === 'grammar_analysis') ? analysis : undefined;
          console.log('Background: CALL_LLM_API', message.promptType,
            override ? `(analysis engine: ${override.model})` : '(default engine)');
          const result = await callLLM({
            promptType: message.promptType,
            text: message.text,
            context: message.context,
          }, override);
          sendResponse(result);
        } catch (err: unknown) {
          respondUnhandled(sendResponse, err, 'LLM 请求失败');
        }
      })();
      return true;
    }

    // ── 两段式分析：Stage 1 快速结构 ──────────────────────────────────
    if (message.action === 'CALL_LLM_FAST_STRUCT') {
      (async () => {
        try {
          const { analysis } = await resolveActiveProfiles();
          if (analysis.useTrial) {
            console.log('Background: CALL_LLM_FAST_STRUCT (free trial)');
            const result = await callTrialLLM({
              promptType: 'fast_struct',
              text: message.text,
              targetLang: analysis.targetLang,
            });
            sendResponse(result);
            return;
          }
          console.log('Background: CALL_LLM_FAST_STRUCT', `(engine: ${analysis.model})`);
          const result = await callLLM({
            promptType: 'fast_struct',
            text: message.text,
          }, analysis);
          sendResponse(result);
        } catch (err: unknown) {
          respondUnhandled(sendResponse, err, '快速结构分析失败');
        }
      })();
      return true;
    }

    // ── 两段式分析：Stage 2 深度详解 ──────────────────────────────────
    if (message.action === 'CALL_LLM_DEEP_DETAIL') {
      (async () => {
        try {
          const { analysis } = await resolveActiveProfiles();
          if (analysis.useTrial) {
            console.log('Background: CALL_LLM_DEEP_DETAIL (free trial)');
            const result = await callTrialLLM({
              promptType: 'deep_detail',
              text: message.text,
              context: message.context,
              targetLang: analysis.targetLang,
            });
            sendResponse(result);
            return;
          }
          console.log('Background: CALL_LLM_DEEP_DETAIL', `(engine: ${analysis.model})`);
          const result = await callLLM({
            promptType: 'deep_detail',
            text: message.text,
            context: message.context,
          }, analysis);
          sendResponse(result);
        } catch (err: unknown) {
          respondUnhandled(sendResponse, err, '深度解析失败');
        }
      })();
      return true;
    }

    // ── API Profile 连通性测试 ───────────────────────────────────────
    if (message.action === 'TEST_API_PROFILE') {
      (async () => {
        try {
          const { apiKey, apiEndpoint, model } = message.profile;
          if (!apiKey || !apiEndpoint || !model) {
            sendResponse({ success: false, error: '请填写完整的 API Key、Endpoint 和模型名' });
            return;
          }
          const result = await callLLM(
            { promptType: 'translate', text: 'Hello' },
            { apiKey, apiEndpoint, model, targetLang: 'zh-Hans' },
          );
          sendResponse(result);
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ── LLM 批量翻译 ────────────────────────────────────────────────
    if (message.action === 'LLM_BATCH_TRANSLATE') {
      (async () => {
        try {
          const { translate } = await resolveActiveProfiles();
          if (!translate.apiKey) {
            sendResponse({ success: false, error: '未配置 API Key' });
            return;
          }
          console.log(`Background: LLM batch translate ${message.texts.length} lines`);
          const translations = await llmBatchTranslate(message.texts, message.context, translate);
          sendResponse({ success: true, translations });
        } catch (err: any) {
          console.error('Background: LLM batch translate error:', err.message);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
  });
});
