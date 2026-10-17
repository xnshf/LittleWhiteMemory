// ═══════════════════════════════════════════════════════════════════════════
// Story Summary - 主入口
//
// 稳定目标：
// 1) 自动隐藏由当前聊天长度、有效总结/向量边界和保留楼数共同决定
// 2) 关闭隐藏 / 功能 / 插件：立即恢复全部楼层，作废尚未完成的显隐任务
// 3) 加载 / 删除全量核对，日常增长差量校正；一次应用最终状态再保存
// 4) Prompt 注入：extension_prompts + IN_CHAT + depth（动态计算，最小为2）
// ═══════════════════════════════════════════════════════════════════════════

import { getContext } from "../../../../../extensions.js";
import {
    event_types,
    extension_prompts,
    extension_prompt_types,
    chat_metadata,
} from "../../../../../../script.js";
import { EXT_ID } from "../support/constants.js";
import { xbLog, CacheRegistry } from "../support/debug-core.js";
import { formatErrorDetails } from '../support/error-details.js';
import { createModuleEvents } from "../support/event-manager.js";
import { isTrustedMessage } from "../support/iframe-messaging.js";
import { createStoryPanel } from './story-panel.js';
import { compactRecallRuntimeStatsForLog, createPanelStats } from './panel-stats.js';
import { createVectorGeneration } from './vector-generation.js';
import { createEventVectorSync } from './event-vector-sync.js';
import { AUTO_L0_BACKFILL_DELAY_MS, createVectorMaintenance } from './vector-maintenance.js';
import { createSummaryFrameActions } from './summary-frame-actions.js';
import { initAfterAiGate, notifyAfterAiHint, registerAfterAiHandler } from "../support/after-ai-gate.js";
import {
    commitIfSignalActive,
    runWithAbortDeadline,
} from "../support/abort-utils.js";
import {
    GENERATE_INTERCEPTOR_ORDER,
    registerGenerateInterceptor,
    unregisterGenerateInterceptor,
} from "../support/generate-interceptor.js";
import { fetchSummaryModelsForUi } from './summary-models.js';

// config/store
import {
    BUILTIN_SUMMARY_PROMPTS,
    getSettings,
    getSummaryPanelConfig,
    getVectorConfig,
    saveVectorConfig,
    saveSummaryPanelConfig,
    saveSummaryPanelConfigVerified,
    applySummaryPanelConfigSnapshot,
    loadConfigFromServer,
    readSummaryPanelConfigFromServer,
} from "../summary/data/config.js";
import {
    getChatStorySummaryEnabled,
    resolveStorySummaryEnabled,
    setChatStorySummaryEnabled,
} from "../summary/data/chat-toggle.js";
import {
    getSummaryStore,
    rollbackSummaryIfNeeded,
    getRollbackOnceTargetEndMesId,
    isSummaryConsumable,
    extractRelationshipsFromFacts,
} from "../summary/data/store.js";
import { normalizeCharacterAliases } from "../summary/data/character-aliases.js";
import { formatStorySummaryMemoryText } from "../summary/data/summary-memory-package.js";
import { getAutoSummaryPlan } from '../summary/generate/summary-trigger.js';
import { createHideStateController } from './hide-state.js';

// prompt recall coordination
import {
    createRecallPrefetchCoordinator,
    getRecallPrefetchStartAction,
} from "../summary/generate/recall-prefetch.js";
import { selectBestStoryMemoryResult } from "../summary/generate/story-memory-result.js";
import { createRecallReuse, recallConfigKey } from '../summary/generate/recall-reuse.js';
import { formatRecallDiagnostics, formatRecallReuseDiagnostics } from './recall-diagnostics.js';
import { prepareMemoryPrompt } from './prompt-prepare.js';

// summary generation
import { runSummaryGeneration } from "../summary/generate/generator.js";
import { createSummaryGenerationCancelledError } from "../summary/generate/llm.js";

// vector service
import { embed, getEngineFingerprint } from "../vector/utils/embedder.js";

// tokenizer
import { preload as preloadTokenizer, isReady as isTokenizerReady } from "../vector/utils/tokenizer.js";

import { getMeta } from "../vector/storage/chunk-store.js";
import { flushL12DurableCopy, restoreL12DurableCopy } from '../vector/storage/l12-durable-copy.js';

import {
    syncOnMessageDeleted,
    syncOnMessageSwiped,
} from "../vector/pipeline/chunk-builder.js";
import { initStateIntegration } from "../vector/pipeline/state-integration.js";
import {
    getStateAtoms,
    deleteStateAtomsFromFloor,
    deleteStateVectorsFromFloor,
    deleteL0IndexFromFloor,
    getL0Index,
} from "../vector/storage/state-store.js";

// vector io
import { exportVectors, importVectors, backupToServer, restoreFromServer, fetchManifest, deleteServerBackup, isDeleteUnsupportedError, getBackupFilename } from "../vector/storage/vector-io.js";
import { createBackupManagerModal } from "../panel/backup-manager-modal.js";
import {
    clearRecallRuntime,
    getRecallRuntimeStats,
    refreshRecallRuntime,
    retainRecallRuntimeOnly,
    shutdownRecallRuntime,
    warmRecallRuntime,
} from "../vector/runtime/runtime.js";
import {
    VECTOR_WRITE_SCOPES,
    cancelEmbeddingWriteTasks,
    claimWarningCooldown,
    clearWarningCooldowns,
    clearWarningCooldownsForChat,
    isVectorWriteSessionCurrent,
    resumeVectorWriteCoordinator,
    runVectorConfigTransition,
    runVectorWriteTask,
    shutdownVectorWriteCoordinator,
    waitForVectorWrites,
} from "../vector/runtime/maintenance-coordinator.js";

import { invalidateLexicalIndex, removeDocumentsByFloor, addEventDocuments } from "../vector/retrieval/lexical-index.js";

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

const MODULE_ID = "storySummary";
let chatSummaryStateChanging = false;
let activeSummaryExecution = null;

function getStorySummaryEnablement() {
    const context = getContext();
    const globalEnabled = Boolean(getSettings().storySummary?.enabled);
    const hasChat = Boolean(context?.chatId);
    const chatEnabled = hasChat
        ? getChatStorySummaryEnabled(chat_metadata, EXT_ID)
        : true;
    const effectiveEnabled = hasChat && resolveStorySummaryEnabled(globalEnabled, chatEnabled);
    return { context, hasChat, globalEnabled, chatEnabled, effectiveEnabled };
}

export function getStorySummaryChatState() {
    const { context, hasChat, globalEnabled, chatEnabled, effectiveEnabled } = getStorySummaryEnablement();
    const chat = context?.chat;
    const consumable = effectiveEnabled
        && isSummaryConsumable(getSummaryStore(), Array.isArray(chat) ? chat.length : 0);
    return {
        hasChat,
        chatId: context?.chatId || null,
        globalEnabled,
        chatEnabled,
        effectiveEnabled,
        consumable,
        changing: chatSummaryStateChanging,
    };
}

export function isStorySummaryEnabledForCurrentChat() {
    return getStorySummaryEnablement().effectiveEnabled;
}

export function isStorySummaryConsumableForCurrentChat() {
    const { context, effectiveEnabled } = getStorySummaryEnablement();
    if (!effectiveEnabled) return false;
    return isSummaryConsumable(
        getSummaryStore(),
        Array.isArray(context?.chat) ? context.chat.length : 0,
    );
}

function notifyStorySummaryChatState() {
    const state = getStorySummaryChatState();
    postToFrame({ type: "CHAT_SUMMARY_STATE", state });
}

export async function setStorySummaryEnabledForCurrentChat(enabled) {
    if (chatSummaryStateChanging) {
        throw new Error("Story summary chat state is already changing");
    }
    const context = getContext();
    if (!context?.chatId) {
        throw new Error("No active chat");
    }

    const targetChatId = context.chatId;
    const targetMetadata = context.chatMetadata || chat_metadata;
    const previousEnabled = getChatStorySummaryEnabled(targetMetadata, EXT_ID);
    const nextEnabled = enabled !== false;
    if (previousEnabled === nextEnabled) {
        notifyStorySummaryChatState();
        return getStorySummaryChatState();
    }

    chatSummaryStateChanging = true;
    setChatStorySummaryEnabled(targetMetadata, EXT_ID, nextEnabled);
    if (!nextEnabled) {
        cancelActiveSummaryExecution();
        // 元数据已经在内存中生效；必须在首次 await 前封死旧召回的提交窗口。
        cancelRecallAndClearPrompt('chat-disabled');
    }

    try {
        notifyStorySummaryChatState();
        if (!nextEnabled) clearHideState({ persist: false });
        await context.saveMetadata();

        if (getContext()?.chatId === targetChatId && events) {
            await handleChatChanged();
        }
    } catch (error) {
        setChatStorySummaryEnabled(targetMetadata, EXT_ID, previousEnabled);
        if (getContext()?.chatId === targetChatId && events) {
            await handleChatChanged();
        }
        throw error;
    } finally {
        chatSummaryStateChanging = false;
        notifyStorySummaryChatState();
    }

    return getStorySummaryChatState();
}

