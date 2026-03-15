import { TRIAL_API_URL } from './constants';
import { getOrCreateDeviceId } from './device-id';
import type { CallLLMResult, PromptType } from './llm-api';

export interface TrialLLMPayload {
  promptType: PromptType;
  text: string;
  context?: string;
  targetLang: string;
}

export async function callTrialLLM(payload: TrialLLMPayload): Promise<CallLLMResult> {
  const deviceId = await getOrCreateDeviceId();

  try {
    const res = await fetch(TRIAL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': deviceId,
        'X-Client-Version': browser.runtime.getManifest().version,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const parts = [
        data?.error || `HTTP ${res.status}`,
        data?.code ? `code=${data.code}` : '',
        data?.stage ? `stage=${data.stage}` : '',
        data?.status ? `upstream=${data.status}` : '',
        data?.endpointHost ? `host=${data.endpointHost}` : '',
        data?.endpointPath ? `path=${data.endpointPath}` : '',
        data?.model ? `model=${data.model}` : '',
        data?.requestId ? `requestId=${data.requestId}` : '',
        data?.detail ? `detail=${String(data.detail).slice(0, 160)}` : '',
      ].filter(Boolean);
      return {
        success: false,
        error: parts.join(' | '),
      };
    }

    const content = data?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { success: false, error: '试用接口返回了空内容' };
    }

    return { success: true, content };
  } catch (err: any) {
    return { success: false, error: `试用请求失败: ${err.message} | url=${TRIAL_API_URL}` };
  }
}