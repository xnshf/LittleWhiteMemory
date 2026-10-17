// Model-list requests and purpose-specific filtering for the iframe settings panel.

function normalizeApiBaseUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

function normalizeApiPrefix(prefix) {
    const raw = String(prefix || '').trim();
    if (!raw) return '';
    return `/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function hasExplicitApiVersion(url) {
    const baseUrl = normalizeApiBaseUrl(url);
    return /\/v\d[\w.-]*$/i.test(baseUrl);
}

export function getDefaultApiPrefix(provider) {
    const key = String(provider || '').trim().toLowerCase();
    if (key === 'google' || key === 'gemini') return '/v1beta';
    return '/v1';
}

function resolveApiBaseUrl(url, defaultPrefix = '') {
    const baseUrl = normalizeApiBaseUrl(url);
    const prefix = normalizeApiPrefix(defaultPrefix);
    if (!baseUrl || !prefix || hasExplicitApiVersion(baseUrl)) return baseUrl;
    if (baseUrl.toLowerCase().endsWith(prefix.toLowerCase())) return baseUrl;
    return `${baseUrl}${prefix}`;
}

function joinApiUrl(baseUrl, path) {
    const normalizedBase = normalizeApiBaseUrl(baseUrl);
    const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${String(path || '')}`;
    return normalizedBase ? `${normalizedBase}${normalizedPath}` : normalizedPath;
}

export function getModelListCandidateUrls(url, defaultPrefix = '') {
    const baseUrl = normalizeApiBaseUrl(url);
    if (!baseUrl) return [];

    const candidates = [joinApiUrl(baseUrl, '/models')];
    const resolvedBase = resolveApiBaseUrl(baseUrl, defaultPrefix);
    if (resolvedBase && resolvedBase !== baseUrl) {
        candidates.push(joinApiUrl(resolvedBase, '/models'));
    }

    return [...new Set(candidates)];
}

export async function tryParseModelIds(url, fetchOptions, fetchModels) {
    try {
        const res = await fetchModels(url, fetchOptions);
        if (!res.ok) return null;
        const data = await res.json();
        return data?.data?.map(m => m?.id).filter(Boolean) || null;
    } catch {
        return null;
    }
}

const VECTOR_MODEL_FILTERS = {
    embedding: {
        include: [
            'embedding', 'embed', 'bge-m3', 'bge-large', 'bge-base', 'e5-', 'multilingual-e5',
            'jina-embeddings', 'text-embedding', 'voyage', 'gte-', 'gte_', 'gte.'
        ],
        exclude: [
            'rerank', 'reranker', 'chat', 'instruct', 'reasoner', 'vl', 'vision',
            'tts', 'speech', 'audio', 'whisper', 'transcription', 'image', 'sdxl', 'moderation'
        ],
    },
    rerank: {
        include: [
            'rerank', 'reranker', 'bge-reranker', 'jina-reranker', 'cohere-rerank'
        ],
        exclude: [
            'embedding', 'embed', 'chat', 'instruct', 'reasoner', 'vl', 'vision',
            'tts', 'speech', 'audio', 'whisper', 'transcription', 'image', 'sdxl', 'moderation'
        ],
    },
    l0: {
        include: [],
        exclude: [
            'embedding', 'embed', 'rerank', 'reranker', 'tts', 'speech', 'audio',
            'whisper', 'transcription', 'stt', 'image', 'sdxl', 'flux', 'wanx',
            'midjourney', 'moderation'
        ],
    },
};

export function filterVectorModelsByPurpose(prefix, models) {
    const rule = VECTOR_MODEL_FILTERS[prefix];
    if (!rule || !Array.isArray(models)) return [];

    const normalized = [...new Set(models.filter(Boolean).map(m => String(m).trim()).filter(Boolean))];
    const matched = normalized.filter(modelId => {
        const lower = modelId.toLowerCase();
        if (rule.exclude.some(keyword => lower.includes(keyword))) return false;
        if (!rule.include.length) return true;
        return rule.include.some(keyword => lower.includes(keyword));
    });

    return matched.length ? matched : normalized;
}
