// Story Summary - Store
// L2 (events/characters/arcs) + L3 (facts) 统一存储

import { getContext, saveMetadataDebounced } from "../../../../../../extensions.js";
import { chat_metadata } from "../../../../../../../script.js";
import { EXT_ID } from "../../support/constants.js";
import { xbLog } from "../../support/debug-core.js";
import { clearEventVectors, deleteEventVectorsByIds } from "../../vector/storage/chunk-store.js";
import { normalizeCharacterAliases } from "./character-aliases.js";
import { applyExactSummaryHistoryUndo, normalizeSummaryUndo } from "./summary-undo.js";
import { isPlainObject, normalizeSummaryStore } from "./summary-normalize.js";
import { isRelationFact, parseRelationTarget } from "./fact-predicates.js";
import { upgradeStoredEventMemoryRoles } from "./migrations/event-memory-role.js";

export { migrateToFacts } from "./summary-normalize.js";
export { mergeFacts, mergeNewData } from "./summary-merge.js";

const MODULE_ID = 'summaryStore';
const loadedEventStores = new WeakSet();

// ═══════════════════════════════════════════════════════════════════════════
// 基础存取
// ═══════════════════════════════════════════════════════════════════════════

export function getSummaryStore() {
    const { chatId } = getContext();
    if (!chatId) return null;
    chat_metadata.extensions ||= {};
    chat_metadata.extensions[EXT_ID] ||= {};
    chat_metadata.extensions[EXT_ID].storySummary ||= {};

    const store = chat_metadata.extensions[EXT_ID].storySummary;
    let changed = normalizeSummaryStore(store);
    if (!loadedEventStores.has(store)) {
        changed = upgradeStoredEventMemoryRoles(store) || changed;
        loadedEventStores.add(store);
    }

    // One-time migration: v3.0.4 and earlier persisted this derived Ena cache.
    // Canonical story-summary data is now the only source, so the old cache is discarded.
    if (Object.hasOwn(chat_metadata, 'ena_cached_story_summary')) {
        delete chat_metadata.ena_cached_story_summary;
        changed = true;
    }

    if (changed) {
        store.updatedAt = Date.now();
        saveSummaryStore();
        xbLog.info(MODULE_ID, '已自动修正总结存储中的旧结构或异常字段');
    }

    return store;
}

export function saveSummaryStore() {
    saveMetadataDebounced?.();
}

export async function saveSummaryStoreImmediately(
    expectedChatId,
) {
    const context = getContext();
    if (!context?.chatId || context.chatId !== expectedChatId) {
        throw new Error('summary_chat_changed_before_save');
    }
    if (typeof context.saveMetadata !== 'function') {
        throw new Error('summary_metadata_save_unavailable');
    }

    await context.saveMetadata();
}

export function addSummarySnapshot(store, previousEndMesId, endMesId, undo = null) {
    store.summaryHistory ||= [];
    const normalizedUndo = normalizeSummaryUndo(undo);
    store.summaryHistory.push(normalizedUndo
        ? { format: 1, previousEndMesId, endMesId, undo: normalizedUndo }
        : { endMesId });
}

export function getRollbackOnceTargetEndMesId(store) {
    const currentEndMesId = Number(store?.lastSummarizedMesId);
    if (!Number.isFinite(currentEndMesId) || currentEndMesId < 0) {
        return null;
    }

    const history = Array.isArray(store?.summaryHistory) ? store.summaryHistory : [];
    for (let i = history.length - 1; i >= 0; i--) {
        const candidate = Number(history[i]?.endMesId);
        if (!Number.isFinite(candidate)) continue;
        if (candidate < currentEndMesId) {
            return Math.trunc(candidate);
        }
    }

    return -1;
}

export function isSummaryRollbackRequired(store, currentLength) {
    const lastSummarized = Number(store?.lastSummarizedMesId);
    if (!Number.isInteger(lastSummarized) || lastSummarized < 0) return false;
    const length = Math.max(0, Math.trunc(Number(currentLength) || 0));
    return length <= lastSummarized && lastSummarized + 1 - length >= 1;
}

export function isSummaryConsumable(store, currentLength) {
    return store?.summaryInvalid !== true && !isSummaryRollbackRequired(store, currentLength);
}

// ═══════════════════════════════════════════════════════════════════════════
// 从 facts 提取关系（供关系图 UI 使用）
// ═══════════════════════════════════════════════════════════════════════════

