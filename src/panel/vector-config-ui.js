import { filterVectorModelsByPurpose, getDefaultApiPrefix, getModelListCandidateUrls, tryParseModelIds } from './model-catalog.js';
import {
    VECTOR_PROVIDER_DEFAULTS, VECTOR_API_DEFAULT_MODELS,
    createDefaultProviderProfile, normalizeProviderProfiles,
} from './provider-config.js';

// Owns the three vector-provider forms. config is the panel's live state object;
// saving and the hide-boundary control remain with the panel coordinator.
export function createVectorConfigUI({ config, getElement, setSelectOptions, saveConfig, syncVectorBoundaryControl }) {
    const $ = getElement;

    function getVectorApiConfig(prefix) {
        const provider = $(`${prefix}-api-provider`)?.value || 'siliconflow';
        const providers = normalizeProviderProfiles(prefix, config.vector?.[`${prefix}Api`] || {});
        providers[provider] = {
            url: $(`${prefix}-api-url`)?.value?.trim() || '',
            key: $(`${prefix}-api-key`)?.value?.trim() || '',
            model: $(`${prefix}-api-model-text`)?.value?.trim() || '',
            modelCache: Array.isArray(config.vector?.[`${prefix}Api`]?.providers?.[provider]?.modelCache)
                ? [...config.vector[`${prefix}Api`].providers[provider].modelCache]
                : [],
        };
        return {
            provider,
            url: providers[provider]?.url || '',
            key: providers[provider]?.key || '',
            model: providers[provider]?.model || '',
            modelCache: Array.isArray(providers[provider]?.modelCache) ? [...providers[provider].modelCache] : [],
            providers,
        };
    }

    function loadVectorApiConfig(prefix, cfg) {
        const next = cfg || {};
        const provider = next.provider || 'siliconflow';
        const profiles = normalizeProviderProfiles(prefix, next);
        const profile = profiles[provider] || createDefaultProviderProfile(provider, VECTOR_API_DEFAULT_MODELS[prefix]);
        $(`${prefix}-api-provider`).value = provider;
        $(`${prefix}-api-url`).value = profile.url || '';
        $(`${prefix}-api-key`).value = profile.key || '';
        $(`${prefix}-api-model-text`).value = profile.model || '';

        const cache = Array.isArray(profile.modelCache) ? profile.modelCache : [];
        setSelectOptions($(`${prefix}-api-model-select`), cache, '请选择');
        $(`${prefix}-api-model-select`).value = cache.includes(profile.model) ? profile.model : '';
        updateVectorProviderUI(prefix, provider);
    }

    function saveCurrentVectorApiProfile(prefix, providerOverride = null) {
        const apiCfg = config.vector[`${prefix}Api`] ||= {};
        const provider = providerOverride || $(`${prefix}-api-provider`)?.value || apiCfg.provider || 'siliconflow';
        apiCfg.providers = normalizeProviderProfiles(prefix, apiCfg);
        apiCfg.providers[provider] = {
            url: $(`${prefix}-api-url`)?.value?.trim() || '',
            key: $(`${prefix}-api-key`)?.value?.trim() || '',
            model: $(`${prefix}-api-model-text`)?.value?.trim() || '',
            modelCache: Array.isArray(apiCfg.providers?.[provider]?.modelCache) ? [...apiCfg.providers[provider].modelCache] : [],
        };
        apiCfg.provider = provider;
        apiCfg.url = apiCfg.providers[provider].url;
        apiCfg.key = apiCfg.providers[provider].key;
        apiCfg.model = apiCfg.providers[provider].model;
        apiCfg.modelCache = [...apiCfg.providers[provider].modelCache];
    }

    function updateVectorProviderUI(prefix, provider) {
        const pv = VECTOR_PROVIDER_DEFAULTS[provider] || VECTOR_PROVIDER_DEFAULTS.custom;
        const apiCfg = config.vector?.[`${prefix}Api`] || {};
        apiCfg.providers = normalizeProviderProfiles(prefix, apiCfg);
        const profile = apiCfg.providers[provider] || createDefaultProviderProfile(provider, VECTOR_API_DEFAULT_MODELS[prefix]);
        const cache = Array.isArray(profile.modelCache) ? profile.modelCache : [];
        const hasModelCache = cache.length > 0;

        $(`${prefix}-api-url-row`).classList.toggle('hidden', false);
        $(`${prefix}-api-key-row`).classList.toggle('hidden', !pv.needKey);
        $(`${prefix}-api-model-manual-row`).classList.toggle('hidden', false);
        $(`${prefix}-api-model-select-row`).classList.toggle('hidden', !hasModelCache);
        $(`${prefix}-api-connect-row`).classList.toggle('hidden', !pv.canFetch);
        $(`${prefix}-api-connect-status`).classList.toggle('hidden', !pv.canFetch);

        const urlInput = $(`${prefix}-api-url`);
        if (urlInput) {
            if (provider === 'custom') {
                urlInput.readOnly = false;
                urlInput.placeholder = 'https://your-openai-compatible-api/v1';
                urlInput.value = profile.url || '';
            } else {
                urlInput.value = pv.url || '';
                urlInput.readOnly = true;
                urlInput.placeholder = pv.url || '';
            }
        }
        $(`${prefix}-api-key`).value = profile.key || '';
        $(`${prefix}-api-model-text`).value = profile.model || '';
        setSelectOptions($(`${prefix}-api-model-select`), cache, '请选择');
        $(`${prefix}-api-model-select`).value = cache.includes(profile.model) ? profile.model : '';
    }

    async function saveVectorApiSection(prefix) {
        saveCurrentVectorApiProfile(prefix);
        await saveConfig({
            statusId: `${prefix}-api-connect-status`,
            loadingMessage: '保存中...',
            successMessage: '此组配置已保存',
        });
    }

    async function fetchVectorModels(prefix) {
        const provider = $(`${prefix}-api-provider`).value;
        const pv = VECTOR_PROVIDER_DEFAULTS[provider] || VECTOR_PROVIDER_DEFAULTS.custom;
        const statusEl = $(`${prefix}-api-connect-status`);
        const btn = $(`${prefix}-btn-connect`);
        if (!pv.canFetch) {
            statusEl.textContent = '当前渠道不支持自动拉取模型';
            return;
        }

        const baseUrl = $(`${prefix}-api-url`).value.trim();
        const apiKey = $(`${prefix}-api-key`).value.trim();
        if (!apiKey) {
            statusEl.textContent = '请先填写 API KEY';
            return;
        }

        btn.disabled = true;
        btn.textContent = '连接中...';
        statusEl.textContent = '连接中...';

        try {
            let models = null;
            for (const url of getModelListCandidateUrls(baseUrl, getDefaultApiPrefix(provider))) {
                models = await tryParseModelIds(url, {
                    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
                }, fetch);
                if (models?.length) break;
            }
            if (!models?.length) throw new Error('未获取到模型列表');

            const allModels = [...new Set(models)];
            const filteredModels = filterVectorModelsByPurpose(prefix, allModels);

            const apiCfg = config.vector[`${prefix}Api`] ||= {};
            apiCfg.providers = normalizeProviderProfiles(prefix, apiCfg);
            apiCfg.providers[provider] ||= createDefaultProviderProfile(provider, VECTOR_API_DEFAULT_MODELS[prefix]);
            apiCfg.providers[provider].modelCache = filteredModels;
            setSelectOptions($(`${prefix}-api-model-select`), apiCfg.providers[provider].modelCache, '请选择');
            $(`${prefix}-api-model-select-row`).classList.remove('hidden');
            if (!$(`${prefix}-api-model-text`).value.trim()) {
                $(`${prefix}-api-model-text`).value = filteredModels[0];
                $(`${prefix}-api-model-select`).value = filteredModels[0];
            }
            statusEl.textContent = filteredModels.length === allModels.length
                ? `拉取成功：${filteredModels.length} 个模型`
                : `拉取成功：共 ${allModels.length} 个，已筛出 ${filteredModels.length} 个适合当前用途的模型`;
        } catch (e) {
            statusEl.textContent = '拉取失败：' + (e.message || '请检查 URL 和 KEY');
        } finally {
            btn.disabled = false;
            btn.textContent = '连接 / 拉取模型列表';
        }
    }

    function getVectorConfig() {
        return {
            enabled: $('vector-enabled')?.checked || false,
            engine: 'online',
            l0Concurrency: Math.max(1, Math.min(50, Number($('vector-l0-concurrency')?.value) || 10)),
            l0Api: getVectorApiConfig('l0'),
            embeddingApi: getVectorApiConfig('embedding'),
            rerankApi: getVectorApiConfig('rerank'),
        };
    }

    function loadVectorConfig(cfg) {
        if (!cfg) return;
        $('vector-enabled').checked = !!cfg.enabled;
        $('vector-config-area').classList.toggle('hidden', !cfg.enabled);
        syncVectorBoundaryControl(cfg.enabled, config.ui.hideSummarized);
        $('vector-l0-concurrency').value = String(Math.max(1, Math.min(50, Number(cfg.l0Concurrency) || 10)));
        loadVectorApiConfig('l0', cfg.l0Api || {});
        loadVectorApiConfig('embedding', cfg.embeddingApi || {});
        loadVectorApiConfig('rerank', cfg.rerankApi || {});
    }

    return { getVectorConfig, loadVectorConfig, saveCurrentVectorApiProfile, updateVectorProviderUI, saveVectorApiSection, fetchVectorModels };
}
