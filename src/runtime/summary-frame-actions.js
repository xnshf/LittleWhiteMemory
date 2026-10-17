import { getContext } from '../../../../../extensions.js';
import { xbLog } from '../support/debug-core.js';
import { formatErrorDetails } from '../support/error-details.js';
import {
    getSummaryStore,
    saveSummaryStore,
    saveSummaryStoreImmediately,
    rollbackSummaryOnce,
    clearSummaryData,
    getRollbackOnceTargetEndMesId,
} from '../summary/data/store.js';
import { replaceCharacterAliases } from '../summary/data/character-aliases.js';
import { stampEditedCharacters } from '../summary/data/character-edits.js';
import { projectEditedSummaryEvents } from '../summary/data/events.js';
import { mergeCharacterRelationshipsIntoFacts, mergeEditedFactsWithTimestamps } from '../summary/data/fact-edits.js';
import {
    extractSummaryImportJson,
    buildSummaryExportPackage,
    applyImportedSummaryBoundary,
} from '../summary/data/summary-memory-package.js';
import { updateMeta, clearEventVectors, clearAllChunks } from '../vector/storage/chunk-store.js';
import { clearAllAtomsAndVectors } from '../vector/pipeline/state-integration.js';
import { clearStateVectors } from '../vector/storage/state-store.js';
import { captureFrozenChatIdentity, assertChatTargetUnchanged } from '../vector/storage/chat-target.js';
import { VECTOR_WRITE_SCOPES, runVectorWriteTask } from '../vector/runtime/maintenance-coordinator.js';
import { invalidateLexicalIndex } from '../vector/retrieval/lexical-index.js';

const MODULE_ID = 'storySummary';
const VALID_SECTIONS = ['keywords', 'events', 'characters', 'arcs', 'facts'];

async function copyTextToClipboard(text) {
    const value = String(text ?? "");
    if (!value) {
        throw new Error("没有可复制的内容");
    }

    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
    }

    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand?.("copy");
    ta.remove();
    if (!ok) {
        throw new Error("浏览器不支持自动复制");
    }
}

function getCurrentFloorHint() {
    const { chat } = getContext();
    const lastFloor = (Array.isArray(chat) ? chat.length : 0) - 1;
    return Math.max(0, lastFloor);
}

