import { createVectorConfigUI } from './vector-config-ui.js';
import { createFilterRulesUI } from './filter-rules-ui.js';
import { DEFAULT_SUMMARY_DELAY_FLOORS, normalizeSummaryDelayFloors } from '../summary/data/summary-delay.js';
import {
    PROVIDER_DEFAULTS, createDefaultProviderProfile,
    normalizeVectorConfigUI, normalizeSummaryApiConfigUI,
} from './provider-config.js';

// Owns settings forms and request state; the entry validates and dispatches parent messages.
export function createSummarySettingsUI({ document, getElement, h, setHtml, setSelectOptions,
    postMsg, setStatusText, syncVectorBoundaryControl }) {
    const $ = getElement;
    const $$ = sel => document.querySelectorAll(sel);

    const DEFAULT_MEMORY_PROMPT_TEMPLATE = `以上是还留在眼前的对话
以下是脑海里的记忆：
• [定了的事] 已确立的事实，以后续明确发生的变化为准
• [其他人的事] 别人的经历，当前角色可能不知晓
• 其余部分是过往经历的回忆碎片

请内化这些记忆：剧情中已确立的事实与关系发展，优先于初始设定中的旧状态。
{$剧情记忆}
这些记忆是真实的，请自然地记住它们，并结合当前剧情理解事件距今多久。`;

    const EMPTY_BUILTIN_SUMMARY_PROMPTS = Object.freeze({
        summarySystemPrompt: '',
        summaryAssistantDocPrompt: '',
        summaryAssistantAskSummaryPrompt: '',
        summaryAssistantAskContentPrompt: '',
        summaryMetaProtocolStartPrompt: '',
        summaryUserJsonFormatPrompt: '',
        summaryAssistantCheckPrompt: '',
        summaryUserConfirmPrompt: '',
        summaryUserGeneratePrompt: '',
    });
    const DEFAULT_FILTER_RULES = [
        { start: '<think>', end: '</think>' },
        { start: '<thinking>', end: '</thinking>' },
        { start: '```', end: '```' },
    ];
    const VALID_TRIGGER_TIMINGS = new Set(['after_ai', 'before_user']);

    const config = {
        api: { provider: 'openai', url: 'https://api.openai.com', key: '', model: '', modelCache: [] },
        gen: { temperature: null, top_p: null, top_k: null, presence_penalty: null, frequency_penalty: null },
        trigger: { enabled: false, interval: 20, delayFloors: DEFAULT_SUMMARY_DELAY_FLOORS, timing: 'before_user', role: 'system', useStream: true, maxPerRun: 100, wrapperHead: '', wrapperTail: '', forceInsertAtEnd: false },
        ui: { hideSummarized: true, keepVisibleCount: 6, useVectorBoundary: true },
        prompts: {
            memoryTemplate: '',
        },
        textFilterRules: [...DEFAULT_FILTER_RULES],
        vector: {
            enabled: false,
            engine: 'online',
            l0Concurrency: 10,
            l0Api: {
                provider: 'siliconflow', url: 'https://api.siliconflow.cn/v1', key: '', model: 'Qwen/Qwen3-8B', modelCache: [],
                providers: {
                    siliconflow: createDefaultProviderProfile('siliconflow', 'Qwen/Qwen3-8B'),
                    openrouter: createDefaultProviderProfile('openrouter', 'Qwen/Qwen3-8B'),
                    custom: createDefaultProviderProfile('custom', 'Qwen/Qwen3-8B'),
                }
            },
            embeddingApi: {
                provider: 'siliconflow', url: 'https://api.siliconflow.cn/v1', key: '', model: 'BAAI/bge-m3', modelCache: [],
                providers: {
                    siliconflow: createDefaultProviderProfile('siliconflow', 'BAAI/bge-m3'),
                    custom: createDefaultProviderProfile('custom', 'BAAI/bge-m3'),
                }
            },
            rerankApi: {
                provider: 'siliconflow', url: 'https://api.siliconflow.cn/v1', key: '', model: 'BAAI/bge-reranker-v2-m3', modelCache: [],
                providers: {
                    siliconflow: createDefaultProviderProfile('siliconflow', 'BAAI/bge-reranker-v2-m3'),
                    custom: createDefaultProviderProfile('custom', 'BAAI/bge-reranker-v2-m3'),
                }
            }
        }
    };

    let builtInSummaryPrompts = { ...EMPTY_BUILTIN_SUMMARY_PROMPTS };
    let modelListFetchedThisIframe = false;
    let configSaveSeq = 0;
    let summaryModelFetchSeq = 0;
    let pendingSummaryModelFetchRequestId = '';
    let summaryModelFetchTimeoutId = null;
    let settingsSaveTimeoutId = null;
    let panelConfigLoadedFromServer = false;
    let settingsOpenedWithServerConfig = false;
    const pendingConfigSaveRequests = new Map();

    function nextConfigSaveRequestId() {
        configSaveSeq += 1;
        return `summary-config-save-${Date.now()}-${configSaveSeq}`;
    }

    function nextSummaryModelFetchRequestId() {
        summaryModelFetchSeq += 1;
        return `summary-model-fetch-${Date.now()}-${summaryModelFetchSeq}`;
    }

    function resetSummaryModelFetchUi() {
        if (summaryModelFetchTimeoutId) {
            clearTimeout(summaryModelFetchTimeoutId);
            summaryModelFetchTimeoutId = null;
        }
        $('btn-connect').disabled = false;
        $('btn-connect').textContent = '连接 / 拉取模型列表';
    }

    function resetSettingsSaveUi() {
        if (settingsSaveTimeoutId) {
            clearTimeout(settingsSaveTimeoutId);
            settingsSaveTimeoutId = null;
        }
        const btn = $('settings-save');
        if (btn) {
            btn.disabled = false;
            btn.textContent = '保存';
        }
    }

    function normalizeTriggerTiming(value) {
        return VALID_TRIGGER_TIMINGS.has(value) ? value : 'before_user';
    }

    function normalizeTriggerConfig() {
        if (config.trigger.timing === 'manual') {
            config.trigger.timing = 'before_user';
            config.trigger.enabled = false;
        } else {
            config.trigger.timing = normalizeTriggerTiming(config.trigger.timing);
        }
    }

    function syncAutoSummaryControls() {
        const en = $('trigger-enabled');
        const timing = $('trigger-timing');
        const autoSummaryOptions = $('auto-summary-options');
        if (!en || !timing) return;

        timing.value = normalizeTriggerTiming(timing.value || config.trigger.timing);
        en.disabled = false;
        en.parentElement.style.opacity = '1';
        if (autoSummaryOptions) {
            autoSummaryOptions.classList.toggle('hidden', !en.checked);
        }
    }

    function loadConfig() {
        try {
            const s = localStorage.getItem('littlewhitememory_summary_panel_config');
            if (s) {
                const p = JSON.parse(s);
                Object.assign(config.api, p.api || {});
                normalizeSummaryApiConfigUI(config.api);
                config.api.modelCache = [];
                Object.assign(config.gen, p.gen || {});
                Object.assign(config.trigger, p.trigger || {});
                Object.assign(config.ui, p.ui || {});
                config.ui.useVectorBoundary = p.ui?.useVectorBoundary !== false;
                config.prompts.memoryTemplate = String(p.prompts?.memoryTemplate || config.prompts.memoryTemplate || '').trim();
                config.textFilterRules = Array.isArray(p.textFilterRules)
                    ? p.textFilterRules
                    : (Array.isArray(p.vector?.textFilterRules) ? p.vector.textFilterRules : [...DEFAULT_FILTER_RULES]);
                if (p.vector) config.vector = normalizeVectorConfigUI(p.vector, config.vector);
                normalizeTriggerConfig();
            }
        } catch { }
    }

    function applyConfig(cfg) {
        if (!cfg) return;
        const currentApiKey = String(config.api?.key || '').trim();
        const currentInputKey = String($('api-key')?.value || '').trim();
        Object.assign(config.api, cfg.api || {});
        normalizeSummaryApiConfigUI(config.api);
        if (!String(config.api.key || '').trim() && (currentInputKey || currentApiKey)) {
            config.api.key = currentInputKey || currentApiKey;
        }
        config.api.modelCache = [];
        Object.assign(config.gen, cfg.gen || {});
        Object.assign(config.trigger, cfg.trigger || {});
        Object.assign(config.ui, cfg.ui || {});
        config.ui.useVectorBoundary = cfg.ui?.useVectorBoundary !== false;
        config.prompts.memoryTemplate = String(cfg.prompts?.memoryTemplate || config.prompts.memoryTemplate || '').trim();
        config.textFilterRules = Array.isArray(cfg.textFilterRules)
            ? cfg.textFilterRules
            : (Array.isArray(cfg.vector?.textFilterRules)
                ? cfg.vector.textFilterRules
                : (Array.isArray(config.textFilterRules) ? config.textFilterRules : [...DEFAULT_FILTER_RULES]));
        if (cfg.vector) config.vector = normalizeVectorConfigUI(cfg.vector, config.vector);
        normalizeTriggerConfig();
        syncVectorBoundaryControl(config.vector?.enabled, config.ui.hideSummarized);
        localStorage.setItem('littlewhitememory_summary_panel_config', JSON.stringify(config));
    }

    function applyBuiltInSummaryPrompts(prompts) {
        const next = prompts && typeof prompts === 'object' ? prompts : {};
        builtInSummaryPrompts = {
            ...EMPTY_BUILTIN_SUMMARY_PROMPTS,
            ...next,
        };
    }

    function saveConfig(options = {}) {
        try {
            const settingsOpen = $('settings-modal')?.classList.contains('active');
            if (settingsOpen) {
                config.vector = getVectorConfig();
                config.textFilterRules = collectFilterRules();
            }
            if (!config.vector) {
                config.vector = {
                    enabled: false,
                    engine: 'online',
                    l0Concurrency: 10,
                    l0Api: { provider: 'siliconflow', url: 'https://api.siliconflow.cn/v1', key: '', model: 'Qwen/Qwen3-8B', modelCache: [] },
                    embeddingApi: { provider: 'siliconflow', url: 'https://api.siliconflow.cn/v1', key: '', model: 'BAAI/bge-m3', modelCache: [] },
                    rerankApi: { provider: 'siliconflow', url: 'https://api.siliconflow.cn/v1', key: '', model: 'BAAI/bge-reranker-v2-m3', modelCache: [] }
                };
            }
            const requestId = nextConfigSaveRequestId();
            const statusId = options.statusId || 'api-connect-status';
            const statusEl = $(statusId);
            const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
            if (statusEl && options.loadingMessage) {
                setStatusText(statusEl, options.loadingMessage, 'loading');
            }

            return new Promise(resolve => {
                let timeoutId = null;
                if (timeoutMs > 0) {
                    timeoutId = setTimeout(() => {
                        pendingConfigSaveRequests.delete(requestId);
                        setStatusText(statusEl, `${options.errorPrefix || '保存失败：'}请求超时（>${Math.round(timeoutMs / 1000)}s）`, 'error');
                        resolve(false);
                    }, timeoutMs);
                }
                pendingConfigSaveRequests.set(requestId, {
                    resolve,
                    statusId,
                    successMessage: options.successMessage || '配置已保存',
                    errorPrefix: options.errorPrefix || '保存失败：',
                    timeoutId,
                });
                postMsg('SAVE_PANEL_CONFIG', { config, requestId });
            });
        } catch (e) {
            console.error('saveConfig error:', e);
            return Promise.resolve(false);
        }
    }

    const vectorConfig = createVectorConfigUI({ config, getElement: $, setSelectOptions, saveConfig, syncVectorBoundaryControl });
    const { getVectorConfig, loadVectorConfig } = vectorConfig;
    const { renderFilterRules, collectFilterRules, addFilterRule } = createFilterRulesUI({
        document, getElement: $, escapeHtml: h, setHtml,
    });

    function updateProviderUI(provider) {
        const pv = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai;
        const hasModelCache = modelListFetchedThisIframe && Array.isArray(config.api.modelCache) && config.api.modelCache.length > 0;

        $('api-url-row').classList.remove('hidden');
        $('api-key-row').classList.remove('hidden');
        $('api-model-manual-row').classList.remove('hidden');
        $('api-model-select-row').classList.toggle('hidden', !hasModelCache);
        $('api-connect-row').classList.remove('hidden');
        $('api-connect-status').classList.remove('hidden');

        const urlInput = $('api-url');
        if (!urlInput.value && pv.url) urlInput.value = pv.url;
    }

    function openSettings() {
        $('api-provider').value = config.api.provider;
        $('api-url').value = config.api.url;
        $('api-key').value = config.api.key;
        $('api-model-text').value = config.api.model;
        $('gen-temp').value = config.gen.temperature ?? '';
        $('gen-top-p').value = config.gen.top_p ?? '';
        $('gen-top-k').value = config.gen.top_k ?? '';
        $('gen-presence').value = config.gen.presence_penalty ?? '';
        $('gen-frequency').value = config.gen.frequency_penalty ?? '';
        $('trigger-enabled').checked = config.trigger.enabled;
        $('trigger-interval').value = config.trigger.interval;
        $('trigger-delay-floors').value = normalizeSummaryDelayFloors(config.trigger.delayFloors);
        $('trigger-timing').value = config.trigger.timing;
        $('trigger-role').value = config.trigger.role || 'system';
        $('trigger-stream').checked = config.trigger.useStream !== false;
        $('trigger-max-per-run').value = config.trigger.maxPerRun || 100;
        $('trigger-wrapper-head').value = config.trigger.wrapperHead || '';
        $('trigger-wrapper-tail').value = config.trigger.wrapperTail || '';
        $('trigger-insert-at-end').checked = !!config.trigger.forceInsertAtEnd;
        fillBuiltInSummaryPromptFields();
        $('memory-prompt-template').value = config.prompts.memoryTemplate || '';
        $('api-connect-status').textContent = '';

        syncAutoSummaryControls();

        if (config.api.modelCache.length) {
            setSelectOptions($('api-model-select'), config.api.modelCache, '请选择');
            $('api-model-select').value = config.api.modelCache.includes(config.api.model) ? config.api.model : '';
        } else {
            setSelectOptions($('api-model-select'), [], '请选择');
        }

        updateProviderUI(config.api.provider);
        if (config.vector) loadVectorConfig(config.vector);
        renderFilterRules(Array.isArray(config.textFilterRules) ? config.textFilterRules : DEFAULT_FILTER_RULES);
        settingsOpenedWithServerConfig = panelConfigLoadedFromServer;
        if (!settingsOpenedWithServerConfig) {
            postMsg('REQUEST_PANEL_CONFIG');
            setStatusText($('api-connect-status'), '正在读取服务器配置，请稍候再保存', 'loading');
        }
        const saveBtn = $('settings-save');
        if (saveBtn) {
            saveBtn.disabled = !settingsOpenedWithServerConfig;
            saveBtn.textContent = settingsOpenedWithServerConfig ? '保存' : '等待配置...';
        }

        // Initialize sub-options visibility
        const autoSummaryOptions = $('auto-summary-options');
        if (autoSummaryOptions) {
            autoSummaryOptions.classList.toggle('hidden', !config.trigger.enabled);
        }
        const insertWrapperOptions = $('insert-wrapper-options');
        if (insertWrapperOptions) {
            insertWrapperOptions.classList.toggle('hidden', !config.trigger.forceInsertAtEnd);
        }

        $('settings-modal').classList.add('active');

        // Default to first tab
        $$('.settings-tab').forEach(t => t.classList.remove('active'));
        $$('.settings-tab[data-tab="tab-summary"]').forEach(t => t.classList.add('active'));
        $$('.tab-pane').forEach(p => p.classList.remove('active'));
        $('tab-summary').classList.add('active');

        postMsg('SETTINGS_OPENED');
    }

    function collectSettingsFormToConfig() {
        const pn = id => { const v = $(id).value; return v === '' ? null : parseFloat(v); };
        const provider = $('api-provider').value;

        config.api.provider = provider;
        config.api.url = $('api-url').value;
        config.api.key = $('api-key').value;
        config.api.model = $('api-model-text').value.trim();
        config.api.modelCache = [];

        config.gen.temperature = pn('gen-temp');
        config.gen.top_p = pn('gen-top-p');
        config.gen.top_k = pn('gen-top-k');
        config.gen.presence_penalty = pn('gen-presence');
        config.gen.frequency_penalty = pn('gen-frequency');

        const timing = $('trigger-timing').value;
        config.trigger.timing = normalizeTriggerTiming(timing);
        config.trigger.role = $('trigger-role').value || 'system';
        config.trigger.enabled = $('trigger-enabled').checked;
        config.trigger.interval = Math.max(1, Math.min(30, parseInt($('trigger-interval').value) || 20));
        config.trigger.delayFloors = normalizeSummaryDelayFloors($('trigger-delay-floors').value);
        config.trigger.useStream = $('trigger-stream').checked;
        config.trigger.maxPerRun = parseInt($('trigger-max-per-run').value) || 100;
        config.trigger.wrapperHead = $('trigger-wrapper-head').value;
        config.trigger.wrapperTail = $('trigger-wrapper-tail').value;
        config.trigger.forceInsertAtEnd = $('trigger-insert-at-end').checked;
        config.prompts.memoryTemplate = $('memory-prompt-template').value;
        config.textFilterRules = collectFilterRules();
        config.vector = getVectorConfig();
    }

    function fillBuiltInSummaryPromptFields() {
        $('summary-system-prompt').value = builtInSummaryPrompts.summarySystemPrompt;
        $('summary-assistant-doc-prompt').value = builtInSummaryPrompts.summaryAssistantDocPrompt;
        $('summary-assistant-ask-summary-prompt').value = builtInSummaryPrompts.summaryAssistantAskSummaryPrompt;
        $('summary-assistant-ask-content-prompt').value = builtInSummaryPrompts.summaryAssistantAskContentPrompt;
        $('summary-meta-protocol-start-prompt').value = builtInSummaryPrompts.summaryMetaProtocolStartPrompt;
        $('summary-user-json-format-prompt').value = builtInSummaryPrompts.summaryUserJsonFormatPrompt;
        $('summary-assistant-check-prompt').value = builtInSummaryPrompts.summaryAssistantCheckPrompt;
        $('summary-user-confirm-prompt').value = builtInSummaryPrompts.summaryUserConfirmPrompt;
        $('summary-user-generate-prompt').value = builtInSummaryPrompts.summaryUserGeneratePrompt;
    }

    async function saveSettings() {
        if (!settingsOpenedWithServerConfig) {
            postMsg('REQUEST_PANEL_CONFIG');
            setStatusText($('api-connect-status'), '服务器配置尚未加载完成，请关闭设置后重开再保存', 'error');
            return false;
        }
        collectSettingsFormToConfig();
        const btn = $('settings-save');
        const statusEl = $('api-connect-status');
        resetSettingsSaveUi();
        if (btn) {
            btn.disabled = true;
            btn.textContent = '保存中...';
        }
        if (statusEl) setStatusText(statusEl, '保存中...', 'loading');
        const savePromise = saveConfig({
            statusId: 'api-connect-status',
            loadingMessage: '保存中...',
            successMessage: '配置已保存',
            timeoutMs: 5000,
        });
        const saved = await savePromise;
        resetSettingsSaveUi();
        return saved;
    }

    function closeSettings() {
        resetSettingsSaveUi();
        settingsOpenedWithServerConfig = false;
        $('settings-modal').classList.remove('active');
        postMsg('SETTINGS_CLOSED');
    }

    async function fetchModels() {
        const btn = $('btn-connect');
        const statusEl = $('api-connect-status');
        const provider = $('api-provider').value;

        if (!PROVIDER_DEFAULTS[provider]?.canFetch) {
            statusEl.textContent = '当前渠道不支持自动拉取模型';
            return;
        }

        const baseUrl = $('api-url').value.trim();
        const apiKey = $('api-key').value.trim();

        if (!apiKey) {
            statusEl.textContent = '请先填写 API KEY';
            return;
        }

        const requestId = nextSummaryModelFetchRequestId();
        pendingSummaryModelFetchRequestId = requestId;
        btn.disabled = true;
        btn.textContent = '连接中...';
        statusEl.textContent = '连接中...';
        if (summaryModelFetchTimeoutId) {
            clearTimeout(summaryModelFetchTimeoutId);
        }
        summaryModelFetchTimeoutId = setTimeout(() => {
            if (pendingSummaryModelFetchRequestId !== requestId) return;
            pendingSummaryModelFetchRequestId = '';
            resetSummaryModelFetchUi();
            setStatusText(statusEl, '拉取失败：请求超时（>5s）', 'error');
        }, 5000);

        postMsg('FETCH_SUMMARY_MODELS', {
            requestId,
            provider,
            url: baseUrl,
            apiKey,
            timeoutMs: 5000,
        });
    }

    function handleLoadConfig(d) {
        panelConfigLoadedFromServer = true;
        applyBuiltInSummaryPrompts(d.builtInSummaryPrompts);
        if (d.config) applyConfig(d.config);
        if ($('settings-modal')?.classList.contains('active') && !settingsOpenedWithServerConfig) {
            openSettings();
        }
    }

    function handleSaveResult(d) {
        const pending = pendingConfigSaveRequests.get(d.requestId || '');
        if (pending) {
            pendingConfigSaveRequests.delete(d.requestId || '');
            if (pending.timeoutId) clearTimeout(pending.timeoutId);
            const statusEl = $(pending.statusId);
            if (d.success) {
                if (d.config) applyConfig(d.config);
                setStatusText(statusEl, pending.successMessage, 'success');
                pending.resolve(true);
            } else {
                setStatusText(statusEl, `${pending.errorPrefix}${d.error || '未知错误'}`, 'error');
                pending.resolve(false);
            }
        } else if (d.success && d.config) {
            applyConfig(d.config);
        }
    }

    function handleModels(d) {
        if (!d.requestId || d.requestId !== pendingSummaryModelFetchRequestId) return;
        pendingSummaryModelFetchRequestId = '';
        resetSummaryModelFetchUi();

        const models = Array.isArray(d.models) ? [...new Set(d.models.filter(Boolean))] : [];
        config.api.modelCache = models;
        modelListFetchedThisIframe = models.length > 0;
        setSelectOptions($('api-model-select'), config.api.modelCache, '请选择');
        $('api-model-select-row').classList.toggle('hidden', !models.length);

        if (!config.api.model && models.length) {
            config.api.model = models[0];
            $('api-model-text').value = models[0];
            $('api-model-select').value = models[0];
        } else if (config.api.model) {
            $('api-model-select').value = config.api.model;
        }

        setStatusText($('api-connect-status'), `拉取成功：${models.length} 个模型`, 'success');
    }

    function handleModelsError(d) {
        if (!d.requestId || d.requestId !== pendingSummaryModelFetchRequestId) return;
        pendingSummaryModelFetchRequestId = '';
        resetSummaryModelFetchUi();
        setStatusText($('api-connect-status'), '拉取失败：' + (d.message || '请检查 URL 和 KEY'), 'error');
    }

    function bind() {
        // Settings modal
        $('btn-settings').onclick = openSettings;
        $('settings-backdrop').onclick = closeSettings;
        $('settings-close').onclick = closeSettings;
        $('settings-cancel').onclick = closeSettings;
        $('settings-save').onclick = saveSettings;

        // Settings tabs
        $$('.settings-tab').forEach(tab => {
            tab.onclick = () => {
                const targetId = tab.dataset.tab;
                if (!targetId) return;

                // Update tab active state
                $$('.settings-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // Update pane active state
                $$('.tab-pane').forEach(p => p.classList.remove('active'));
                $(targetId).classList.add('active');

                // If switching to debug tab, refresh log
                if (targetId === 'tab-debug') {
                    postMsg('REQUEST_RECALL_LOG');
                }
            };
        });

        // API provider change
        $('api-provider').onchange = e => {
            const pv = PROVIDER_DEFAULTS[e.target.value] || PROVIDER_DEFAULTS.openai;
            $('api-url').value = '';
            modelListFetchedThisIframe = false;
            if (!pv.canFetch) config.api.modelCache = [];
            updateProviderUI(e.target.value);
        };

        $('btn-connect').onclick = fetchModels;
        $('api-model-text').oninput = e => { config.api.model = e.target.value.trim(); };
        $('api-model-select').onchange = e => {
            const value = e.target.value || '';
            if (value) {
                $('api-model-text').value = value;
                config.api.model = value;
            }
        };
        $('btn-reset-memory-prompt-template').onclick = () => {
            $('memory-prompt-template').value = DEFAULT_MEMORY_PROMPT_TEMPLATE;
        };

        // Trigger timing
        $('trigger-timing').onchange = () => {
            syncAutoSummaryControls();
        };

        // 总结间隔范围校验
        $('trigger-interval').onchange = e => {
            let val = parseInt(e.target.value) || 20;
            val = Math.max(1, Math.min(30, val));
            e.target.value = val;
        };

        // 延迟总结楼层范围校验
        $('trigger-delay-floors').onchange = e => {
            e.target.value = normalizeSummaryDelayFloors(e.target.value);
        };

        // Gen params collapsible
        const genParamsToggle = $('gen-params-toggle');
        const genParamsContent = $('gen-params-content');
        if (genParamsToggle && genParamsContent) {
            genParamsToggle.onclick = () => {
                const collapse = genParamsToggle.closest('.settings-collapse');
                collapse.classList.toggle('open');
                genParamsContent.classList.toggle('hidden');
            };
        }

        // Filter rules collapsible
        const filterRulesToggle = $('filter-rules-toggle');
        const filterRulesContent = $('filter-rules-content');
        if (filterRulesToggle && filterRulesContent) {
            filterRulesToggle.onclick = () => {
                const collapse = filterRulesToggle.closest('.settings-collapse');
                collapse.classList.toggle('open');
                filterRulesContent.classList.toggle('hidden');
            };
        }

        // Auto summary sub-options toggle
        const triggerEnabled = $('trigger-enabled');
        const autoSummaryOptions = $('auto-summary-options');
        if (triggerEnabled && autoSummaryOptions) {
            triggerEnabled.onchange = () => {
                syncAutoSummaryControls();
            };
        }

        // Force insert sub-options toggle
        const triggerInsertAtEnd = $('trigger-insert-at-end');
        const insertWrapperOptions = $('insert-wrapper-options');
        if (triggerInsertAtEnd && insertWrapperOptions) {
            triggerInsertAtEnd.onchange = () => {
                insertWrapperOptions.classList.toggle('hidden', !triggerInsertAtEnd.checked);
            };
        }
    }

    return { config, vectorConfig, addFilterRule, loadConfig, saveConfig, bind,
        handleLoadConfig, handleSaveResult, handleModels, handleModelsError };
}
