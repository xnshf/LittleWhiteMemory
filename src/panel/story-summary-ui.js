// story-summary-ui.js
// iframe 内 UI 逻辑

import { createRelationUI } from './relation-ui.js';
import { createSummaryReadView } from './summary-read-view.js';
import { createSummarySettingsUI } from './summary-settings-ui.js';
import { createVectorActionsUI } from './vector-actions-ui.js';
import { createSummaryIOUI } from './summary-io-ui.js';
import { createConfirmationUI } from './confirmation-ui.js';
import { createStorySummaryEditor } from './story-summary-editor.js';

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════════════
    // DOM Helpers
    // ═══════════════════════════════════════════════════════════════════════════

    const $ = id => document.getElementById(id);
    const h = v => String(v ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
    const setHtml = (el, html) => {
        if (!el) return;
        const range = document.createRange();
        range.selectNodeContents(el);
        // eslint-disable-next-line no-unsanitized/method
        const fragment = range.createContextualFragment(String(html ?? ''));
        el.replaceChildren(fragment);
    };
    const setSelectOptions = (select, items, placeholderText) => {
        if (!select) return;
        select.replaceChildren();
        if (placeholderText != null) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = placeholderText;
            select.appendChild(option);
        }
        (items || []).forEach(item => {
            const option = document.createElement('option');
            option.value = item;
            option.textContent = item;
            select.appendChild(option);
        });
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════════════════

    const PARENT_ORIGIN = (() => {
        try { return new URL(document.referrer).origin; }
        catch { return window.location.origin; }
    })();

    function setStatusText(el, message, kind = '') {
        if (!el) return;
        el.textContent = message || '';
        el.style.color = kind === 'error'
            ? '#ef4444'
            : kind === 'success'
                ? '#22c55e'
                : kind === 'loading'
                    ? '#f59e0b'
                    : '';
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════════════

    let summaryData = { keywords: [], events: [], characters: { main: [], relationships: [] }, arcs: [], facts: [], characterAliases: [] };
    let localGenerating = false;
    let cleanActionState = {
        canRollback: false,
        rollbackTargetSummarizedUpTo: 0,
        rollbackWillResetBoundary: false,
        summarizedUpTo: 0,
    };
    let currentTimelineChatId = '';
    let currentChatSummaryEnabled = true;
    let currentChatSummaryPending = true;

    // ═══════════════════════════════════════════════════════════════════════════
    // Messaging
    // ═══════════════════════════════════════════════════════════════════════════

    function postMsg(type, data = {}) {
        window.parent.postMessage({ source: 'LittleWhiteMemory-StoryFrame', type, ...data }, PARENT_ORIGIN);
    }

    const relationUI = createRelationUI({ $, h, setHtml, postMsg, initChart: dom => echarts.init(dom) });
    const editor = createStorySummaryEditor({ document, h, setHtml, postMsg, getSummaryData: () => summaryData });

    const {
        renderRelations, renderArcs, renderKeywords, renderTimeline, renderCharacterAliases,
        updateStats, setRecallLog, renderFacts, resetTimelineRender,
    } = createSummaryReadView({ $, h, setHtml, relationUI, getSummaryData: () => summaryData });

    function isBusyLike() {
        return !!(localGenerating || vectorActions.isBusy());
    }

    function syncCurrentChatSummaryControls(
        enabled = currentChatSummaryEnabled,
        effectiveEnabled = enabled,
        consumable = effectiveEnabled,
    ) {
        currentChatSummaryEnabled = enabled !== false;
        const controlsEnabled = effectiveEnabled && consumable && !currentChatSummaryPending;
        const toggle = $('current-chat-enabled');
        if (toggle) {
            toggle.checked = currentChatSummaryEnabled;
            toggle.disabled = currentChatSummaryPending;
        }

        const generateButton = $('btn-generate');
        if (generateButton) {
            generateButton.disabled = !controlsEnabled;
            generateButton.title = currentChatSummaryPending
                ? '正在同步当前聊天状态'
                : !effectiveEnabled
                    ? '请先启用当前聊天的剧情总结'
                    : !consumable
                        ? '总结历史无法安全回滚；请导出并修正后重新导入，或清空总结数据'
                        : '';
        }

        for (const id of ['hide-summarized', 'keep-visible-count', 'use-vector-boundary']) {
            const control = $(id);
            if (control) control.disabled = !controlsEnabled;
        }
        syncVectorBoundaryControl(config.vector?.enabled, controlsEnabled && config.ui.hideSummarized);
    }

    function syncVectorBoundaryControl(vectorEnabled = config.vector?.enabled, hideEnabled = config.ui.hideSummarized) {
        const input = $('use-vector-boundary');
        const label = $('lbl-vector-boundary');
        const info = $('vector-boundary-info');
        const container = $('container-vector-boundary');
        if (!input || !label || !container) return;

        const enabled = !!vectorEnabled && !!hideEnabled;
        input.checked = config.ui.useVectorBoundary !== false;
        input.disabled = !enabled;
        container.classList.toggle('is-disabled', !enabled);
        label.classList.toggle('is-disabled', !enabled);

        const title = !vectorEnabled
            ? '需先启用向量功能'
            : !hideEnabled
                ? '需先开启“隐藏已总结”'
                : '开：按最新向量楼层作为隐藏计算锚点\n关：按最新的大总结楼层作为隐藏计算锚点\n提示：若您的第三方模型 API 支持 Context Caching（上下文缓存），关闭此项可提高缓存命中率；开启此项则影响命中，但语义和上下文更自然';
        label.title = title;
        if (info) {
            info.title = title;
            info.onclick = e => {
                e.preventDefault();
                e.stopPropagation();
                alert(title);
            };
        }
    }

    const settingsUI = createSummarySettingsUI({
        document, getElement: $, h, setHtml, setSelectOptions, postMsg, setStatusText, syncVectorBoundaryControl,
    });
    const { config, saveConfig, vectorConfig, addFilterRule } = settingsUI;

    const { showConfirm, showConfirmInput, showCleanActionMenu } = createConfirmationUI({
        getElement: $, postMsg, isBusyLike, cleanActionState,
    });

    const vectorActions = createVectorActionsUI({
        config, getElement: $, postMsg, showConfirm, setStatusText, saveConfig,
        syncVectorBoundaryControl, ...vectorConfig, addFilterRule,
    });
    const { initVectorUI, updateVectorStats, showVectorMismatchWarning,
        updateAnchorStats, updateAnchorProgress, updateVectorProgress, updateVectorOnlineStatus } = vectorActions;

    const summaryIO = createSummaryIOUI({ getElement: $, postMsg, showConfirmInput });
    const initSummaryIOUI = summaryIO.init;
    // ═══════════════════════════════════════════════════════════════════════════
    // Message Handler
    // ═══════════════════════════════════════════════════════════════════════════

    function saveEditor() {
        const edit = editor.saveEditor();
        if (!edit) return;
        const { section, data } = edit;
        if (section === 'aliases') postMsg('UPDATE_CHARACTER_ALIASES', { aliases: data });
        else postMsg('UPDATE_SECTION', { section, data });

        if (section === 'keywords') renderKeywords(data);
        else if (section === 'events') { renderTimeline(data, { scrollMode: 'preserve' }); $('stat-events').textContent = data.length; }
        else if (section === 'characters') renderRelations(data);
        else if (section === 'arcs') renderArcs(data);
        else if (section === 'facts') renderFacts(data);

        editor.closeEditor();
    }

    function handleParentMessage(e) {
        if (e.origin !== PARENT_ORIGIN || e.source !== window.parent) return;

        const d = e.data;
        if (!d || d.source !== 'LittleWhiteMemory') return;

        const btn = $('btn-generate');

        switch (d.type) {
            case 'CHAT_SUMMARY_STATE':
                currentChatSummaryPending = d.state?.changing === true;
                syncCurrentChatSummaryControls(
                    d.state?.chatEnabled !== false,
                    d.state?.effectiveEnabled !== false,
                    d.state?.consumable !== false,
                );
                break;

            case 'GENERATION_STATE':
                localGenerating = !!d.isGenerating;
                btn.textContent = localGenerating ? '停止' : '总结';
                break;

            case 'SUMMARY_BASE_DATA':
                if (d.stats) {
                    updateStats(d.stats);
                    $('summarized-count').textContent = d.stats.hiddenCount ?? 0;
                    cleanActionState.summarizedUpTo = d.stats.summarizedUpTo ?? 0;
                }
                if (d.hideSummarized !== undefined) {
                    $('hide-summarized').checked = d.hideSummarized;
                    config.ui.hideSummarized = d.hideSummarized;
                }
                if (d.keepVisibleCount !== undefined) $('keep-visible-count').value = d.keepVisibleCount;
                if (d.useVectorBoundary !== undefined) config.ui.useVectorBoundary = d.useVectorBoundary !== false;
                syncVectorBoundaryControl(d.vectorEnabled, d.hideSummarized ?? config.ui.hideSummarized);
                cleanActionState.canRollback = !!d.canRollback;
                cleanActionState.rollbackTargetSummarizedUpTo = Number(d.rollbackTargetSummarizedUpTo || 0);
                cleanActionState.rollbackWillResetBoundary = !!d.rollbackWillResetBoundary;
                break;

            case 'SUMMARY_FULL_DATA':
                if (d.payload) {
                    const p = d.payload;
                    const nextChatId = typeof p.chatId === 'string' ? p.chatId : '';
                    if (nextChatId !== currentTimelineChatId) {
                        currentTimelineChatId = nextChatId;
                        resetTimelineRender();
                    }
                    if (p.keywords) renderKeywords(p.keywords);
                    if (p.events) renderTimeline(p.events);
                    if (p.characters) renderRelations(p.characters);
                    if (p.arcs) renderArcs(p.arcs);
                    if (p.facts) renderFacts(p.facts);
                    if (p.characterAliases) renderCharacterAliases(p.characterAliases);
                    $('stat-events').textContent = p.events?.length || 0;
                    if (p.lastSummarizedMesId != null) $('stat-summarized').textContent = p.lastSummarizedMesId + 1;
                    if (p.stats) updateStats(p.stats);
                }
                break;

            case 'SUMMARY_STATUS':
            case 'SUMMARY_ERROR': {
                const status = $('summary-status');
                const isError = d.type === 'SUMMARY_ERROR';
                status.classList.toggle('is-error', isError);
                status.setAttribute('role', isError ? 'alert' : 'status');
                status.setAttribute('aria-live', isError ? 'assertive' : 'polite');
                status.tabIndex = isError ? 0 : -1;
                status.textContent = String((isError ? d.message : d.statusText) || '');
                status.hidden = !status.textContent;
                break;
            }

            case 'SUMMARY_CLEARED': {
                const t = d.payload?.totalFloors || 0;
                $('stat-events').textContent = 0;
                $('stat-summarized').textContent = 0;
                $('stat-pending').textContent = t;
                $('summarized-count').textContent = 0;
                summaryData = { keywords: [], events: [], characters: { main: [], relationships: [] }, arcs: [], facts: [], characterAliases: [] };
                currentTimelineChatId = '';
                renderKeywords([]);
                renderTimeline([]);
                renderRelations(null);
                renderArcs([]);
                renderFacts([]);
                renderCharacterAliases([]);
                break;
            }

            case 'LOAD_PANEL_CONFIG':
                settingsUI.handleLoadConfig(d);
                break;

            case 'PANEL_CONFIG_SAVE_RESULT':
                settingsUI.handleSaveResult(d);
                break;

            case 'SUMMARY_MODELS':
                settingsUI.handleModels(d);
                break;

            case 'SUMMARY_MODELS_ERROR':
                settingsUI.handleModelsError(d);
                break;

            case 'VECTOR_CONFIG':
                if (d.config) vectorConfig.loadVectorConfig(d.config);
                break;

            case 'VECTOR_ONLINE_STATUS':
                updateVectorOnlineStatus(d.target, d.status, d.message);
                break;

            case 'VECTOR_STATS':
                updateVectorStats(d.stats);
                if (d.mismatch !== undefined) showVectorMismatchWarning(d.mismatch);
                break;

            case 'ANCHOR_STATS':
                updateAnchorStats(d.stats || {});
                break;

            case 'ANCHOR_GEN_PROGRESS':
                updateAnchorProgress(d.current, d.total, d.message);
                break;

            case 'VECTOR_GEN_PROGRESS':
                updateVectorProgress(d);
                break;

            case 'VECTOR_EXPORT_RESULT':
                vectorActions.handleExportResult(d);
                break;

            case 'SUMMARY_COPY_RESULT':
                summaryIO.handleCopyResult(d);
                break;

            case 'SUMMARY_IMPORT_RESULT':
                summaryIO.handleImportResult(d);
                break;

            case 'VECTOR_IMPORT_RESULT':
                vectorActions.handleImportResult(d);
                break;

            case 'VECTOR_BACKUP_RESULT':
                vectorActions.handleBackupResult(d);
                break;

            case 'VECTOR_RESTORE_RESULT':
                vectorActions.handleRestoreResult(d);
                break;

            case 'RECALL_LOG':
                setRecallLog(d.text || '');
                break;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Event Bindings
    // ═══════════════════════════════════════════════════════════════════════════

    function bindEvents() {
        editor.bind();
        $('editor-save').onclick = saveEditor;

        settingsUI.bind();

        // Current chat switch (saved immediately in chat metadata)
        $('current-chat-enabled').onchange = e => {
            const enabled = e.target.checked;
            currentChatSummaryPending = true;
            syncCurrentChatSummaryControls(enabled);
            postMsg('SET_CURRENT_CHAT_ENABLED', { enabled });
        };

        // Main actions
        $('btn-clear').onclick = async () => {
            const action = await showCleanActionMenu();
            if (action === 'rollback') {
                const currentUpTo = cleanActionState.summarizedUpTo || 0;
                const rollbackMessage = cleanActionState.rollbackWillResetBoundary
                    ? '确定回退首次总结吗？首次总结生成的内容会被撤销；人工修改不会被覆盖，存在冲突时将拒绝回退。聊天记录不会删除。'
                    : `确定回退上一次总结吗？将把已总结楼层从 ${currentUpTo} 回退到 ${cleanActionState.rollbackTargetSummarizedUpTo}。聊天记录不会删除。`;
                if (await showConfirm('回退一次', rollbackMessage, '回退', '取消')) {
                    postMsg('REQUEST_ROLLBACK_ONCE');
                }
            } else if (action === 'clear') {
                if (await showConfirm('清空全部', '确定要清空本聊天的所有总结、关键词及人物关系数据吗？聊天记录不会删除。此操作不可撤销。', '清空', '取消')) {
                    postMsg('REQUEST_CLEAR');
                }
            }
        };
        $('btn-generate').onclick = () => {
            const btn = $('btn-generate');
            if (!localGenerating) {
                localGenerating = true;
                btn.textContent = '停止';
                postMsg('REQUEST_GENERATE', { config: { api: config.api, gen: config.gen, trigger: config.trigger } });
            } else {
                localGenerating = false;
                btn.textContent = '总结';
                postMsg('REQUEST_CANCEL');
            }
        };

        // Hide summarized
        $('hide-summarized').onchange = e => {
            config.ui.hideSummarized = e.target.checked;
            syncVectorBoundaryControl(config.vector?.enabled, config.ui.hideSummarized);
            postMsg('TOGGLE_HIDE_SUMMARIZED', { enabled: e.target.checked });
        };
        $('use-vector-boundary').onchange = e => {
            config.ui.useVectorBoundary = e.target.checked;
            postMsg('TOGGLE_USE_VECTOR_BOUNDARY', { enabled: e.target.checked });
        };
        $('keep-visible-count').onchange = e => {
            const parsedCount = Number.parseInt(e.target.value, 10);
            const c = Number.isFinite(parsedCount) ? Math.max(0, Math.min(50, parsedCount)) : 6;
            e.target.value = c;
            postMsg('UPDATE_KEEP_VISIBLE', { count: c });
        };

        // Fullscreen relations
        $('btn-fullscreen-relations').onclick = relationUI.openRelationsFullscreen;
        $('rel-fs-backdrop').onclick = relationUI.closeRelationsFullscreen;
        $('rel-fs-close').onclick = relationUI.closeRelationsFullscreen;

        // HF guide

        // Character selector
        $('char-sel-trigger').onclick = e => {
            e.stopPropagation();
            $('char-sel').classList.toggle('open');
        };

        document.onclick = e => {
            const cs = $('char-sel');
            if (cs && !cs.contains(e.target)) cs.classList.remove('open');
        };

        // Vector UI
        initSummaryIOUI();
        initVectorUI();

        // Resize
        window.onresize = () => {
            relationUI.resize();
        };

        // Parent messages
        window.onmessage = handleParentMessage;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Init
    // ═══════════════════════════════════════════════════════════════════════════

    function init() {
        settingsUI.loadConfig();

        // Initial state
        $('stat-events').textContent = '—';
        $('stat-summarized').textContent = '—';
        $('stat-pending').textContent = '—';
        $('summarized-count').textContent = '0';

        renderKeywords([]);
        renderTimeline([]);
        renderArcs([]);
        renderFacts([]);
        renderCharacterAliases([]);

        bindEvents();
        syncCurrentChatSummaryControls(currentChatSummaryEnabled);

        // === THEME SWITCHER ===
        (function () {
            const STORAGE_KEY = 'xb-theme-alt';
            const CSS_MAP = { default: 'story-summary.css', dark: 'story-summary.css', neo: 'story-summary-a.css', 'neo-dark': 'story-summary-a.css' };
            const link = document.querySelector('link[rel="stylesheet"]');
            const sel = document.getElementById('theme-select');
            if (!link || !sel) return;

            function applyTheme(theme) {
                if (!CSS_MAP[theme]) return;
                link.setAttribute('href', CSS_MAP[theme]);
                document.documentElement.setAttribute('data-theme', (theme === 'dark' || theme === 'neo-dark') ? 'dark' : '');
                relationUI.hideRelationTooltip();
                if (relationUI.hasRelationChart()) renderRelations(summaryData.characters);
            }

            // 启动时恢复主题
            const saved = localStorage.getItem(STORAGE_KEY) || 'default';
            applyTheme(saved);
            sel.value = saved;

            // 下拉框切换
            sel.addEventListener('change', function () {
                const theme = sel.value;
                applyTheme(theme);
                localStorage.setItem(STORAGE_KEY, theme);
                console.log(`[Theme] Switched → ${theme} (${CSS_MAP[theme]})`);
            });
        })();
        // === END THEME SWITCHER ===

        // Notify parent
        postMsg('FRAME_READY');
        document.body.classList.remove('xb-frame-loading');
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }


})();