export function extractRelationshipsFromFacts(facts) {
    return (facts || [])
        .filter(f => !f.retracted && isRelationFact(f))
        .map(f => {
            const to = parseRelationTarget(f.p);
            if (!to) return null;
            return {
                from: f.s,
                to,
                label: f.o,
                trend: f.trend || '陌生',
            };
        })
        .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// 回滚
// ═══════════════════════════════════════════════════════════════════════════

// 删除时有效原文前缀由聊天长度决定；swipe 则从被替换楼层起失效。
export async function rollbackSummaryIfNeeded({ changedFromFloor = null } = {}) {
    const { chat, chatId } = getContext();
    const currentLength = Array.isArray(chat) ? chat.length : 0;
    const validPrefixLength = Number.isInteger(changedFromFloor) && changedFromFloor >= 0
        ? Math.min(currentLength, changedFromFloor)
        : currentLength;
    const store = getSummaryStore();

    if (!store || store.lastSummarizedMesId == null || store.lastSummarizedMesId < 0) {
        return { status: 'not_needed' };
    }

    const lastSummarized = store.lastSummarizedMesId;

    if (isSummaryRollbackRequired(store, validPrefixLength)) {
        xbLog.warn(MODULE_ID, `原文变更影响已总结范围 ${validPrefixLength}-${lastSummarized}，触发回滚`);

        const history = store.summaryHistory || [];
        let targetEndMesId = -1;

        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].endMesId < validPrefixLength) {
                targetEndMesId = history[i].endMesId;
                break;
            }
        }

        let rollback;
        try {
            rollback = await executeRollback(chatId, store, targetEndMesId);
        } catch (error) {
            xbLog.error(MODULE_ID, '总结回滚发生未处理异常', error);
            rollback = { status: 'failed', reason: 'rollback_exception', targetEndMesId };
        }

        if (rollback.status === 'failed') {
            store.summaryInvalid = true;
            store.updatedAt = Date.now();
            try {
                await saveSummaryStoreImmediately(chatId);
            } catch (error) {
                xbLog.error(MODULE_ID, '总结完整性状态未能持久化', error);
            }
        }
        return rollback;
    }

    if (store.summaryInvalid === true) {
        return { status: 'failed', reason: 'summary_invalid', targetEndMesId: null };
    }
    return { status: 'not_needed' };
}

function hasSummaryContent(json) {
    if (!json) return false;
    const hasKnownContent = (
        (json.keywords || []).length > 0
        || (json.events || []).length > 0
        || (json.characters?.main || []).length > 0
        || (json.arcs || []).length > 0
        || (json.facts || []).length > 0
        || (json.characterAliases || []).length > 0
    );
    if (hasKnownContent) return true;

    const knownFields = new Set(['keywords', 'events', 'characters', 'arcs', 'facts', 'characterAliases']);
    if (Object.keys(json).some(field => !knownFields.has(field))) return true;
    return isPlainObject(json.characters)
        && Object.keys(json.characters).some(field => field !== 'main');
}