function logRecallRuntimeCheckpoint(label, extra = "") {
    const suffix = extra ? ` ${extra}` : "";
    xbLog.info(MODULE_ID, `[RecallRuntime] ${label}${suffix} stats=${compactRecallRuntimeStatsForLog()}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 状态变量
// ═══════════════════════════════════════════════════════════════════════════

let lastRecallLogText = "";
let lastSummaryStatus = { type: 'SUMMARY_STATUS', statusText: '' };
/** @type {ReturnType<typeof createModuleEvents>|null} */
let events = null;
let afterAiGateDispose = null;
let activeChatId = null;

// ═══════════════════════════════════════════════════════════════════════════
// TaskGuard — 互斥任务管理（summary / vector / anchor）
// ═══════════════════════════════════════════════════════════════════════════

class TaskGuard {
    #running = new Set();

    acquire(taskName) {
        if (this.#running.has(taskName)) return null;
        this.#running.add(taskName);
        let released = false;
        return () => {
            if (!released) {
                released = true;
                this.#running.delete(taskName);
            }
        };
    }

    isRunning(taskName) {
        return this.#running.has(taskName);
    }

    isAnyRunning(...taskNames) {
        return taskNames.some(t => this.#running.has(t));
    }
}

const guard = new TaskGuard();

const autoSummaryTimers = new Map();
const CHAT_CHANGE_LEXICAL_WARMUP_MS = 3000;
const AUTO_SUMMARY_DELAY_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { removeBackupManagerModal, showBackupManagerModal } = createBackupManagerModal({
    fetchManifest,
    deleteServerBackup,
    isDeleteUnsupportedError,
});

const EXT_PROMPT_KEY = "LittleWhiteMemory_StorySummary";
// ═══════════════════════════════════════════════════════════════════════════
// 分词器预热（依赖 tokenizer.js 内部状态机，支持失败重试）
// ═══════════════════════════════════════════════════════════════════════════

function maybePreloadTokenizer() {
    if (isTokenizerReady()) return;

    const vectorCfg = getVectorConfig();
    if (!vectorCfg?.enabled) return;

    preloadTokenizer()
        .then(() => {
            xbLog.info(MODULE_ID, "分词器预热成功");
        })
        .catch((e) => {
            xbLog.warn(MODULE_ID, "分词器预热失败（将降级运行，可稀后重试）", e);
        });
}

// ═══════════════════════════════════════════════════════════════════════════
// 工具：执行斜杠命令
// ═══════════════════════════════════════════════════════════════════════════

async function executeSlashCommand(command) {
    try {
        const executeCmd =
            window.executeSlashCommands ||
            window.executeSlashCommandsOnChatInput ||
            (typeof SillyTavern !== "undefined" && SillyTavern.getContext()?.executeSlashCommands);

        if (executeCmd) {
            await executeCmd(command);
        } else if (typeof window.STscript === "function") {
            await window.STscript(command);
        }
    } catch (e) {
        xbLog.error(MODULE_ID, `执行命令失败: ${command}`, e);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 生成状态管理
// ═══════════════════════════════════════════════════════════════════════════

function isSummaryGenerating() {
    return guard.isRunning('summary');
}

function beginSummaryExecution() {
    const { chatId } = getContext();
    if (!chatId) return null;
    const execution = {
        chatId,
        controller: new AbortController(),
    };
    activeSummaryExecution = execution;
    postToFrame({ type: 'SUMMARY_STATUS', statusText: '准备总结…' });
    return execution;
}

function cancelActiveSummaryExecution() {
    const execution = activeSummaryExecution;
    if (!execution || execution.controller.signal.aborted) return false;
    execution.controller.abort();
    cancelPendingHide();
    return true;
}

function finishSummaryExecution(execution) {
    if (activeSummaryExecution === execution) {
        activeSummaryExecution = null;
    }
}

function isSummaryExecutionActive(execution) {
    return !!execution
        && !execution.controller.signal.aborted
        && activeSummaryExecution === execution
        && getContext()?.chatId === execution.chatId;
}

function postSummaryExecution(execution, payload) {
    // A stopped run may still report its final status, but never into another chat/run.
    if (activeSummaryExecution === execution && getContext()?.chatId === execution.chatId) {
        postToFrame(payload);
    }
}

function assertSummaryExecutionActive(execution) {
    if (!isSummaryExecutionActive(execution)) {
        throw createSummaryGenerationCancelledError();
    }
}

function notifySummaryState() {
    postToFrame({ type: "GENERATION_STATE", isGenerating: guard.isRunning('summary') });
}

// ═══════════════════════════════════════════════════════════════════════════
// iframe 通讯
// ═══════════════════════════════════════════════════════════════════════════

function postToFrame(payload) {
    if (payload?.type === "RECALL_LOG") lastRecallLogText = String(payload.text || "");
    if (payload?.type === 'SUMMARY_STATUS' || payload?.type === 'SUMMARY_ERROR') lastSummaryStatus = payload;
    panel.post(payload);
}

function flushPendingFrameMessages() {
    if (panel.flush()) sendAnchorStatsToFrame();
}

// ═══════════════════════════════════════════════════════════════════════════
// 向量功能：UI 交互/状态
// ═══════════════════════════════════════════════════════════════════════════

function sendVectorConfigToFrame() {
    const cfg = getVectorConfig();
    postToFrame({ type: "VECTOR_CONFIG", config: cfg });
}

const panelStats = createPanelStats({ postToFrame });
const { sendVectorStatsToFrame, sendAnchorStatsToFrame } = panelStats;

const eventVectorSync = createEventVectorSync({
    guard,
    isChatStale,
    isStorySummaryEnabledForCurrentChat,
    assertSummaryExecutionActive,
    sendVectorStatsToFrame,
    refreshEntityLexiconAndWarmup: (...args) => maintenance.refreshEntityLexiconAndWarmup(...args),
    scheduleVectorIntegrityCheck: (...args) => maintenance.scheduleVectorIntegrityCheck(...args),
});
const maintenance = createVectorMaintenance({
    guard,
    isChatStale,
    isRuntimeActive: () => !!events,
    panelStats,
    executeSlashCommand,
    eventVectorSync,
});
const { autoVectorizeMissingEvents } = eventVectorSync;
const {
    rememberVectorMaintenance,
    scheduleAutoL0Backfill,
    scheduleVectorIntegrityCheck,
    scheduleLexicalWarmup,
    refreshEntityLexiconAndWarmup,
    getBackgroundQuietWaitMs,
    handleVisibilityChangeForBackground,
    handleViewportChangeForBackground,
} = maintenance;
const vectorGeneration = createVectorGeneration({
    guard,
    postToFrame,
    panelStats,
    executeSlashCommand,
    changeRecallData,
    getActiveChatId: () => activeChatId,
    eventVectorSync,
    maintenance,
});
const {
    handleAnchorGenerate,
    handleAnchorClear,
    handleAnchorCancel,
    handleTestOnlineService,
    handleGenerateVectors,
    handleClearVectors,
    handleVectorCancel,
} = vectorGeneration;

const {
    handleSummaryCopy,
    handleSummaryImportText,
    handleSummaryClear,
    handleSummaryRollbackOnce,
    handleUpdateSection,
    handleUpdateCharacterAliases,
} = createSummaryFrameActions({
    guard,
    postToFrame,
    executeSlashCommand,
    changeRecallData,
    cancelRecallAndClearPrompt,
    notifyStorySummaryChatState,
    sendFrameBaseData,
    sendFrameFullData,
    buildFramePayload,
    getHideUiSettings,
    clearHideState,
    applyHideState,
    panelStats,
    eventVectorSync,
    maintenance,
});

// ═══════════════════════════════════════════════════════════════════════════
// Embedding 连接预热
// ═══════════════════════════════════════════════════════════════════════════

function warmupEmbeddingConnection() {
    const vectorCfg = getVectorConfig();
    if (!vectorCfg?.enabled) return;
    embed(['.'], vectorCfg, { timeout: 5000 }).catch(() => { });
}

function warmupActiveVectorCache() {
    const vectorCfg = getVectorConfig();
    const { chatId } = getContext();
    logRecallRuntimeCheckpoint("warmupActiveVectorCache:start", `chat=${chatId || "-"} enabled=${vectorCfg?.enabled ? 1 : 0}`);
    retainRecallRuntimeOnly(chatId || null).catch((error) => {
        xbLog.warn(MODULE_ID, '召回运行时清理非当前聊天缓存失败', error);
    });
    if (!vectorCfg?.enabled) {
        if (chatId) {
            logRecallRuntimeCheckpoint("warmupActiveVectorCache:clear-disabled", `chat=${chatId}`);
            clearRecallRuntime().catch((error) => {
                xbLog.warn(MODULE_ID, '召回运行时清理失败', error);
            });
        }
        return;
    }
    if (!chatId) return;
    warmRecallRuntime(chatId, { reason: 'active-chat-warmup' })
        .then((result) => {
            logRecallRuntimeCheckpoint("warmupActiveVectorCache:done", `chat=${chatId} skipped=${result?.skipped ? 1 : 0} status=${result?.stats?.status || '-'}`);
        })
        .catch((error) => {
            xbLog.warn(MODULE_ID, '召回运行时预热失败', error);
        })
        .finally(() => {
            if (activeChatId !== chatId) return;
            sendVectorStatsToFrame().catch(() => { });
        });
}

async function finishVectorConfigTransition(previousConfig, nextConfig, reason, writeSession) {
    const nextEnabled = !!nextConfig?.enabled;
    const configChanged = JSON.stringify(previousConfig || {}) !== JSON.stringify(nextConfig || {});
    if (!configChanged) return false;

    logRecallRuntimeCheckpoint('vectorConfig:shutdown-runtime', `reason=${reason} enabled=${nextEnabled ? 1 : 0}`);
    await shutdownRecallRuntime();
    if (
        isVectorWriteSessionCurrent(writeSession)
        && nextEnabled
        && isStorySummaryConsumableForCurrentChat()
    ) {
        scheduleVectorIntegrityCheck(0);
    }
    return true;
}

function changeVectorConfig(reason, applyChange) {
    const transition = runVectorConfigTransition(
        {
            chatId: getContext()?.chatId || '',
            reason: `Vector configuration changed: ${reason}`,
        },
        async (writeSession) => {
            const previousVectorConfig = getVectorConfig();
            const result = await applyChange();
            // This config is global, including if the chat changed while saving.
            cancelRecallAndClearPrompt('vector-config-changed');
            const nextVectorConfig = getVectorConfig();
            const changed = await finishVectorConfigTransition(
                previousVectorConfig,
                nextVectorConfig,
                reason,
                writeSession,
            );
            return { previousVectorConfig, nextVectorConfig, result, changed };
        },
    );
    cancelRecallAndClearPrompt('vector-config-changed');
    return transition;
}

async function rebuildActiveVectorCacheAfterSummary(execution) {
    assertSummaryExecutionActive(execution);
    const vectorCfg = getVectorConfig();
    if (!vectorCfg?.enabled) return;

    const chatId = execution.chatId;

    try {
        logRecallRuntimeCheckpoint("afterSummaryRefresh:start", `chat=${chatId}`);
        postSummaryExecution(execution, { type: 'SUMMARY_STATUS', statusText: '总结已保存，正在更新检索状态…' });
        let result = await refreshRecallRuntime(chatId, { reason: 'after-summary' });
        assertSummaryExecutionActive(execution);
        if (result?.stale) {
            logRecallRuntimeCheckpoint("afterSummaryRefresh:retry", `chat=${chatId}`);
            result = await refreshRecallRuntime(chatId, { reason: 'after-summary-retry' });
            assertSummaryExecutionActive(execution);
        }
        if (result?.skipped) {
            xbLog.info(MODULE_ID, "大总结后召回运行时已标记待加载");
        } else if (!result?.ready) {
            xbLog.warn(MODULE_ID, "大总结后召回运行时状态更新未完成");
        } else {
            xbLog.info(MODULE_ID, "大总结后召回运行时已更新状态");
        }
        logRecallRuntimeCheckpoint("afterSummaryRefresh:done", `chat=${chatId} ready=${result?.ready ? 1 : 0} stale=${result?.stale ? 1 : 0}`);
        await sendVectorStatsToFrame();
    } catch (error) {
        if (!isSummaryExecutionActive(execution)) {
            await clearRecallRuntime(chatId);
            throw createSummaryGenerationCancelledError();
        }
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Overlay 面板
// ═══════════════════════════════════════════════════════════════════════════

const panel = createStoryPanel({
    document, window, navigator, $,
    onMessage: handleFrameMessage,
    onClose: removeBackupManagerModal,
});

// 魔棒菜单打开当前聊天的剧情记忆，不再绑定消息楼层。
export function openStorySummaryPanel() {
    if (!events || !getSettings().storySummary?.enabled) return;
    const { chatId, chat } = getContext();
    if (!chatId || !Array.isArray(chat)) {
        window.toastr?.warning('请先打开一个聊天', '剧情记忆');
        return;
    }
    openPanelForMessage();
}

// ═══════════════════════════════════════════════════════════════════════════
// 面板数据发送
// ═══════════════════════════════════════════════════════════════════════════

async function sendSavedConfigToFrame() {
    try {
        const loadedConfig = await readSummaryPanelConfigFromServer();
        if (recallConfigKey(getSummaryPanelConfig()) !== recallConfigKey(loadedConfig)) {
            cancelRecallAndClearPrompt('recall-config-reloaded');
        }
        const previousVectorConfig = getVectorConfig();
        const vectorChanged = JSON.stringify(previousVectorConfig || {})
            !== JSON.stringify(loadedConfig?.vector || {});
        const transition = vectorChanged
            ? await changeVectorConfig(
                'server-reload',
                () => applySummaryPanelConfigSnapshot(loadedConfig),
            )
            : null;
        const savedConfig = transition?.result
            || (vectorChanged ? getSummaryPanelConfig() : applySummaryPanelConfigSnapshot(loadedConfig));
        postToFrame({
            type: "LOAD_PANEL_CONFIG",
            config: savedConfig,
            builtInSummaryPrompts: BUILTIN_SUMMARY_PROMPTS,
        });
    } catch (e) {
        xbLog.warn(MODULE_ID, "加载面板配置失败", e);
    }
}

function getHideUiSettings() {
    const cfg = getSummaryPanelConfig() || {};
    const ui = cfg.ui || {};
    const parsedKeep = Number.parseInt(ui.keepVisibleCount, 10);
    const keepVisibleCount = Number.isFinite(parsedKeep) ? Math.max(0, Math.min(50, parsedKeep)) : 6;
    return {
        hideSummarized: !!ui.hideSummarized,
        keepVisibleCount,
        useVectorBoundary: ui.useVectorBoundary !== false,
    };
}

function setHideUiSettings(patch = {}) {
    const cfg = getSummaryPanelConfig() || {};
    const current = getHideUiSettings();
    const next = {
        ...cfg,
        ui: {
            ...(cfg.ui || {}),
            hideSummarized: patch.hideSummarized !== undefined ? !!patch.hideSummarized : current.hideSummarized,
            keepVisibleCount: patch.keepVisibleCount !== undefined
                ? (() => {
                    const parsedKeep = Number.parseInt(patch.keepVisibleCount, 10);
                    return Number.isFinite(parsedKeep) ? Math.max(0, Math.min(50, parsedKeep)) : 6;
                })()
                : current.keepVisibleCount,
            useVectorBoundary: patch.useVectorBoundary !== undefined
                ? !!patch.useVectorBoundary
                : current.useVectorBoundary,
        },
    };
    if (recallConfigKey(cfg) !== recallConfigKey(next)) cancelRecallAndClearPrompt('evidence-visibility-changed');
    saveSummaryPanelConfig(next);
    return next.ui;
}

function sendFrameBaseData(store, totalFloors) {
    const ui = getHideUiSettings();
    const hiddenCount = (getContext().chat || []).reduce((count, message) => count + Number(!!message?.is_system), 0);

    const lastSummarized = store?.lastSummarizedMesId ?? -1;
    const rollbackTargetEndMesId = getRollbackOnceTargetEndMesId(store);
    postToFrame({
        type: "SUMMARY_BASE_DATA",
        stats: {
            totalFloors,
            summarizedUpTo: lastSummarized + 1,
            eventsCount: store?.json?.events?.length || 0,
            pendingFloors: totalFloors - lastSummarized - 1,
            hiddenCount,
        },
        hideSummarized: ui.hideSummarized,
        keepVisibleCount: ui.keepVisibleCount,
        useVectorBoundary: ui.useVectorBoundary,
        vectorEnabled: !!getVectorConfig()?.enabled,
        canRollback: rollbackTargetEndMesId != null,
        rollbackTargetSummarizedUpTo: rollbackTargetEndMesId == null ? 0 : rollbackTargetEndMesId + 1,
        rollbackWillResetBoundary: rollbackTargetEndMesId != null && rollbackTargetEndMesId < 0,
    });
}

function sendFrameFullData(store, totalFloors) {
    if (store?.json) {
        postToFrame({
            type: "SUMMARY_FULL_DATA",
            payload: buildFramePayload(store),
        });
    } else {
        postToFrame({ type: "SUMMARY_CLEARED", payload: { totalFloors } });
    }
}

function buildFramePayload(store) {
    const json = store?.json || {};
    const facts = json.facts || [];
    return {
        chatId: getContext().chatId || '',
        keywords: json.keywords || [],
        events: json.events || [],
        characters: {
            main: json.characters?.main || [],
            relationships: extractRelationshipsFromFacts(facts),
        },
        arcs: json.arcs || [],
        facts,
        characterAliases: normalizeCharacterAliases(json.characterAliases)
            .map(({ from, to, evidence }) => ({ from, to, evidence })),
        lastSummarizedMesId: store?.lastSummarizedMesId ?? -1,
    };
}

function getConsumableSummaryMemoryText() {
    if (!isStorySummaryConsumableForCurrentChat()) return "";
    return formatStorySummaryMemoryText(getSummaryStore());
}

function openPanelForMessage() {
    panel.show();

    const { chat } = getContext();
    const store = getSummaryStore();
    const totalFloors = chat.length;

    sendFrameBaseData(store, totalFloors);
    sendFrameFullData(store, totalFloors);
    notifySummaryState();

    sendVectorConfigToFrame();
    sendVectorStatsToFrame();
}

// ═══════════════════════════════════════════════════════════════════════════
// Hide/Unhide
// - 非向量：boundary = lastSummarizedMesId
// - 向量：boundary = meta.lastChunkFloor（若为 -1 或关闭向量边界隐藏，则回退到 lastSummarizedMesId）
// ═══════════════════════════════════════════════════════════════════════════

const hideState = createHideStateController({
    getState: () => {
        const context = getContext();
        const ui = getHideUiSettings();
        const store = getSummaryStore();
        return {
            chatId: context.chatId,
            chat: context.chat,
            saveChat: context.saveChat,
            enabled: !!events && getSettings().storySummary?.enabled !== false
                && isStorySummaryConsumableForCurrentChat() && ui.hideSummarized,
            summaryBoundary: store?.lastSummarizedMesId ?? -1,
            useVectorBoundary: !!getVectorConfig()?.enabled && ui.useVectorBoundary,
            keepVisibleCount: ui.keepVisibleCount,
        };
    },
    readVectorBoundary: async chatId => (await getMeta(chatId)).lastChunkFloor,
    renderMessage: (id, hidden) => {
        const element = document.querySelector(`#chat .mes[mesid="${id}"]`);
        if (element) element.setAttribute('is_system', String(hidden));
    },
    refresh: () => getContext().swipe?.refresh(),
    save: state => state.saveChat(),
    onError: (error, stage) => {
        const message = stage === 'boundary'
            ? '读取向量隐藏边界失败，已按有效总结边界恢复原文'
            : stage === 'save' ? '楼层显隐已更新，但保存聊天失败' : '更新楼层显隐失败';
        xbLog.error(MODULE_ID, message, error);
        window.toastr?.warning(message, '剧情总结');
    },
});

