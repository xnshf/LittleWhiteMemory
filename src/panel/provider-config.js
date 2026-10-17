// Provider profiles and legacy vector settings normalization for the iframe panel.

export const PROVIDER_DEFAULTS = {
    openai: { url: 'https://api.openai.com', needKey: true, canFetch: true },
};
export const VECTOR_PROVIDER_DEFAULTS = {
    siliconflow: { url: 'https://api.siliconflow.cn/v1', needKey: true, canFetch: true },
    openrouter: { url: 'https://openrouter.ai/api/v1', needKey: true, canFetch: true },
    custom: { url: '', needKey: true, canFetch: true }
};

const VECTOR_API_SUPPORTED_PROVIDERS = {
    l0: ['siliconflow', 'openrouter', 'custom'],
    embedding: ['siliconflow', 'custom'],
    rerank: ['siliconflow', 'custom'],
};

export const VECTOR_API_DEFAULT_MODELS = {
    l0: 'Qwen/Qwen3-8B',
    embedding: 'BAAI/bge-m3',
    rerank: 'BAAI/bge-reranker-v2-m3',
};

export function createDefaultProviderProfile(provider, model = '') {
    const pv = VECTOR_PROVIDER_DEFAULTS[provider] || VECTOR_PROVIDER_DEFAULTS.custom;
    return {
        url: pv.url || '',
        key: '',
        model: model || '',
        modelCache: [],
    };
}

export function normalizeProviderProfiles(prefix, apiCfg = {}) {
    const supported = VECTOR_API_SUPPORTED_PROVIDERS[prefix] || ['custom'];
    const model = apiCfg.model || VECTOR_API_DEFAULT_MODELS[prefix] || '';
    const out = {};
    supported.forEach(provider => {
        const raw = apiCfg.providers?.[provider] || {};
        const defaults = createDefaultProviderProfile(provider, model);
        out[provider] = {
            url: String(raw.url || defaults.url || '').trim(),
            key: String(raw.key || '').trim(),
            model: String(raw.model || defaults.model || '').trim(),
            modelCache: Array.isArray(raw.modelCache) ? raw.modelCache.filter(Boolean) : [],
        };
    });

    const currentProvider = String(apiCfg.provider || supported[0] || 'custom').toLowerCase();
    if (out[currentProvider]) {
        if (apiCfg.url && !out[currentProvider].url) out[currentProvider].url = String(apiCfg.url).trim();
        if (apiCfg.key && !out[currentProvider].key) out[currentProvider].key = String(apiCfg.key).trim();
        if (apiCfg.model && !out[currentProvider].model) out[currentProvider].model = String(apiCfg.model).trim();
        if (Array.isArray(apiCfg.modelCache) && !out[currentProvider].modelCache.length) {
            out[currentProvider].modelCache = apiCfg.modelCache.filter(Boolean);
        }
    }

    return out;
}

export function normalizeVectorConfigUI(raw, defaults) {
    const base = JSON.parse(JSON.stringify(defaults));
    const legacyOnline = raw?.online || {};
    const sharedKey = String(legacyOnline.key || '').trim();
    const sharedUrl = String(legacyOnline.url || '').trim();

    if (raw) {
        base.enabled = !!raw.enabled;
        base.engine = 'online';
        base.l0Concurrency = Math.max(1, Math.min(50, Number(raw.l0Concurrency) || 10));
        Object.assign(base.l0Api, {
            provider: raw.l0Api?.provider || legacyOnline.provider || base.l0Api.provider,
            url: raw.l0Api?.url || sharedUrl || base.l0Api.url,
            key: raw.l0Api?.key || sharedKey || base.l0Api.key,
            model: raw.l0Api?.model || base.l0Api.model,
            modelCache: Array.isArray(raw.l0Api?.modelCache) ? raw.l0Api.modelCache : [],
            providers: normalizeProviderProfiles('l0', raw.l0Api || {}),
        });
        Object.assign(base.embeddingApi, {
            provider: raw.embeddingApi?.provider || base.embeddingApi.provider,
            url: raw.embeddingApi?.url || sharedUrl || base.embeddingApi.url,
            key: raw.embeddingApi?.key || sharedKey || base.embeddingApi.key,
            model: raw.embeddingApi?.model || legacyOnline.model || base.embeddingApi.model,
            modelCache: Array.isArray(raw.embeddingApi?.modelCache) ? raw.embeddingApi.modelCache : [],
            providers: normalizeProviderProfiles('embedding', raw.embeddingApi || {}),
        });
        Object.assign(base.rerankApi, {
            provider: raw.rerankApi?.provider || base.rerankApi.provider,
            url: raw.rerankApi?.url || sharedUrl || base.rerankApi.url,
            key: raw.rerankApi?.key || sharedKey || base.rerankApi.key,
            model: raw.rerankApi?.model || base.rerankApi.model,
            modelCache: Array.isArray(raw.rerankApi?.modelCache) ? raw.rerankApi.modelCache : [],
            providers: normalizeProviderProfiles('rerank', raw.rerankApi || {}),
        });
    }

    return base;
}

export function normalizeSummaryApiConfigUI(apiCfg = {}) {
    if (String(apiCfg.provider || '').toLowerCase() === 'custom') {
        apiCfg.provider = 'openai';
    }
    if (!PROVIDER_DEFAULTS[apiCfg.provider]) {
        throw new Error('剧情总结仅支持 OpenAI 兼容接口');
    }
    return apiCfg;
}