// The entry owns trusted-message routing and whether each action is awaited.
export function createSummaryFrameActions({
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
}) {
    const { sendAnchorStatsToFrame, sendVectorStatsToFrame } = panelStats;
    const { cancelPendingEventEditSync, syncEventVectorsOnEdit } = eventVectorSync;
    const { refreshEntityLexiconAndWarmup, scheduleLexicalWarmup } = maintenance;

    async function importSummaryMemoryPackage(rawText, targetChatId = '') {
        if (!String(rawText || "").trim()) {
            throw new Error("记忆包内容为空");
        }
        let parsed;
        try {
            parsed = JSON.parse(String(rawText));
        } catch {
            throw new Error("JSON 解析失败");
        }

        const importedJson = extractSummaryImportJson(parsed);
        const { chatId, chat } = getContext();
        if (!chatId || (targetChatId && chatId !== targetChatId)) {
            throw new Error("当前没有打开聊天");
        }
        const target = captureFrozenChatIdentity(chatId);
        const assertImportActive = async () => {
            await assertChatTargetUnchanged(target, 'summary import');
        };

        const store = getSummaryStore();
        if (!store) {
            throw new Error("无法读取当前聊天的总结存储");
        }
        const previousStore = structuredClone(store);

        await assertImportActive();
        await updateMeta(chatId, { lastChunkFloor: -1, fingerprint: null });
        await assertImportActive();
        await clearAllAtomsAndVectors(chatId);
        await assertImportActive();
        await clearAllChunks(chatId);
        await assertImportActive();
        await clearEventVectors(chatId);
        await assertImportActive();
        await clearStateVectors(chatId);
        await assertImportActive();

        invalidateLexicalIndex();

        store.json = importedJson;
        delete store.summaryInvalid;
        const importBoundary = (Array.isArray(chat) ? chat.length : 0) - 1;
        if (importBoundary >= 0) {
            applyImportedSummaryBoundary(store, importBoundary);
        } else {
            store.lastSummarizedMesId = -1;
            store.summaryHistory = [];
            store.pendingImportBoundary = true;
        }
        store.updatedAt = Date.now();
        let importCommitted = false;
        try {
            await saveSummaryStoreImmediately(chatId);
            importCommitted = true;
            await assertImportActive();
        } catch (error) {
            if (!importCommitted) {
                for (const key of Object.keys(store)) delete store[key];
                Object.assign(store, previousStore);
            }
            throw error;
        }

        refreshEntityLexiconAndWarmup();
        scheduleLexicalWarmup();

        await clearHideState();
        await assertImportActive();
        const totalFloors = Array.isArray(chat) ? chat.length : 0;
        await sendFrameBaseData(store, totalFloors);
        sendFrameFullData(store, totalFloors);
        await sendAnchorStatsToFrame();
        await sendVectorStatsToFrame();

        return {
            counts: {
                keywords: importedJson.keywords.length,
                events: importedJson.events.length,
                characters: importedJson.characters.main.length,
                arcs: importedJson.arcs.length,
                facts: importedJson.facts.length,
            },
        };
    }

    async function handleSummaryCopy() {
        try {
            const store = getSummaryStore();
            const payload = buildSummaryExportPackage(store);
            await copyTextToClipboard(JSON.stringify(payload, null, 2));
            postToFrame({
                type: "SUMMARY_COPY_RESULT",
                success: true,
                events: payload.counts.events,
                facts: payload.counts.facts,
            });
        } catch (e) {
            postToFrame({ type: "SUMMARY_COPY_RESULT", success: false, error: e.message });
        }
    }

    async function handleSummaryImportText(text) {
        if (guard.isAnyRunning('summary', 'vector', 'anchor')) {
            postToFrame({ type: "SUMMARY_IMPORT_RESULT", success: false, error: "请等待当前总结/向量任务结束" });
            return;
        }
        try {
            const targetChatId = getContext()?.chatId || '';
            const result = await runVectorWriteTask(
                {
                    chatId: targetChatId,
                    kind: 'summary-import',
                    scope: VECTOR_WRITE_SCOPES.IO,
                },
                async () => {
                    if (getContext()?.chatId !== targetChatId) {
                        throw new Error('聊天已切换，已取消导入');
                    }
                    return changeRecallData(targetChatId, () => importSummaryMemoryPackage(text || "", targetChatId));
                },
            );
            if (!result) {
                postToFrame({ type: "SUMMARY_IMPORT_RESULT", success: false, error: "导入已取消" });
                return;
            }
            notifyStorySummaryChatState();
            postToFrame({
                type: "SUMMARY_IMPORT_RESULT",
                success: true,
                counts: result.counts,
            });
        } catch (e) {
            postToFrame({ type: "SUMMARY_IMPORT_RESULT", success: false, error: e.message });
        }
    }

    async function handleSummaryClear() {
        if (guard.isAnyRunning('summary', 'vector', 'anchor')) {
            await executeSlashCommand("/echo severity=warning 当前有任务运行中，暂时不能清理总结数据");
            return;
        }
        const { chat, chatId } = getContext();
        cancelPendingEventEditSync();
        cancelRecallAndClearPrompt('summary-cleared');
        let cleared;
        try {
            cleared = await runVectorWriteTask(
                { chatId, kind: 'summary-clear', scope: VECTOR_WRITE_SCOPES.IO },
                () => changeRecallData(chatId, async () => {
                    if (getContext()?.chatId !== chatId) return false;
                    await clearSummaryData(chatId);
                    return true;
                }),
            );
        } catch (error) {
            xbLog.error(MODULE_ID, '清空总结失败', error);
            await executeSlashCommand('/echo severity=error 清空总结失败，原总结已保留；请查看日志后重试');
            return;
        }
        if (!cleared) return;
        if (getContext()?.chatId !== chatId) return;
        postToFrame({ type: 'RECALL_LOG', text: '' });
        postToFrame({ type: 'SUMMARY_STATUS', statusText: '总结数据已清空' });
        invalidateLexicalIndex();
        await clearHideState();
        const totalFloors = Array.isArray(chat) ? chat.length : 0;
        const store = getSummaryStore();
        await sendFrameBaseData(store, totalFloors);
        sendFrameFullData(store, totalFloors);
        notifyStorySummaryChatState();
        await executeSlashCommand("/echo severity=info 剧情总结数据已清空");
    }

    async function handleSummaryRollbackOnce() {
        if (guard.isAnyRunning('summary', 'vector', 'anchor')) {
            await executeSlashCommand("/echo severity=warning 当前有任务运行中，暂时不能回退总结");
            return;
        }

        const { chat, chatId } = getContext();
        if (!chatId) return;

        const currentStore = getSummaryStore();
        const rollbackTargetEndMesId = getRollbackOnceTargetEndMesId(currentStore);
        if (rollbackTargetEndMesId == null) {
            await executeSlashCommand("/echo severity=info 当前没有可回退的总结快照");
            return;
        }

        cancelRecallAndClearPrompt('summary-rollback');
        cancelPendingEventEditSync();
        const result = await runVectorWriteTask(
            { chatId, kind: 'summary-rollback', scope: VECTOR_WRITE_SCOPES.CONSISTENCY },
            () => changeRecallData(chatId, async () => {
                if (getContext()?.chatId !== chatId) return null;
                return rollbackSummaryOnce(chatId);
            }),
        );
        if (!result) return;
        if (result.success) {
            invalidateLexicalIndex();
            if (getHideUiSettings().hideSummarized) {
                if (result.clearedBoundary) {
                    await clearHideState();
                } else {
                    await applyHideState();
                }
            }
        }
        const totalFloors = Array.isArray(chat) ? chat.length : 0;
        const nextStore = getSummaryStore();
        await sendFrameBaseData(nextStore, totalFloors);
        sendFrameFullData(nextStore, totalFloors);
        notifyStorySummaryChatState();

        if (!result.success) {
            await executeSlashCommand("/echo severity=error 回退总结失败，原总结已保留；请查看日志后重试");
            return;
        }

        if (result.clearedBoundary) {
            const message = result.clearedAll
                ? "已回退首次总结，当前总结数据已清空"
                : "已回退首次总结；未被本次总结修改的内容已保留";
            await executeSlashCommand(`/echo severity=info ${message}`);
        } else {
            await executeSlashCommand(`/echo severity=info 已回退上一次总结，已总结楼层退回到 ${result.targetEndMesId + 1} 楼`);
        }
    }

    function handleUpdateSection(data) {
        const store = getSummaryStore();
        if (!store || !VALID_SECTIONS.includes(data.section)) return;
        cancelRecallAndClearPrompt('summary-edited');
        store.json ||= {};

        // 如果是 events，先记录旧数据用于同步向量
        const oldEvents = data.section === "events" ? [...(store.json.events || [])] : null;
        const oldFacts = data.section === "facts" ? [...(store.json.facts || [])] : null;

        store.json[data.section] = data.section === "characters"
            ? stampEditedCharacters(store.json.characters, data.data, getCurrentFloorHint())
            : data.section === "events" ? projectEditedSummaryEvents(data.data) : data.data;
        if (data.section === "facts") {
            store.json.facts = mergeEditedFactsWithTimestamps(oldFacts, data.data, getCurrentFloorHint());
        }
        if (data.section === "characters") {
            const rels = data?.data?.relationships || [];
            const floorHint = getCurrentFloorHint();
            store.json.facts = mergeCharacterRelationshipsIntoFacts(store.json.facts, rels, floorHint);
        }
        store.updatedAt = Date.now();
        saveSummaryStore();

        // 同步 L2 检索索引（事件新增、编辑、删除）
        if (data.section === "events" && oldEvents) {
            syncEventVectorsOnEdit(oldEvents, store.json.events);
        }
    }

    function handleUpdateCharacterAliases(data) {
        const store = getSummaryStore();
        if (!store || !Array.isArray(data.aliases)) return;
        cancelRecallAndClearPrompt('character-aliases-edited');
        store.json ||= {};

        let result;
        try {
            result = replaceCharacterAliases(store.json, data.aliases, getCurrentFloorHint());
        } catch (error) {
            postToFrame({
                type: 'SUMMARY_ERROR',
                message: `别名映射未保存：${formatErrorDetails(error, { includeStack: false })}`,
            });
            return;
        }

        if (!result.aliasChanged) return;
        store.updatedAt = Date.now();
        saveSummaryStore();

        // Alias mappings affect terminology and event ownership through
        // the shared vocabulary. Existing event bodies stay untouched.
        refreshEntityLexiconAndWarmup();
        postToFrame({ type: 'SUMMARY_FULL_DATA', payload: buildFramePayload(store) });
    }

    return {
        handleSummaryCopy,
        handleSummaryImportText,
        handleSummaryClear,
        handleSummaryRollbackOnce,
        handleUpdateSection,
        handleUpdateCharacterAliases,
    };
}