function applyHideState() {
    return hideState.reconcile();
}

function cancelPendingHide() {
    hideState.cancel();
}

function applyHideStateDebounced() {
    hideState.schedule();
}

function scheduleAutoSummary(reason, delayMs = AUTO_SUMMARY_DELAY_MS) {
    const scheduledChatId = getContext().chatId || null;
    const previous = autoSummaryTimers.get(reason);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
        autoSummaryTimers.delete(reason);
        if (isChatStale(scheduledChatId)) return;
        const quietWait = getBackgroundQuietWaitMs();
        if (quietWait > 0) {
            scheduleAutoSummary(reason, quietWait);
            return;
        }
        maybeAutoRunSummary(reason);
    }, delayMs);
    autoSummaryTimers.set(reason, timer);
}

function clearDeferredBackgroundTasks() {
    maintenance.clearDeferredVectorTasks();
    for (const timer of autoSummaryTimers.values()) clearTimeout(timer);
    autoSummaryTimers.clear();
}

function clearHideState(options) {
    return hideState.clear(options);
}

// ═══════════════════════════════════════════════════════════════════════════
// 自动总结
// ═══════════════════════════════════════════════════════════════════════════

async function maybeAutoRunSummary(reason) {
    const { chatId, chat } = getContext();
    if (!chatId || !Array.isArray(chat)) return;
    if (!isStorySummaryEnabledForCurrentChat()) return;
    if (!isStorySummaryConsumableForCurrentChat()) return;

    const cfgAll = getSummaryPanelConfig();
    const trig = cfgAll.trigger || {};

    if (isSummaryGenerating()) return;

    const store = getSummaryStore();
    const lastSummarized = store?.lastSummarizedMesId ?? -1;
    const { target, triggered } = getAutoSummaryPlan(chat, lastSummarized, trig, reason);
    if (!triggered) return;

    await autoRunSummaryWithRetry(target, { api: cfgAll.api, gen: cfgAll.gen, trigger: trig });
}