export async function executeRollback(chatId, store, targetEndMesId) {
    const previousStore = structuredClone(store);
    const oldEvents = store.json?.events || [];

    let json = store.json || {};
    const exactRollback = applyExactSummaryHistoryUndo(
        json,
        store.summaryHistory,
        targetEndMesId,
        store.lastSummarizedMesId,
    );
    if (exactRollback.historyDiscontinuous) {
        xbLog.error(MODULE_ID, `总结历史链不连续，拒绝回滚: ${store.lastSummarizedMesId} -> ${targetEndMesId}`);
        return { status: 'failed', reason: 'history_discontinuous', targetEndMesId };
    }
    json = exactRollback.json;
    if (exactRollback.crossedLegacyHistory) {
        // 升级前的历史没有逆操作，只能保持旧版 best-effort 回滚语义。
        json.events = (json.events || []).filter(e => (e._addedAt ?? 0) <= targetEndMesId);
        json.keywords = (json.keywords || []).filter(k => (k._addedAt ?? 0) <= targetEndMesId);
        json.arcs = (json.arcs || []).filter(a => (a._addedAt ?? 0) <= targetEndMesId);
        json.arcs.forEach(a => {
            a.moments = (a.moments || []).filter(m =>
                typeof m === 'string' || (m._addedAt ?? 0) <= targetEndMesId
            );
        });

        if (json.characters) {
            json.characters.main = (json.characters.main || []).filter(m =>
                typeof m === 'string' || (m._addedAt ?? 0) <= targetEndMesId
            );
        }
        json.facts = (json.facts || []).filter(f => (f._addedAt ?? 0) <= targetEndMesId);
        if (targetEndMesId < 0) {
            // A legacy content rollback can reach an empty story, while its
            // identity vocabulary remains useful for every later summary.
            const aliases = normalizeCharacterAliases(json.characterAliases);
            json = aliases.length ? { characterAliases: aliases } : {};
        }
    }

    const retainedEventIds = new Set((json.events || []).map(event => event?.id).filter(Boolean));
    const deletedEventIds = oldEvents
        .map(event => event?.id)
        .filter(id => id && !retainedEventIds.has(id));

    const nextJson = hasSummaryContent(json) ? json : null;
    // 先清派生向量，再提交事件撤销。否则清理失败后复用事件 ID，会把旧向量
    // 当成新事件的向量。反过来即使 metadata 保存失败，也只会留下可补齐的缺向量。
    try {
        if (targetEndMesId < 0 && !nextJson) {
            await clearEventVectors(chatId);
        } else if (deletedEventIds.length > 0) {
            await deleteEventVectorsByIds(chatId, deletedEventIds);
        }
    } catch (error) {
        xbLog.error(MODULE_ID, '总结回滚失败: event_vector_cleanup_failed', error);
        return { status: 'failed', reason: 'event_vector_cleanup_failed', targetEndMesId };
    }

    store.json = nextJson;
    store.lastSummarizedMesId = targetEndMesId;
    store.summaryHistory = (store.summaryHistory || []).filter(h => h.endMesId <= targetEndMesId);
    delete store.summaryInvalid;
    if (targetEndMesId < 0) {
        store.hideSummarizedHistory = false;
        if (store.json) store.pendingImportBoundary = true;
        else delete store.pendingImportBoundary;
    } else {
        delete store.pendingImportBoundary;
    }
    store.updatedAt = Date.now();
    try {
        await saveSummaryStoreImmediately(chatId);
    } catch (error) {
        for (const key of Object.keys(store)) delete store[key];
        Object.assign(store, previousStore);
        xbLog.error(MODULE_ID, '总结回滚失败: metadata_persistence_failed', error);
        return { status: 'failed', reason: 'metadata_persistence_failed', targetEndMesId };
    }

    xbLog.info(MODULE_ID, `回滚完成，目标楼层: ${targetEndMesId}`);
    return { status: 'rolled_back', targetEndMesId };
}

export async function rollbackSummaryOnce(chatId) {
    const store = getSummaryStore();
    if (!store) {
        return { success: false, reason: 'store_unavailable', targetEndMesId: null, clearedAll: false, clearedBoundary: false };
    }

    const targetEndMesId = getRollbackOnceTargetEndMesId(store);
    if (targetEndMesId == null) {
        return { success: false, reason: 'rollback_unavailable', targetEndMesId: null, clearedAll: false, clearedBoundary: false };
    }

    let rollback;
    try {
        rollback = await executeRollback(chatId, store, targetEndMesId);
    } catch (error) {
        xbLog.error(MODULE_ID, '手动总结回滚发生未处理异常', error);
        rollback = { status: 'failed', reason: 'rollback_exception', targetEndMesId };
    }
    if (rollback.status !== 'rolled_back') {
        return { success: false, reason: rollback.reason || 'rollback_failed', targetEndMesId, clearedAll: false, clearedBoundary: false };
    }
    return {
        success: true,
        targetEndMesId,
        clearedAll: targetEndMesId < 0 && !hasSummaryContent(store.json),
        clearedBoundary: targetEndMesId < 0,
    };
}

export async function clearSummaryData(chatId) {
    const store = getSummaryStore();
    const previousStore = store ? structuredClone(store) : null;
    // 与回滚相同：成功删除派生向量后，才允许释放全部事件 ID。
    if (chatId) await clearEventVectors(chatId);
    if (store) {
        delete store.json;
        store.lastSummarizedMesId = -1;
        store.summaryHistory = [];
        delete store.pendingImportBoundary;
        delete store.summaryInvalid;
        store.hideSummarizedHistory = false;
        store.updatedAt = Date.now();
    }

    try {
        await saveSummaryStoreImmediately(chatId);
    } catch (error) {
        if (store && previousStore) {
            for (const key of Object.keys(store)) delete store[key];
            Object.assign(store, previousStore);
        }
        throw error;
    }

    xbLog.info(MODULE_ID, '总结数据已清空');
}

// ═══════════════════════════════════════════════════════════════════════════
// L3 数据读取（供 prompt.js / recall.js 使用）
// ═══════════════════════════════════════════════════════════════════════════

export function getFacts() {
    const store = getSummaryStore();
    return (store?.json?.facts || []).filter(f => !f.retracted);
}

export function getNewCharacters() {
    const store = getSummaryStore();
    return (store?.json?.characters?.main || []).map(m =>
        typeof m === 'string' ? m : m.name
    );
}
