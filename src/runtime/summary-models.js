import { getRequestHeaders } from '../../../../../../script.js';
import { getDefaultApiPrefix, resolveApiBaseUrl } from '../support/openai-url-utils.js';
import {
    fetchHostOpenAICompatibleModels,
    setHostChatCompletionsRequestHeadersProvider,
} from '../support/host-llm/chat-completions/client.js';

const SUMMARY_MODEL_FETCH_PROVIDERS = new Set(['openai']);
const SUMMARY_MODEL_FETCH_TIMEOUT_MS = 5000;

export async function fetchSummaryModelsForUi(payload = {}) {
    const provider = String(payload?.provider || '').trim().toLowerCase() === 'custom'
        ? 'openai'
        : String(payload?.provider || '').trim().toLowerCase();
    const baseUrl = String(payload?.url || '').trim();
    const apiKey = String(payload?.apiKey || '').trim();

    if (!SUMMARY_MODEL_FETCH_PROVIDERS.has(provider)) {
        throw new Error('当前渠道不支持自动拉取模型');
    }
    if (!baseUrl) {
        throw new Error('请先填写 API URL');
    }
    if (!apiKey) {
        throw new Error('请先填写 API KEY');
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Number(payload?.timeoutMs) || SUMMARY_MODEL_FETCH_TIMEOUT_MS);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        setHostChatCompletionsRequestHeadersProvider(() => getRequestHeaders());
        return await fetchHostOpenAICompatibleModels({
            baseUrl: resolveApiBaseUrl(baseUrl, getDefaultApiPrefix(provider)),
            apiKey,
        }, { signal: controller.signal });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error(`请求超时（>${Math.floor(timeoutMs / 1000)}s）`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}