async function autoRunSummaryWithRetry(targetMesId, configForRun) {
    const release = guard.acquire('summary');
    if (!release) return;
    const execution = beginSummaryExecution();
    if (!execution) {
        release();
        return;
    }
    notifySummaryState();

    try {
        let lastResult = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (!isSummaryExecutionActive(execution)) {
                postSummaryExecution(execution, { type: 'SUMMARY_STATUS', statusText: '已停止' });
                return;
            }
            const result = await runSummaryGeneration(targetMesId, configForRun, {
                onStatus: (text) => postSummaryExecution(execution, { type: 'SUMMARY_STATUS', statusText: `自动总结 ${attempt}/3：${text}` }),
                onError: (msg) => postSummaryExecution(execution, { type: 'SUMMARY_ERROR', message: `自动总结 ${attempt}/3：${msg}` }),
                onComplete: async ({ newEventIds, aliasChanged, store }) => {
                    assertSummaryExecutionActive(execution);
                    postToFrame({ type: "SUMMARY_FULL_DATA", payload: buildFramePayload(store) });

                    // Alias migration can also change existing participants.
                    // The corpus skips unchanged documents; no full rebuild.
                    refreshEntityLexiconAndWarmup();
                    if (aliasChanged || newEventIds?.length) {
                        const allEvents = store?.json?.events || [];
                        const idSet = new Set(newEventIds || []);
                        addEventDocuments(aliasChanged ? allEvents : allEvents.filter(e => idSet.has(e.id)));
                    }

                    if (isStorySummaryEnabledForCurrentChat() && getHideUiSettings().hideSummarized) {
                        applyHideStateDebounced();
                    }
                    await updateFrameStatsAfterSummary(store, execution);

                    await autoVectorizeMissingEvents(store, execution);
                    await rebuildActiveVectorCacheAfterSummary(execution);
                },
            }, {
                signal: execution.controller.signal,
                targetChatId: execution.chatId,
            });
            lastResult = result;

            if (result.cancelled) {
                if (result.committed && isStorySummaryConsumableForCurrentChat()) {
                    scheduleVectorIntegrityCheck();
                }
                return;
            }

            if (result.success) {
                if (isStorySummaryConsumableForCurrentChat()) scheduleVectorIntegrityCheck();
                return;
            }

            if (attempt < 3) await sleep(1000);
        }

        if (!isSummaryExecutionActive(execution)) return;
        if (lastResult?.stale) {
            await executeSlashCommand("/echo severity=warning 对话在总结期间持续变化，本次结果未保存；下次触发时会重新总结。");
        } else {
            await executeSlashCommand("/echo severity=error 剧情总结失败（已尝试 3 次）。请稍后再试。");
        }
    } catch (error) {
        xbLog.error(MODULE_ID, '自动总结执行失败', error);
        postSummaryExecution(execution, { type: 'SUMMARY_ERROR', message: `自动总结执行失败：${formatErrorDetails(error, { includeStack: false })}` });
    } finally {
        finishSummaryExecution(execution);
        release();
        notifySummaryState();
    }
}

async function updateFrameStatsAfterSummary(store, execution) {
    assertSummaryExecutionActive(execution);
    const { chat } = getContext();
    const totalFloors = Array.isArray(chat) ? chat.length : 0;
    await sendFrameBaseData(store, totalFloors);
    assertSummaryExecutionActive(execution);
}

// ═══════════════════════════════════════════════════════════════════════════
// iframe 消息处理
// ═══════════════════════════════════════════════════════════════════════════

async function handleFrameMessage(event) {
    const iframe = document.getElementById("littlewhitememory-story-summary-iframe");
    if (!isTrustedMessage(event, iframe, "LittleWhiteMemory-StoryFrame")) return;

    const data = event.data;

    switch (data.type) {
        case "FRAME_READY": {
            // Queued summary data may belong to a chat that closed before the iframe loaded.
            panel.clearPendingMessages(payload => [
                'SUMMARY_BASE_DATA', 'SUMMARY_FULL_DATA', 'SUMMARY_CLEARED',
                'VECTOR_STATS', 'ANCHOR_STATS',
            ].includes(payload?.type));
            panel.markReady();
            flushPendingFrameMessages();
            const context = getContext();
            const store = context?.chatId ? getSummaryStore() : null;
            const totalFloors = Array.isArray(context?.chat) ? context.chat.length : 0;
            sendFrameBaseData(store, totalFloors);
            sendFrameFullData(store, totalFloors);
            notifySummaryState();
            postToFrame(lastSummaryStatus);
            sendSavedConfigToFrame();
            sendVectorConfigToFrame();
            sendVectorStatsToFrame();
            sendAnchorStatsToFrame();
            notifyStorySummaryChatState();
            break;
        }

        case "SETTINGS_OPENED":
        case "FULLSCREEN_OPENED":
        case "EDITOR_OPENED":
        case "CONFIRM_OPENED":
            $(".xb-ss-close-btn").hide();
            break;

        case "SETTINGS_CLOSED":
            removeBackupManagerModal();
            $(".xb-ss-close-btn").show();
            break;

        case "FULLSCREEN_CLOSED":
        case "EDITOR_CLOSED":
        case "CONFIRM_CLOSED":
            $(".xb-ss-close-btn").show();
            break;

        case "SET_CURRENT_CHAT_ENABLED": {
            try {
                await setStorySummaryEnabledForCurrentChat(data.enabled !== false);
            } catch (error) {
                xbLog.warn(MODULE_ID, "Failed to update current chat story summary state", error);
                postToFrame({ type: "SUMMARY_ERROR", message: "当前聊天开关未能保存，请重试" });
                notifyStorySummaryChatState();
            }
            break;
        }

        case "REQUEST_GENERATE": {
            if (!isStorySummaryEnabledForCurrentChat()) {
                postToFrame({ type: "SUMMARY_STATUS", statusText: "请先启用当前聊天的剧情总结" });
                notifyStorySummaryChatState();
                break;
            }
            if (!isStorySummaryConsumableForCurrentChat()) {
                postToFrame({ type: "SUMMARY_ERROR", message: "总结历史无法安全回滚：请导出当前总结，修正后重新导入，或清空总结数据" });
                break;
            }
            const ctx = getContext();
            handleManualGenerate((ctx.chat?.length ?? 1) - 1, data.config || {});
            break;
        }

        case "REQUEST_CANCEL":
            if (cancelActiveSummaryExecution()) {
                postToFrame({ type: "SUMMARY_STATUS", statusText: "正在停止..." });
            }
            break;

        case "FETCH_SUMMARY_MODELS":
            (async () => {
                try {
                    const models = await fetchSummaryModelsForUi(data);
                    postToFrame({
                        type: "SUMMARY_MODELS",
                        requestId: data.requestId || "",
                        models,
                    });
                } catch (e) {
                    postToFrame({
                        type: "SUMMARY_MODELS_ERROR",
                        requestId: data.requestId || "",
                        message: String(e?.message || e || "拉取模型失败"),
                    });
                }
            })();
            break;

        case "VECTOR_TEST_ONLINE":
            handleTestOnlineService(data.provider, data.config, data.target || "embedding");
            break;

        case "VECTOR_REPAIR":
        case "VECTOR_GENERATE":
            if (data.config) {
                if (JSON.stringify(getVectorConfig() || {}) !== JSON.stringify(data.config || {})) {
                    await changeVectorConfig(
                        'vector-generate',
                        () => saveVectorConfig(data.config) || {},
                    );
                }
            }
            maybePreloadTokenizer();
            refreshEntityLexiconAndWarmup();
            handleGenerateVectors(data.type === 'VECTOR_REPAIR' ? 'repair' : 'rebuild');
            break;

        case "VECTOR_CLEAR":
            await handleClearVectors();
            break;

        case "VECTOR_CANCEL_GENERATE":
            handleVectorCancel();
            break;

        case "ANCHOR_GENERATE":
            await handleAnchorGenerate();
            break;

        case "ANCHOR_CLEAR":
            await handleAnchorClear();
            break;

        case "ANCHOR_CANCEL":
            handleAnchorCancel();
            break;

        case "REQUEST_ANCHOR_STATS":
            sendAnchorStatsToFrame();
            break;

        case "REQUEST_RECALL_LOG":
            postToFrame({ type: "RECALL_LOG", text: lastRecallLogText });
            break;

        case "VECTOR_EXPORT":
            (async () => {
                try {
                    const result = await exportVectors((status) => {
                        postToFrame({ type: "VECTOR_IO_STATUS", status });
                    });
                    postToFrame({
                        type: "VECTOR_EXPORT_RESULT",
                        success: true,
                        filename: result.filename,
                        size: result.size,
                        chunkCount: result.chunkCount,
                        eventCount: result.eventCount,
                    });
                } catch (e) {
                    postToFrame({ type: "VECTOR_EXPORT_RESULT", success: false, error: e.message });
                }
            })();
            break;

        case "SUMMARY_COPY":
            handleSummaryCopy();
            break;

        case "SUMMARY_IMPORT_TEXT":
            handleSummaryImportText(data.text);
            break;

        case "VECTOR_IMPORT_PICK":
            // 在 parent 创建 file picker，避免 iframe 传大文件
            (async () => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".zip";

                input.onchange = async () => {
                    const file = input.files?.[0];
                    if (!file) {
                        postToFrame({ type: "VECTOR_IMPORT_RESULT", success: false, error: "未选择文件" });
                        return;
                    }

                    try {
                        const targetChatId = getContext()?.chatId || '';
                        const result = await runVectorWriteTask(
                            {
                                chatId: targetChatId,
                                kind: 'vector-import',
                                scope: VECTOR_WRITE_SCOPES.IO,
                            },
                            async (writeSession) => {
                                if (getContext()?.chatId !== targetChatId) {
                                    throw new Error('聊天已切换，已取消导入');
                                }
                                return changeRecallData(targetChatId, () => importVectors(file, (status) => {
                                    postToFrame({ type: "VECTOR_IO_STATUS", status });
                                }, {
                                    targetChatId,
                                    signal: writeSession.signal,
                                    isCurrent: () => isVectorWriteSessionCurrent(writeSession),
                                }));
                            },
                        );
                        if (!result) {
                            postToFrame({ type: "VECTOR_IMPORT_RESULT", success: false, error: "导入已取消" });
                            return;
                        }
                        postToFrame({
                            type: "VECTOR_IMPORT_RESULT",
                            success: true,
                            chunkCount: result.chunkCount,
                            eventCount: result.eventCount,
                            warnings: result.warnings,
                            fingerprintMismatch: result.fingerprintMismatch,
                        });
                        await sendVectorStatsToFrame();
                    } catch (e) {
                        postToFrame({ type: "VECTOR_IMPORT_RESULT", success: false, error: e.message });
                    }
                };

                input.click();
            })();
            break;
        case "VECTOR_BACKUP_SERVER":
            (async () => {
                try {
                    const result = await backupToServer((status) => {
                        postToFrame({ type: "VECTOR_IO_STATUS", status });
                    });
                    postToFrame({
                        type: "VECTOR_BACKUP_RESULT",
                        success: true,
                        size: result.size,
                        chunkCount: result.chunkCount,
                        eventCount: result.eventCount,
                    });
                } catch (e) {
                    postToFrame({ type: "VECTOR_BACKUP_RESULT", success: false, error: e.message });
                }
            })();
            break;

        case "VECTOR_RESTORE_SERVER":
            (async () => {
                try {
                    const targetChatId = getContext()?.chatId || '';
                    const result = await runVectorWriteTask(
                        {
                            chatId: targetChatId,
                            kind: 'vector-restore',
                            scope: VECTOR_WRITE_SCOPES.IO,
                        },
                        async (writeSession) => {
                            if (getContext()?.chatId !== targetChatId) {
                                throw new Error('聊天已切换，已取消恢复');
                            }
                            return changeRecallData(targetChatId, () => restoreFromServer((status) => {
                                postToFrame({ type: "VECTOR_IO_STATUS", status });
                            }, {
                                targetChatId,
                                signal: writeSession.signal,
                                isCurrent: () => isVectorWriteSessionCurrent(writeSession),
                            }));
                        },
                    );
                    if (!result) {
                        postToFrame({ type: "VECTOR_RESTORE_RESULT", success: false, error: "恢复已取消" });
                        return;
                    }
                    postToFrame({
                        type: "VECTOR_RESTORE_RESULT",
                        success: true,
                        chunkCount: result.chunkCount,
                        eventCount: result.eventCount,
                        warnings: result.warnings,
                        fingerprintMismatch: result.fingerprintMismatch,
                    });
                    await sendVectorStatsToFrame();
                } catch (e) {
                    postToFrame({ type: "VECTOR_RESTORE_RESULT", success: false, error: e.message });
                }
            })();
            break;

        case "VECTOR_LIST_BACKUPS":
            (async () => {
                try {
                    const files = await fetchManifest();
                    showBackupManagerModal(files);
                } catch (e) {
                    showBackupManagerModal([]);
                }
            })();
            break;

        case "REQUEST_VECTOR_STATS":
            sendVectorStatsToFrame();
            maybePreloadTokenizer();
            break;

        case "REQUEST_CLEAR":
            await handleSummaryClear();
            break;

        case "REQUEST_ROLLBACK_ONCE":
            await handleSummaryRollbackOnce();
            break;

        case "CLOSE_PANEL":
            panel.hide();
            break;

        case "UPDATE_SECTION":
            handleUpdateSection(data);
            break;

        case "UPDATE_CHARACTER_ALIASES":
            handleUpdateCharacterAliases(data);
            break;

        case "TOGGLE_HIDE_SUMMARIZED": {
            setHideUiSettings({ hideSummarized: !!data.enabled });

            if (data.enabled) await applyHideState();
            else await clearHideState();
            break;
        }

        case "UPDATE_KEEP_VISIBLE": {
            const oldCount = getHideUiSettings().keepVisibleCount;
            const parsedCount = Number.parseInt(data.count, 10);
            const newCount = Number.isFinite(parsedCount) ? Math.max(0, Math.min(50, parsedCount)) : 6;
            if (newCount === oldCount) break;

            setHideUiSettings({ keepVisibleCount: newCount });

            await applyHideState();
            const { chat } = getContext();
            await sendFrameBaseData(getSummaryStore(), Array.isArray(chat) ? chat.length : 0);
            break;
        }

        case "TOGGLE_USE_VECTOR_BOUNDARY": {
            setHideUiSettings({ useVectorBoundary: data.enabled !== false });

            await applyHideState();
            const { chat } = getContext();
            await sendFrameBaseData(getSummaryStore(), Array.isArray(chat) ? chat.length : 0);
            break;
        }

        case "SAVE_PANEL_CONFIG":
            if (data.config) {
                try {
                    const previousRecallConfig = recallConfigKey(getSummaryPanelConfig());
                    const vectorChanged = Boolean(
                        data.config.vector
                        && JSON.stringify(getVectorConfig() || {}) !== JSON.stringify(data.config.vector || {})
                    );
                    let previousVectorConfig = getVectorConfig();
                    let savedConfig;
                    if (vectorChanged) {
                        const transition = await changeVectorConfig(
                            'panel-save',
                            () => saveSummaryPanelConfigVerified(data.config),
                        );
                        previousVectorConfig = transition?.previousVectorConfig || previousVectorConfig;
                        savedConfig = transition?.result || getSummaryPanelConfig();
                    } else {
                        savedConfig = await saveSummaryPanelConfigVerified(data.config);
                    }
                    if (previousRecallConfig !== recallConfigKey(savedConfig)) {
                        cancelRecallAndClearPrompt('recall-config-changed');
                    }
                    const nextVectorConfig = savedConfig?.vector || {};
                    const vectorEnabledChanged = !!previousVectorConfig?.enabled !== !!nextVectorConfig?.enabled;
                    const vectorFingerprintChanged = !!previousVectorConfig?.enabled
                        && !!nextVectorConfig?.enabled
                        && getEngineFingerprint(previousVectorConfig) !== getEngineFingerprint(nextVectorConfig);
                    if (!vectorEnabledChanged && !vectorFingerprintChanged) {
                        logRecallRuntimeCheckpoint("savePanelConfig:warm-runtime", `chat=${getContext().chatId || "-"} invalidated=0`);
                        warmupActiveVectorCache();
                    }
                    postToFrame({
                        type: "PANEL_CONFIG_SAVE_RESULT",
                        success: true,
                        requestId: data.requestId || "",
                        config: savedConfig,
                    });
                    sendVectorConfigToFrame();
                    await applyHideState();
                    {
                        const { chat } = getContext();
                        const store = getSummaryStore();
                        await sendFrameBaseData(store, Array.isArray(chat) ? chat.length : 0);
                    }
                } catch (e) {
                    xbLog.error(MODULE_ID, "保存面板配置失败", e);
                    postToFrame({
                        type: "PANEL_CONFIG_SAVE_RESULT",
                        success: false,
                        requestId: data.requestId || "",
                        error: e?.message || "保存失败",
                    });
                }
            }
            break;

        case "REQUEST_PANEL_CONFIG":
            sendSavedConfigToFrame();
            break;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 手动总结
// ═══════════════════════════════════════════════════════════════════════════

async function handleManualGenerate(mesId, config) {
    if (isSummaryGenerating()) {
        postToFrame({ type: "SUMMARY_STATUS", statusText: "上一轮总结仍在进行中..." });
        return;
    }

    const release = guard.acquire('summary');
    if (!release) return;
    const execution = beginSummaryExecution();
    if (!execution) {
        release();
        return;
    }
    notifySummaryState();

    try {
        const result = await runSummaryGeneration(mesId, config, {
            onStatus: (text) => postSummaryExecution(execution, { type: 'SUMMARY_STATUS', statusText: text }),
            onError: (msg) => postSummaryExecution(execution, { type: 'SUMMARY_ERROR', message: msg }),
            onComplete: async ({ newEventIds, aliasChanged, store }) => {
                // The summary is already saved, even if cancellation arrived
                // during that save. Only follow-up work is cancellable now.
                if (activeSummaryExecution === execution && getContext()?.chatId === execution.chatId) {
                    cancelRecallAndClearPrompt('manual-summary-completed');
                }
                assertSummaryExecutionActive(execution);
                postToFrame({ type: "SUMMARY_FULL_DATA", payload: buildFramePayload(store) });

                // Alias migration can also change existing participants.
                // The corpus skips unchanged documents; no full rebuild.
                refreshEntityLexiconAndWarmup();
                if (aliasChanged || newEventIds?.length) {
                    const allEvents = store?.json?.events || [];
                    const idSet = new Set(newEventIds || []);
                    addEventDocuments(aliasChanged ? allEvents : allEvents.filter(e => idSet.has(e.id)));
                }

                applyHideStateDebounced();
                await updateFrameStatsAfterSummary(store, execution);

                await autoVectorizeMissingEvents(store, execution);
                await rebuildActiveVectorCacheAfterSummary(execution);
            },
        }, {
            signal: execution.controller.signal,
            targetChatId: execution.chatId,
        });
        if (result.committed && isStorySummaryConsumableForCurrentChat()) {
            scheduleVectorIntegrityCheck();
        }
    } catch (error) {
        xbLog.error(MODULE_ID, '手动总结执行失败', error);
        postSummaryExecution(execution, { type: 'SUMMARY_ERROR', message: `总结执行失败：${formatErrorDetails(error, { includeStack: false })}` });
    } finally {
        finishSummaryExecution(execution);
        release();
        notifySummaryState();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 消息事件
// ═══════════════════════════════════════════════════════════════════════════

async function handleChatChanged(scheduledChatId = getContext()?.chatId || '') {
    if (!events) return;
    if (isChatStale(scheduledChatId)) return;
    clearDeferredBackgroundTasks();
    lastRecallLogText = "";
    postToFrame({ type: 'RECALL_LOG', text: '' });
    postToFrame({ type: 'SUMMARY_STATUS', statusText: '' });
    await waitForVectorWrites();
    if (isChatStale(scheduledChatId)) return;
    const { chat } = getContext();
    activeChatId = getContext().chatId || null;
    notifyStorySummaryChatState();

    if (!isStorySummaryEnabledForCurrentChat()) {
        await deactivateCurrentChatStorySummary();
        notifyStorySummaryChatState();
        return;
    }

    logRecallRuntimeCheckpoint("chatChanged:before-retain", `chat=${activeChatId || "-"} length=${Array.isArray(chat) ? chat.length : 0}`);
    await retainRecallRuntimeOnly(activeChatId);
    if (isChatStale(scheduledChatId)) return;
    const newLength = Array.isArray(chat) ? chat.length : 0;

    const rollback = await runVectorWriteTask(
        {
            chatId: scheduledChatId,
            kind: 'chat-change-rollback',
            scope: VECTOR_WRITE_SCOPES.CONSISTENCY,
        },
        async () => {
            if (isChatStale(scheduledChatId)) return { status: 'stale' };
            const result = await rollbackSummaryIfNeeded();
            if (result.status !== 'failed' && !isChatStale(scheduledChatId)) {
                try {
                    await reconcileVectorFloorsOnLoad(scheduledChatId, newLength);
                    const vectorCfg = getVectorConfig();
                    if (vectorCfg?.enabled) await restoreL12DurableCopy(scheduledChatId, getEngineFingerprint(vectorCfg));
                } catch (error) {
                    await clearHideState();
                    throw error;
                }
            }
            return result;
        },
    );
    if (isChatStale(scheduledChatId)) return;
    if (!rollback) return;
    if (rollback.status === 'failed') {
        await deactivateCurrentChatStorySummary();
        notifyStorySummaryChatState();
        await executeSlashCommand('/echo severity=error 剧情总结无法安全回滚，已停止使用旧总结；请导出当前总结，修正后重新导入，或清空总结数据');
        return;
    }

    const store = getSummaryStore();

    await applyHideState();

    if (panel.isReady()) {
        await sendFrameBaseData(store, newLength);
        sendFrameFullData(store, newLength);

        sendAnchorStatsToFrame();
        sendVectorStatsToFrame();
    }

    // 实体词典注入 + 索引预热
    refreshEntityLexiconAndWarmup();

    // Full lexical index rebuild on chat change
    invalidateLexicalIndex();
    scheduleLexicalWarmup(CHAT_CHANGE_LEXICAL_WARMUP_MS);

    // Embedding 连接预热（保持 TCP keep-alive，减少首次召回超时）
    warmupEmbeddingConnection();
    warmupActiveVectorCache();
    logRecallRuntimeCheckpoint("chatChanged:after-warm-request", `chat=${activeChatId || "-"}`);

    scheduleVectorIntegrityCheck();
    notifyStorySummaryChatState();
}

/**
 * 把派生数据与实际聊天长度对齐：丢弃 floor >= newLength 的 L1 chunk、L0 atom、
 * L0 索引与状态向量。纯粹由聊天长度推导，幂等。
 */
async function truncateVectorDataFromFloor(chatId, newLength) {
    if (!chatId || !(newLength >= 0)) return;
    await syncOnMessageDeleted(chatId, newLength);
    deleteStateAtomsFromFloor(newLength);
    deleteL0IndexFromFloor(newLength);
    await deleteStateVectorsFromFloor(chatId, newLength);
}

/**
 * 加载时兜底对账。删除同步现在跑在宿主等待链里，正常不会漏；这里只覆盖
 * 宿主崩溃、功能关闭期间被清空、第三方直接 emit 等遗留的越界派生数据。
 *
 * chatLength 为 0 同样要处理：ST 的四个 CHAT_CHANGED 都在 getChat()/printMessages()
 * 之后 emit，此刻长度 0 就是"聊天真的空了"，不存在"尚未载入"的中间态。
 * 先用 lastChunkFloor 与内存中的 atom 楼层做廉价判定，没有越界就不碰 DB。
 */
async function reconcileVectorFloorsOnLoad(chatId, chatLength) {
    if (!chatId || !(chatLength >= 0)) return false;
    const meta = await getMeta(chatId);
    const overflowChunks = (meta?.lastChunkFloor ?? -1) >= chatLength;
    const overflowAtoms = getStateAtoms().some((atom) => Number(atom?.floor) >= chatLength);
    // L0Index 必须单独看：status=empty/fail 的楼层没有 atom，getStateAtoms 查不出来。
    // 留着的话，以后复用同一楼层时会被 tryQueueFloor 当作已处理直接跳过。
    // chatLength 为 0 时这三条合起来就是"存在任何派生数据"，无需另开特例。
    const overflowIndex = Object.keys(getL0Index()?.byFloor || {})
        .some((key) => Number(key) >= chatLength);
    if (!overflowChunks && !overflowAtoms && !overflowIndex) return false;

    xbLog.warn(MODULE_ID, `加载对账：丢弃 floor >= ${chatLength} 的派生数据 chat=${chatId}`);
    await truncateVectorDataFromFloor(chatId, chatLength);
    return true;
}

async function handleMessageDeletedNow(scheduledChatId) {
    if (!isStorySummaryEnabledForCurrentChat()) return null;
    if (isChatStale(scheduledChatId)) return null;
    const { chat, chatId } = getContext();
    const newLength = chat?.length || 0;

    // 产品边界：只保证“删除末尾”或“从某层向后删除”的一致性。ST 编辑器中的
    // 单条中间删除会重排后续 mesId，但 MESSAGE_DELETED 只提供新长度；该低频操作不在支持范围。
    const rollback = await rollbackSummaryIfNeeded();
    invalidateLexicalIndex();
    // 回滚失败也要裁掉越界派生数据，否则 L0/L1 会一直指向已删楼层。
    await truncateVectorDataFromFloor(chatId, newLength);

    scheduleLexicalWarmup();
    return rollback;
}

async function handleMessageDeleted(scheduledChatId) {
    const rollback = await runVectorWriteTask(
        {
            chatId: scheduledChatId,
            kind: 'message-delete-sync',
            scope: VECTOR_WRITE_SCOPES.CONSISTENCY,
        },
        () => handleMessageDeletedNow(scheduledChatId),
    );
    await finishSummaryContentChange(rollback);
}

async function finishSummaryContentChange(rollback) {
    if (!rollback) return;
    // deactivate 内部会 waitForVectorWrites，必须留在写任务之外，否则自等死锁。
    if (rollback.status === 'failed') {
        await deactivateCurrentChatStorySummary();
        notifyStorySummaryChatState();
        await executeSlashCommand('/echo severity=error 剧情总结无法安全回滚，已停止使用旧总结；请导出当前总结，修正后重新导入，或清空总结数据');
        return;
    }
    // 删除或 swipe 的事件返回后，宿主就可能开始组装请求，必须等待恢复完成。
    // 即使 L2 无需回滚，原文变更也可能缩小 L1 隐藏边界。
    await applyHideState();
    notifyStorySummaryChatState();
    await sendAnchorStatsToFrame();
    await sendVectorStatsToFrame();
}

async function handleMessageSwipedNow(scheduledChatId, messageId) {
    if (!isStorySummaryEnabledForCurrentChat()) return null;
    if (isChatStale(scheduledChatId)) return null;
    const { chat, chatId } = getContext();
    if (!Number.isInteger(messageId) || messageId < 0 || messageId >= (chat?.length || 0)) return null;

    const rollback = await rollbackSummaryIfNeeded({ changedFromFloor: messageId });
    if (rollback.status === 'rolled_back') invalidateLexicalIndex();
    else removeDocumentsByFloor(messageId);

    await syncOnMessageSwiped(chatId, messageId);
    // L0 同步：清理 swipe 前该楼及之后依赖旧正文的派生数据。
    deleteStateAtomsFromFloor(messageId);
    deleteL0IndexFromFloor(messageId);
    await deleteStateVectorsFromFloor(chatId, messageId);

    scheduleLexicalWarmup();
    return rollback;
}

async function handleMessageSwiped(scheduledChatId, messageId) {
    const rollback = await runVectorWriteTask(
        {
            chatId: scheduledChatId,
            kind: 'message-swipe-sync',
            scope: VECTOR_WRITE_SCOPES.CONSISTENCY,
        },
        () => handleMessageSwipedNow(scheduledChatId, messageId),
    );
    await finishSummaryContentChange(rollback);
}

async function handleMessageReceived(scheduledChatId, targetMesId = null) {
    if (!isStorySummaryConsumableForCurrentChat()) return;
    if (isChatStale(scheduledChatId)) return;
    const { chat, chatId } = getContext();
    const lastFloor = (chat?.length || 1) - 1;
    const floor = Number.isFinite(targetMesId) ? Number(targetMesId) : lastFloor;
    if (floor < 0 || floor > lastFloor) return;
    const message = chat?.[floor];
    if (!message || message.is_user) return;
    const vectorConfig = getVectorConfig();

    applyHideStateDebounced();
    scheduleAutoSummary("after_ai");

    // Refresh entity lexicon after new message (new roles may appear)
    refreshEntityLexiconAndWarmup();

    if (vectorConfig?.enabled) {
        rememberVectorMaintenance(chatId, floor, 'after_ai');
        scheduleAutoL0Backfill(AUTO_L0_BACKFILL_DELAY_MS, chatId);
    }
}

function handleMessageSent(scheduledChatId) {
    if (isChatStale(scheduledChatId)) return;
    if (!isStorySummaryConsumableForCurrentChat()) return;
    scheduleAutoSummary("before_user");
}

/**
 * 正文被编辑。产品上将已总结楼层的编辑视为局部修正，不按 editedFloor 自动回滚 L2；
 * 若是改写剧情，由用户显式回滚总结后重新生成。rollbackSummaryIfNeeded 只处理先前已存在的长度越界。
 * 精确依赖原文的派生数据仍必须作废：
 * L0/L1 都是按旧文本算的，而等长编辑既不触发长度对账，L1 缺口不足告警阈值时
 * 完整性检查也发现不了 —— 不主动失效就会永久用着错文本的向量。
 * 失效范围只能到"受影响楼层"这个粒度：L1 靠 lastChunkFloor 单调推进，无法只补中间一层。
 */
async function handleMessageUpdated(scheduledChatId, messageId) {
    if (!isStorySummaryEnabledForCurrentChat()) return;
    if (isChatStale(scheduledChatId)) return;
    const parsedFloor = Number(messageId);
    const editedFloor = Number.isInteger(parsedFloor) && parsedFloor >= 0 ? parsedFloor : null;
    if (editedFloor === null) {
        xbLog.warn(MODULE_ID, `正文编辑事件缺少可用楼层号(${messageId})，跳过派生数据失效`);
    }
    const rollback = await runVectorWriteTask(
        {
            chatId: scheduledChatId,
            kind: 'message-update-rollback',
            scope: VECTOR_WRITE_SCOPES.CONSISTENCY,
        },
        async () => {
            if (isChatStale(scheduledChatId)) return { status: 'stale' };
            const result = await rollbackSummaryIfNeeded();
            // 回滚成功与否都要作废：旧文本的向量留着比缺失更糟。
            if (editedFloor !== null && !isChatStale(scheduledChatId)) {
                await truncateVectorDataFromFloor(scheduledChatId, editedFloor);
            }
            return result;
        },
    );
    if (isChatStale(scheduledChatId)) return;
    if (!rollback) return;
    if (rollback.status === 'failed') {
        await deactivateCurrentChatStorySummary();
        notifyStorySummaryChatState();
        await executeSlashCommand('/echo severity=error 剧情总结无法安全回滚，已停止使用旧总结；请导出当前总结，修正后重新导入，或清空总结数据');
        return;
    }
    if (editedFloor !== null) {
        invalidateLexicalIndex();
        scheduleLexicalWarmup();
        rememberVectorMaintenance(scheduledChatId, editedFloor, 'message_edited');
        scheduleAutoL0Backfill(AUTO_L0_BACKFILL_DELAY_MS, scheduledChatId);
    }
    await applyHideState();
    notifyStorySummaryChatState();
}

function clearExtensionPrompt() {
    delete extension_prompts[EXT_PROMPT_KEY];
}

// ═══════════════════════════════════════════════════════════════════════════
// Prompt 注入
// ═══════════════════════════════════════════════════════════════════════════

// 整轮硬截止：召回在宿主 generate_interceptor 的 await 内执行，必须有兜底，
// 不能把宿主发送流程无限卡住。30s 为初始护栏值，进入浏览器 E2E 后需结合
// 真实 p50/p95 与首 token 体感校准。
const STORY_SUMMARY_RECALL_DEADLINE_MS = 30000;
const RECALL_WARNING_COOLDOWN_MS = 10000;
const RECALL_REASONS_THAT_ABORT_GENERATION = new Set([
    'chat-changed',
    'disabled',
    'generation-stopped',
    'superseded',
    'unregistered',
]);

const recallReuse = createRecallReuse();

const recallPrefetch = createRecallPrefetchCoordinator({
    getContext,
    prepare: (type, signal, diagnostics) => prepareMemoryPrompt(type, signal, recallReuse, diagnostics),
    pollMs: 16,
    maxAgeMs: STORY_SUMMARY_RECALL_DEADLINE_MS,
    onJoinedCancel: (run) => {
        if (run.cancelReason === 'prefetch-timeout') return; // The interceptor reports a deadline failure.
        const publish = getContext()?.chatId === run.chatId
            && ['generation-stopped', 'generation-signal-aborted', 'dispatch-aborted', 'disabled', 'deactivated', 'summary-cleared'].includes(run.cancelReason);
        if (!publish && !xbLog.isEnabled()) return;
        const text = formatRecallDiagnostics(run.diagnostics, {
            status: 'cancelled', reason: run.cancelReason,
        });
        xbLog.info(MODULE_ID, text);
        if (publish) postToFrame({ type: 'RECALL_LOG', text });
    },
});

function cancelActiveRecall(reason = 'cancelled', options = {}) {
    return recallPrefetch.cancel(reason, {
        abortDispatch: RECALL_REASONS_THAT_ABORT_GENERATION.has(reason),
        ...options,
    });
}

function cancelRecallAndClearPrompt(reason) {
    recallReuse.invalidate();
    cancelActiveRecall(reason);
    clearExtensionPrompt();
}

// Manual destructive/import operations can yield between writes. Invalidate
// both before them and after settling, including partial failure; a concurrent
// recall must not preserve a view from halfway through the operation.
async function changeRecallData(chatId, change) {
    if (getContext()?.chatId !== chatId) return;
    cancelRecallAndClearPrompt('memory-data-changed');
    try {
        return await change();
    } finally {
        if (getContext()?.chatId === chatId) cancelRecallAndClearPrompt('memory-data-changed');
    }
}

/**
 * Publish a prepared result. The generate interceptor is the sole caller, so a
 * prefetched run can never write a Prompt or warning before it is joined.
 */
async function commitMemoryPrompt(prepared, signal) {
    const isCurrent = () => {
        const currentChatId = getContext()?.chatId;
        return !!prepared
            && !signal?.aborted
            && String(prepared.chatId || '') === String(currentChatId || '')
            && (!prepared.reuseTicket || recallReuse.isCurrent(prepared.reuseTicket, getContext()))
            && isStorySummaryConsumableForCurrentChat();
    };
    if (!isCurrent()) return;

    const { chatId } = getContext();
    if (
        prepared.notice?.message
        && claimWarningCooldown(
            'recall',
            chatId,
            prepared.notice.issueCode || 'recall_notice',
            RECALL_WARNING_COOLDOWN_MS,
        )
    ) {
        try {
            await executeSlashCommand(`/echo severity=warning ${prepared.notice.message}`);
        } catch (error) {
            xbLog.warn(MODULE_ID, '显示剧情记忆召回提示失败', error);
        }
    }

    if (!isCurrent()) return;

    const T_WritePrompt = performance.now();
    const committedPrompt = commitIfSignalActive(signal, () => {
        const hasText = !!String(prepared.text || '').trim();
        if (hasText) {
            extension_prompts[EXT_PROMPT_KEY] = {
                value: prepared.text,
                position: extension_prompt_types.IN_CHAT,
                depth: prepared.depth,
                role: prepared.role,
            };
        }
        const report = prepared.reuseMemory
            ? formatRecallReuseDiagnostics(prepared.diagnostics, prepared.reuseMemory)
            : formatRecallDiagnostics(prepared.diagnostics, { status: hasText ? 'success' : 'empty' });
        // Only adopted results may survive generation. Never store diagnostics,
        // candidates, notices or the prefetch run; reused reports keep one origin.
        if (!prepared.reuseMemory) {
            recallReuse.adopt(prepared.reuseTicket, getContext(), {
                text: prepared.text, boundary: prepared.boundary, role: prepared.role, report,
            });
        }
        postToFrame({ type: 'RECALL_LOG', text: report });
    });
    if (!committedPrompt) return;

    xbLog.info(
        MODULE_ID,
        `Prompt commit timing: write=${Math.round(performance.now() - T_WritePrompt)}ms`,
    );
    return { text: prepared.text, recallLogText: lastRecallLogText };
}

// generate_interceptor 消费者：宿主在用户消息入楼渲染后、Prompt 组装前 await。
// 旧实现曾在过早的宿主事件中靠输入框缓存猜测焦点；现在直接读取真实 chat，
// 普通发送以最后一条用户消息为焦点。
async function runStorySummaryRecallInterceptor(_interceptorChat, _contextSize, _abort, type, runContext) {
    // 旧 Prompt 只在宿主真正走到 Prompt 组装前清理；提前召回不碰它。
    clearExtensionPrompt();
    if (!isStorySummaryConsumableForCurrentChat()) {
        cancelRecallAndClearPrompt('disabled');
        return;
    }

    const { chat, chatId } = getContext();
    const normalizedType = type || 'normal';
    const lastMessage = Array.isArray(chat) ? chat.at(-1) : null;
    const focusRef = normalizedType === 'normal' && lastMessage?.is_user === true
        ? lastMessage
        : null;
    const { slot: run, path, remainingMs } = recallPrefetch.join({
        chatId,
        type: normalizedType,
        focusRef,
        runContext,
    });
    const waitStartedAt = performance.now();
    let joinStatus = 'pending';
    try {
        const outcome = await runWithAbortDeadline(
            () => run.outcome,
            {
                controller: run.controller,
                timeoutMs: remainingMs,
                timeoutMessage: 'Story Summary recall deadline exceeded',
            },
        );
        if (!outcome?.ok) throw outcome?.error || new Error('Story Summary recall produced no outcome');

        const recallResult = await commitMemoryPrompt(outcome.value, run.controller.signal);
        joinStatus = String(recallResult?.text || '').trim() ? 'committed' : 'empty';
        if (String(recallResult?.text || '').trim()) {
            return selectBestStoryMemoryResult(recallResult);
        }
        return selectBestStoryMemoryResult(recallResult, getConsumableSummaryMemoryText());
    } catch (error) {
        // 截止或失败时 fail-open。显式取消的调用方已经清理 Prompt；旧任务
        // 不能在这里清掉替代它的新任务结果。后台残余任务也受最终写入闸门保护。
        if (run.cancelReason && run.cancelReason !== 'prefetch-timeout') {
            joinStatus = `cancelled:${run.cancelReason}`;
        } else {
            joinStatus = 'failed';
            if (recallPrefetch.getCurrent() !== run || getContext()?.chatId !== run.chatId) return;
            clearExtensionPrompt();
            run.diagnostics.finishedAt ??= performance.now();
            const failureLog = formatRecallDiagnostics(run.diagnostics, { status: 'failed', error });
            postToFrame({ type: 'RECALL_LOG', text: failureLog });
            xbLog.warn(MODULE_ID,
                `召回失败或达到 ${STORY_SUMMARY_RECALL_DEADLINE_MS}ms 硬截止，本轮跳过记忆注入`,
                error
            );
            const timedOut = run.cancelReason === 'prefetch-timeout' || run.controller.signal.aborted;
            const embeddingFailed = error?.code === 'RECALL_EMBEDDING_FAILED'
                || error?.code === 'RECALL_EMBEDDING_INVALID_RESPONSE';
            const issueCode = timedOut
                ? 'recall_timeout'
                : (embeddingFailed ? 'recall_embedding_failed' : 'recall_failed');
            const notice = timedOut
                ? '剧情记忆召回超过 30 秒，本轮已跳过。请检查嵌入 API、重排 API、网络和向量设置后重试。'
                : (embeddingFailed
                    ? '剧情记忆嵌入请求失败，本轮已跳过。请检查嵌入 API、网络和向量设置后重试。'
                    : '剧情记忆召回失败，本轮已跳过。请检查嵌入 API、重排 API、网络和向量设置后重试。');
            const { chatId } = getContext();
            if (claimWarningCooldown('recall', chatId, issueCode, RECALL_WARNING_COOLDOWN_MS)) {
                try {
                    await executeSlashCommand(`/echo severity=warning ${notice}`);
                } catch (noticeError) {
                    xbLog.warn(MODULE_ID, '显示剧情记忆召回失败提示失败', noticeError);
                }
            }
        }
        if (!runContext?.signal?.aborted) {
            return selectBestStoryMemoryResult(undefined, getConsumableSummaryMemoryText());
        }
    } finally {
        xbLog.info(
            MODULE_ID,
            `Recall join: path=${path} status=${joinStatus} `
            + `lead=${Math.max(0, Math.round((run.joinedAt || 0) - (run.computeStartedAt || run.joinedAt || 0)))}ms `
            + `wait=${Math.round(performance.now() - waitStartedAt)}ms`,
        );
        recallPrefetch.finish(run);
    }
}

function handleGenerationAfterCommands(type, params, isDryRun) {
    // Prompt Manager 的 dry-run 只组装预览，不能作废正在进行的真实生成。
    const action = getRecallPrefetchStartAction(type, params, isDryRun);
    if (action === 'ignore') return;

    // 新 Generate 只作废旧计算，不碰上一轮 Prompt；Prompt 的唯一清理点
    // 仍是上面的 generate interceptor。
    cancelActiveRecall('superseded');

    const normalizedType = type || 'normal';
    if (action !== 'watch') return;
    if (!isStorySummaryConsumableForCurrentChat() || !getVectorConfig()?.enabled) return;

    const { chatId, chat } = getContext();
    if (!chatId || !Array.isArray(chat)) return;
    recallPrefetch.startWatching({
        chatId,
        type: normalizedType,
        initialLength: chat.length,
        signal: params?.signal || null,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// 事件注册
// ═══════════════════════════════════════════════════════════════════════════

function scheduleWithChatGuard(fn, delay = 0, ...args) {
    const scheduledChatId = getContext().chatId;
    setTimeout(() => fn(scheduledChatId, ...args), delay);
}

/**
 * 正文变更事件（删除 / swipe / 编辑）：把一致性任务的 Promise 直接交回宿主。
 *
 * SillyTavern 用 `await eventSource.emit(...)` 派发这些事件，EventCenter 也会
 * 原样返回 handler 的返回值，所以宿主会等我们同步完再往下走 —— 聊天切换不可能
 * 插进来，任务内的 isChatStale 也就不会再静默跳过。原来的 setTimeout 主动脱离了
 * 这条等待链，才需要事后补偿。
 *
 * 先取消在飞的 embedding：正文已经变了，它正在处理的是失效文本；顺带避免宿主
 * 卡在长 embedding 队列后面。被取消的延迟维护由 retryVectorMaintenanceAfterCancel
 * 重排，不会丢活。
 */
function runContentChangeSync(handler, ...args) {
    const chatId = getContext()?.chatId || null;
    if (!chatId || !isStorySummaryEnabledForCurrentChat()) return undefined;
    if (handler === handleMessageUpdated) {
        cancelRecallAndClearPrompt('message-edited');
    } else {
        recallReuse.historyChanged(getContext(), handler === handleMessageSwiped ? Number(args[0]) : null);
        if (!recallReuse.getStats().count) {
            cancelActiveRecall('history-changed');
            clearExtensionPrompt();
        }
    }
    cancelPendingHide();
    cancelEmbeddingWriteTasks('Chat content changed');
    return handler(chatId, ...args).catch(async (error) => {
        // 派生数据同步失败时边界不可信。所有正文变更统一恢复原文，
        // 且异步失败绝不能落到已经切换的新聊天上。
        if (!isChatStale(chatId)) await clearHideState();
        xbLog.error(MODULE_ID, "正文变更同步失败", error);
    });
}

function isChatStale(scheduledChatId) {
    if (!scheduledChatId || scheduledChatId !== activeChatId) return true;
    const { chatId } = getContext();
    return chatId !== scheduledChatId;
}

function notifyStorySummaryAfterAi(data, source) {
    if (!isStorySummaryEnabledForCurrentChat()) return;
    const { chatId, chat } = getContext();
    if (!chatId || !Array.isArray(chat) || !chat.length) return;

    const messageId = source === "generation_ended"
        ? (chat.length - 1)
        : (typeof data === "number" ? data : data?.messageId ?? data?.mesId ?? (chat.length - 1));
    if (!Number.isFinite(messageId) || messageId < 0) return;

    const message = chat[messageId];
    if (!message || message.is_user) return;

    notifyAfterAiHint({
        chatId,
        messageId,
        source,
        kind: MODULE_ID,
    });
}

function registerAfterAiGateHandler() {
    initAfterAiGate();
    if (afterAiGateDispose) return;
    afterAiGateDispose = registerAfterAiHandler(MODULE_ID, async ({ chatId, messageId }) => {
        if (!isStorySummaryEnabledForCurrentChat()) return;
        if (activeChatId !== chatId) return;
        scheduleWithChatGuard(handleMessageReceived, 0, messageId);
    });
}

/**
 * 进行中的卸载。register 必须等它彻底结束：否则快速关开时
 * resumeVectorWriteCoordinator 会先放开写入，随后旧 teardown 的
 * shutdownRecallRuntime 又把新会话刚建立的 Runtime 关掉。
 */
let storySummaryTeardown = null;

async function registerEvents() {
    if (storySummaryTeardown) await storySummaryTeardown;
    if (events) return;
    resumeVectorWriteCoordinator();
    events = createModuleEvents(MODULE_ID);
    activeChatId = getContext().chatId || null;
    registerAfterAiGateHandler();

    CacheRegistry.register(MODULE_ID, {
        name: "剧情总结运行缓存",
        getSize: () => {
            const vectorStats = getRecallRuntimeStats();
            const vectorItems = vectorStats.reduce((sum, item) => (
                sum
                + Number(item.chunks || 0)
                + Number(item.chunkVectors || 0)
                + Number(item.eventVectors || 0)
                + Number(item.stateVectors || 0)
            ), 0);
            return panel.getPendingMessages().length + vectorItems + recallReuse.getStats().count;
        },
        getBytes: () => {
            try {
                return JSON.stringify({
                    pendingFrameMessages: panel.getPendingMessages(),
                    lastRecallLogText,
                    recallRuntime: getRecallRuntimeStats(),
                }).length * 2 + recallReuse.getStats().bytes;
            } catch {
                return 0;
            }
        },
        getDetail: () => ({
            activeChatId,
            pendingFrameMessages: panel.getPendingMessages().length,
            hasRecallLog: Boolean(lastRecallLogText),
            recallReuse: recallReuse.getStats(),
            recallRuntime: getRecallRuntimeStats(),
        }),
        clear: () => {
            cancelRecallAndClearPrompt('cache-cleared');
            panel.clearPendingMessages();
            lastRecallLogText = "";
            invalidateLexicalIndex();
            clearRecallRuntime().catch(() => {});
        },
    });

    events.on(event_types.CHAT_CHANGED, () => {
        cancelRecallAndClearPrompt('chat-changed');
        cancelActiveSummaryExecution();
        activeSummaryExecution = null;
        cancelEmbeddingWriteTasks('Chat changed');
        cancelPendingHide();
        activeChatId = getContext().chatId || null;
        scheduleWithChatGuard(handleChatChanged, 80);
    });
    events.on(event_types.MESSAGE_DELETED, () => runContentChangeSync(handleMessageDeleted));
    events.on(event_types.MESSAGE_RECEIVED, (data) => notifyStorySummaryAfterAi(data, "message_received"));
    events.on(event_types.MESSAGE_SENT, () => scheduleWithChatGuard(handleMessageSent, 150));
    events.on(event_types.MESSAGE_SWIPED, (messageId) => runContentChangeSync(handleMessageSwiped, messageId));
    // 只绑 MESSAGE_EDITED。宿主真实编辑（script.js messageEditDone、/messageupdate 等）
    // 一定先发 MESSAGE_EDITED 再发 MESSAGE_UPDATED；而"打开编辑器又取消"只发 MESSAGE_UPDATED
    // （script.js closeMessageEditor）。绑 MESSAGE_UPDATED 会让取消编辑也裁掉后续 L0/L1。
    events.on(event_types.MESSAGE_EDITED, (messageId) => runContentChangeSync(handleMessageUpdated, messageId));
    events.on(event_types.CHARACTER_MESSAGE_RENDERED, (data) => {
        notifyStorySummaryAfterAi(data, "character_message_rendered");
    });

    // 用户输入捕获已删除：普通发送的焦点直接来自已入楼的用户消息
    document.addEventListener("visibilitychange", handleVisibilityChangeForBackground);
    window.addEventListener("resize", handleViewportChangeForBackground, { passive: true });
    window.visualViewport?.addEventListener?.("resize", handleViewportChangeForBackground, { passive: true });
    window.visualViewport?.addEventListener?.("scroll", handleViewportChangeForBackground, { passive: true });

    // 普通发送在命令处理后开始等待真实 USER 对象入 chat；监听器同步返回，
    // 不阻塞宿主后续 push / save / render。
    events.on(event_types.GENERATION_AFTER_COMMANDS, handleGenerationAfterCommands);

    // 注入链路：interceptor 时点不变，只等待提前召回的剩余时间并提交 Prompt。
    registerGenerateInterceptor(
        'story-summary',
        runStorySummaryRecallInterceptor,
        GENERATE_INTERCEPTOR_ORDER.STORY_SUMMARY,
    );
    events.on(event_types.GENERATION_STOPPED, () => {
        const { chatId } = getContext();
        cancelActiveRecall('generation-stopped', {
            retainForJoin: true,
            chatId,
            // STOPPED 不携带生成类型；空槽用 null 表示仅匹配本聊天的下一次认领。
            type: null,
        });
        clearExtensionPrompt();
    });
    events.on(event_types.GENERATION_ENDED, (data) => {
        notifyStorySummaryAfterAi(data, "generation_ended");
        // stopGeneration() 会先触发 ENDED、再触发 STOPPED。这里不能销毁
        // 本轮身份，否则保存完成后到达的 interceptor 会重新 fallback 召回。
        clearExtensionPrompt();
    });

    // 聊天删除时清理对应的服务器向量备份
    events.on(event_types.CHAT_DELETED, handleChatDeleted);
    events.on(event_types.GROUP_CHAT_DELETED, handleChatDeleted);
}

async function unregisterEvents() {
    if (storySummaryTeardown) return storySummaryTeardown;
    storySummaryTeardown = runStorySummaryTeardown();
    try {
        await storySummaryTeardown;
    } finally {
        storySummaryTeardown = null;
    }
}

async function runStorySummaryTeardown() {
    // The master switch invokes this cleanup directly (without awaiting it).
    // Restore flags synchronously, before waiting for any background writer.
    const hideCleanup = clearHideState();
    cancelActiveSummaryExecution();
    activeSummaryExecution = null;
    cancelRecallAndClearPrompt('unregistered');
    postToFrame({ type: 'RECALL_LOG', text: '' });
    postToFrame({ type: 'SUMMARY_STATUS', statusText: '' });
    invalidateLexicalIndex();
    const writerShutdown = shutdownVectorWriteCoordinator('Story Summary unregistered');
    clearWarningCooldowns();
    if (events) {
        CacheRegistry.unregister(MODULE_ID);
        events.cleanup();
        events = null;
        afterAiGateDispose?.();
        afterAiGateDispose = null;
        activeChatId = null;
        cancelPendingHide();
        clearDeferredBackgroundTasks();

        panel.hide();

        unregisterGenerateInterceptor('story-summary');

        document.removeEventListener("visibilitychange", handleVisibilityChangeForBackground);
        window.removeEventListener("resize", handleViewportChangeForBackground);
        window.visualViewport?.removeEventListener?.("resize", handleViewportChangeForBackground);
        window.visualViewport?.removeEventListener?.("scroll", handleViewportChangeForBackground);
    }

    await Promise.all([writerShutdown, hideCleanup]);
    await flushL12DurableCopy();
    clearDeferredBackgroundTasks();
    logRecallRuntimeCheckpoint("unregisterEvents:shutdown-runtime");
    try {
        await shutdownRecallRuntime();
    } catch (error) {
        xbLog.warn(MODULE_ID, '召回运行时关闭失败', error);
    }
    notifyStorySummaryChatState();
}

async function deactivateCurrentChatStorySummary() {
    const hideCleanup = clearHideState();
    clearDeferredBackgroundTasks();
    cancelPendingHide();
    cancelRecallAndClearPrompt('deactivated');
    cancelEmbeddingWriteTasks('Story Summary deactivated for current chat');
    lastRecallLogText = "";

    const targetChatId = activeChatId || getContext()?.chatId || '';
    invalidateLexicalIndex();
    await Promise.all([waitForVectorWrites(), hideCleanup]);
    await flushL12DurableCopy(targetChatId);
    clearDeferredBackgroundTasks();
    if (targetChatId) await clearRecallRuntime(targetChatId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 聊天删除时自动清理服务器向量备份
// ═══════════════════════════════════════════════════════════════════════════

async function handleChatDeleted(chatId) {
    logRecallRuntimeCheckpoint("chatDeleted:clear-runtime", `chat=${chatId || "-"}`);
    clearWarningCooldownsForChat(chatId);
    await clearRecallRuntime(chatId);
    try {
        const filename = getBackupFilename(chatId);
        await deleteServerBackup(filename, null);
        xbLog.info(MODULE_ID, `聊天删除，已清理服务器备份: ${filename}`);
    } catch (_) {
        // 文件不存在或宿主不支持删除，静默处理
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Toggle 监听
// ═══════════════════════════════════════════════════════════════════════════

$(document).on("littlewhitememory:storySummary:toggle", async (_e, enabled) => {
    if (enabled) {
        await registerEvents();
        await handleChatChanged();
    } else {
        cancelActiveSummaryExecution();
        cancelRecallAndClearPrompt('disabled');
        await unregisterEvents();
    }
    notifyStorySummaryChatState();
});

// ═══════════════════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════════════════

export async function initStorySummary() {
    await loadConfigFromServer();
    try {
        await registerEvents();
        initStateIntegration();
        maybePreloadTokenizer();
        await handleChatChanged();
    } catch (error) {
        await unregisterEvents();
        throw error;
    }
}
