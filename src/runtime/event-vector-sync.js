import { getContext } from '../../../../../extensions.js';
import { xbLog } from '../support/debug-core.js';
import { mergeAbortSignals } from '../support/abort-utils.js';
import { getVectorConfig } from '../summary/data/config.js';
import { getSummaryStore } from '../summary/data/store.js';
import { createSummaryGenerationCancelledError } from '../summary/generate/llm.js';
import { buildEventVectorText, selectMissingEventVectorPairs } from '../vector/pipeline/event-vector-input.js';
import { embed, getEngineFingerprint } from '../vector/utils/embedder.js';
import {
    getMeta,
    saveEventVectors as saveEventVectorsToDb,
    getAllEventVectors,
    deleteEventVectorsByIds,
} from '../vector/storage/chunk-store.js';
import { captureFrozenChatIdentity, assertChatTargetUnchanged } from '../vector/storage/chat-target.js';
import { flushL12DurableCopy, restoreL12DurableCopy } from '../vector/storage/l12-durable-copy.js';
import {
    VECTOR_WRITE_SCOPES,
    isVectorWriteSessionCurrent,
    runVectorWriteTask,
} from '../vector/runtime/maintenance-coordinator.js';
import { addEventDocuments, removeEventDocuments } from '../vector/retrieval/lexical-index.js';

const MODULE_ID = 'storySummary';

export function createEventVectorSync({
    guard,
    isChatStale,
    isStorySummaryEnabledForCurrentChat,
    assertSummaryExecutionActive,
    sendVectorStatsToFrame,
    refreshEntityLexiconAndWarmup,
    scheduleVectorIntegrityCheck,
}) {
    let eventEditSyncToken = 0;

    function buildEventLexicalSignature(event) {
        const participants = Array.isArray(event?.participants) ? event.participants.join(" ") : "";
        return `${event?.title || ""} ${participants} ${event?.summary || ""}`.trim();
    }

    async function collectMissingEventVectorPairs(chatId, events, fingerprint) {
        const existingVectors = await getAllEventVectors(chatId);
        return selectMissingEventVectorPairs(events, existingVectors, fingerprint);
    }

    async function autoVectorizeMissingEventsNow(store, execution, writeSession) {
        assertSummaryExecutionActive(execution);
        if (!isVectorWriteSessionCurrent(writeSession)) return;
        const vectorCfg = getVectorConfig();
        if (!vectorCfg?.enabled) return;

        const chatId = execution.chatId;
        const events = store?.json?.events || [];
        const fingerprint = getEngineFingerprint(vectorCfg);
        const meta = await getMeta(chatId);
        assertSummaryExecutionActive(execution);
        if (meta?.fingerprint && meta.fingerprint !== fingerprint) return;

        await restoreL12DurableCopy(chatId, fingerprint);
        const pairs = await collectMissingEventVectorPairs(chatId, events, fingerprint);
        assertSummaryExecutionActive(execution);

        if (!pairs.length) {
            await flushL12DurableCopy(chatId);
            return;
        }

        // 冻结目标身份：Embedding 可能跨聊天切换，写库前必须复验。
        const target = captureFrozenChatIdentity(chatId);
        try {
            await assertChatTargetUnchanged(target, 'L2 event vector write');
        } catch (error) {
            xbLog.warn(MODULE_ID, '目标聊天身份已变化，L2 自动增量未写入', error);
            return;
        }

        try {
            const batchSize = 20;
            const signal = mergeAbortSignals(execution.controller.signal, writeSession.signal);

            for (let i = 0; i < pairs.length; i += batchSize) {
                const batch = pairs.slice(i, i + batchSize);
                const texts = batch.map((p) => p.text);

                const vectors = await embed(texts, vectorCfg, { signal });
                assertSummaryExecutionActive(execution);
                if (!isVectorWriteSessionCurrent(writeSession)) return;
                const items = batch.map((p, idx) => ({
                    eventId: p.id,
                    inputText: p.text,
                    vector: vectors[idx],
                }));

                if (!isVectorWriteSessionCurrent(writeSession)) return;
                await saveEventVectorsToDb(chatId, items, fingerprint);
                assertSummaryExecutionActive(execution);
            }

            await flushL12DurableCopy(chatId);
            xbLog.info(MODULE_ID, `L2 自动增量完成: ${pairs.length} 个事件`);
            await sendVectorStatsToFrame();
        } catch (e) {
            assertSummaryExecutionActive(execution);
            if (e?.name === 'AbortError' || !isVectorWriteSessionCurrent(writeSession)) {
                throw createSummaryGenerationCancelledError();
            }
            throw new Error('总结后的事件向量化失败', { cause: e });
        }
    }

    async function autoVectorizeMissingEvents(store, execution) {
        assertSummaryExecutionActive(execution);
        return runVectorWriteTask(
            {
                chatId: execution.chatId,
                kind: 'summary-event-vectorization',
                scope: VECTOR_WRITE_SCOPES.EMBEDDING,
            },
            (writeSession) => autoVectorizeMissingEventsNow(store, execution, writeSession),
        );
    }

    async function repairMissingEventVectorsNow(targetChatId, writeSession, onProgress = null) {
        let repaired = 0;
        try {
            const vectorCfg = getVectorConfig();
            if (!vectorCfg?.enabled) return { success: false, repaired: 0, code: 'disabled' };

            const events = structuredClone(getSummaryStore()?.json?.events || []);
            if (!events.length) return { success: true, repaired: 0 };

            const fingerprint = getEngineFingerprint(vectorCfg);
            const meta = await getMeta(targetChatId);
            if (!isVectorWriteSessionCurrent(writeSession)) {
                return { success: false, cancelled: true, repaired, code: 'vector_config_changed' };
            }
            if (meta?.fingerprint && meta.fingerprint !== fingerprint) {
                return { success: false, repaired: 0, code: 'fingerprint_mismatch' };
            }

            await restoreL12DurableCopy(targetChatId, fingerprint);
            const pairs = await collectMissingEventVectorPairs(targetChatId, events, fingerprint);
            onProgress?.(0, pairs.length);
            if (!pairs.length) {
                await flushL12DurableCopy(targetChatId);
                return { success: true, repaired: 0 };
            }

            // 冻结目标身份：Embedding 可能跨聊天切换，写库前必须复验。
            const target = captureFrozenChatIdentity(targetChatId);
            try {
                await assertChatTargetUnchanged(target, 'L2 event vector repair write');
            } catch (error) {
                xbLog.warn(MODULE_ID, '目标聊天身份已变化，L2 向量补齐未写入', error);
                return { success: false, repaired, code: 'stale_chat', error };
            }

            for (let i = 0; i < pairs.length; i += 20) {
                const batch = pairs.slice(i, i + 20);
                const vectors = await embed(batch.map(pair => pair.text), vectorCfg, { signal: writeSession.signal });
                if (
                    getContext()?.chatId !== targetChatId
                    || !isStorySummaryEnabledForCurrentChat()
                    || !isVectorWriteSessionCurrent(writeSession)
                ) return { success: false, repaired, code: 'vector_config_changed' };

                const currentEvents = new Map((getSummaryStore()?.json?.events || [])
                    .filter(event => event?.id)
                    .map(event => [event.id, buildEventVectorText(event)]));
                const items = batch
                    .map((pair, index) => ({ pair, vector: vectors[index] }))
                    .filter(item => currentEvents.get(item.pair.id) === item.pair.text)
                    .map(item => ({ eventId: item.pair.id, inputText: item.pair.text, vector: item.vector }));
                if (items.length > 0) {
                    if (!isVectorWriteSessionCurrent(writeSession)) {
                        return { success: false, repaired, code: 'vector_config_changed' };
                    }
                    await saveEventVectorsToDb(targetChatId, items, fingerprint);
                    repaired += items.length;
                    onProgress?.(repaired, pairs.length);
                }
            }

            await flushL12DurableCopy(targetChatId);
            if (repaired > 0) {
                xbLog.info(MODULE_ID, `L2 自动补齐完成: ${repaired} 个事件`);
                await sendVectorStatsToFrame();
            }
            return { success: true, repaired };
        } catch (error) {
            if (error?.name === 'AbortError' || !isVectorWriteSessionCurrent(writeSession)) {
                return { success: false, cancelled: true, repaired, code: 'vector_config_changed' };
            }
            xbLog.warn(MODULE_ID, 'L2 自动补齐失败', error);
            return { success: false, repaired, code: 'repair_failed', error };
        }
    }

    async function repairMissingEventVectorsForCurrentChat() {
        const release = guard.acquire('vector');
        if (!release) return { success: false, repaired: 0, code: 'busy' };

        const targetChatId = getContext()?.chatId || null;
        try {
            if (!targetChatId) return { success: false, repaired: 0, code: 'disabled' };
            const result = await runVectorWriteTask(
                {
                    chatId: targetChatId,
                    kind: 'event-vector-repair',
                    scope: VECTOR_WRITE_SCOPES.EMBEDDING,
                },
                (writeSession) => repairMissingEventVectorsNow(targetChatId, writeSession),
            );
            return result || { success: false, repaired: 0, code: 'vector_config_changed' };
        } catch (error) {
            xbLog.warn(MODULE_ID, 'L2 自动补齐失败', error);
            return { success: false, repaired: 0, code: 'repair_failed', error };
        } finally {
            release();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // L2 跟随编辑同步（用户编辑 events 时调用）
    // ═══════════════════════════════════════════════════════════════════════════

    function syncEventVectorsOnEdit(oldEvents, newEvents) {
        const targetChatId = getContext()?.chatId || '';
        if (!targetChatId) return;
        const oldById = new Map((oldEvents || []).map(event => [event.id, event]));
        const newIds = new Set((newEvents || []).map(event => event.id));
        const deletedIds = [...oldById.keys()].filter(id => !newIds.has(id));
        // Lexical changes follow each saved edit immediately, independently of the
        // vector write queue. The index owns batching, tokenization and publication.
        removeEventDocuments(deletedIds, targetChatId);
        addEventDocuments((newEvents || []).filter(event => (
            buildEventLexicalSignature(oldById.get(event.id)) !== buildEventLexicalSignature(event)
        )), targetChatId);
        refreshEntityLexiconAndWarmup();

        const vectorChangedIds = [...deletedIds, ...(newEvents || [])
            .filter(event => buildEventVectorText(oldById.get(event.id)) !== buildEventVectorText(event))
            .map(event => event.id)];
        // Ordinary edits never cancel earlier deltas. Only an explicit clear or
        // rollback changes this token. Queue identities, not obsolete event bodies.
        return syncEventVectorsOnEditNow(vectorChangedIds, eventEditSyncToken, targetChatId);
    }

    function cancelPendingEventEditSync() {
        eventEditSyncToken += 1;
    }

    async function syncEventVectorsOnEditWrite(changedIds, syncToken, targetChatId, writeSession, target) {
        try {
            const vectorCfg = getVectorConfig();
            const { chatId } = getContext();
            if (!chatId || chatId !== targetChatId || !vectorCfg?.enabled) return;
            if (
                syncToken !== eventEditSyncToken
                || isChatStale(chatId)
                || !isVectorWriteSessionCurrent(writeSession)
            ) return;
            try {
                await assertChatTargetUnchanged(target, 'L2 event-vector sync');
            } catch (error) {
                xbLog.warn(MODULE_ID, '目标聊天身份已变化，已取消 L2 事件向量同步', error);
                return;
            }

            // Resolve only this edit's affected IDs against the current source.
            // Later edits of other events retain their own place in the write queue.
            const currentById = new Map((getSummaryStore()?.json?.events || []).map(event => [event.id, event]));
            const changes = changedIds.map(id => ({ id, text: buildEventVectorText(currentById.get(id)) }));
            const deletedIds = changes.filter(item => !item.text).map(item => item.id);
            const pairs = changes.filter(item => item.text);
            if (syncToken !== eventEditSyncToken || isChatStale(chatId)) return;

            if (deletedIds.length > 0) {
                if (!isVectorWriteSessionCurrent(writeSession)) return;
                await deleteEventVectorsByIds(chatId, deletedIds);
                xbLog.info(MODULE_ID, `L2 同步删除: ${deletedIds.length} 个事件向量`);
            }

            if (pairs.length > 0) {
                const fingerprint = getEngineFingerprint(vectorCfg);
                const batchSize = 20;

                for (let i = 0; i < pairs.length; i += batchSize) {
                    if (
                        syncToken !== eventEditSyncToken
                        || isChatStale(chatId)
                        || !isVectorWriteSessionCurrent(writeSession)
                    ) return;
                    const batch = pairs.slice(i, i + batchSize);
                    try {
                        const vectors = await embed(batch.map((p) => p.text), vectorCfg, { signal: writeSession.signal });
                        if (
                            !Array.isArray(vectors)
                            || vectors.length < batch.length
                            || vectors.slice(0, batch.length).some(vector => !vector?.length)
                        ) {
                            throw new Error(`Embedding 响应数量不匹配: expect>=${batch.length}, got=${vectors?.length || 0}`);
                        }
                        if (
                            syncToken !== eventEditSyncToken
                            || isChatStale(chatId)
                            || !isVectorWriteSessionCurrent(writeSession)
                        ) return;
                        const currentEventTexts = new Map((getSummaryStore()?.json?.events || [])
                            .filter(event => event?.id)
                            .map(event => [event.id, buildEventVectorText(event)]));
                        const items = batch
                            .map((pair, index) => ({ pair, vector: vectors[index] }))
                            .filter(item => currentEventTexts.get(item.pair.id) === item.pair.text)
                            .map(item => ({ eventId: item.pair.id, inputText: item.pair.text, vector: item.vector }));
                        if (items.length > 0) {
                            if (!isVectorWriteSessionCurrent(writeSession)) return;
                            await saveEventVectorsToDb(chatId, items, fingerprint);
                        }
                        if (items.length !== batch.length) scheduleVectorIntegrityCheck(0);
                    } catch (error) {
                        if (error?.name === 'AbortError' || !isVectorWriteSessionCurrent(writeSession)) return;
                        if (syncToken === eventEditSyncToken && !isChatStale(chatId)) {
                            const failedExistingIds = batch.map(pair => pair.id);
                            if (failedExistingIds.length > 0) {
                                try {
                                    await deleteEventVectorsByIds(chatId, failedExistingIds);
                                } catch (cleanupError) {
                                    xbLog.warn(MODULE_ID, 'L2 编辑失败后的旧向量清理失败', cleanupError);
                                }
                            }
                            scheduleVectorIntegrityCheck(0);
                        }
                        throw error;
                    }
                }
            }

            await flushL12DurableCopy(chatId);
            if (pairs.length > 0) {
                xbLog.info(MODULE_ID, `L2 向量同步刷新: ${pairs.length} 个事件`);
            }

            if (deletedIds.length > 0 || pairs.length > 0) {
                await sendVectorStatsToFrame();
            }
        } catch (e) {
            if (e?.name === 'AbortError' || !isVectorWriteSessionCurrent(writeSession)) return;
            xbLog.error(MODULE_ID, "L2 编辑同步失败", e);
            if (getContext()?.chatId === targetChatId) scheduleVectorIntegrityCheck(0);
        }
    }

    async function syncEventVectorsOnEditNow(changedIds, syncToken, targetChatId) {
        if (!targetChatId || !changedIds.length) return;
        // 冻结编辑发生时的目标身份：任务可能排在长写任务之后执行。
        const target = captureFrozenChatIdentity(targetChatId);
        return runVectorWriteTask(
            {
                chatId: targetChatId,
                kind: 'event-edit-sync',
                scope: VECTOR_WRITE_SCOPES.CONSISTENCY,
            },
            (writeSession) => syncEventVectorsOnEditWrite(
                changedIds,
                syncToken,
                targetChatId,
                writeSession,
                target,
            ),
        );
    }

    return {
        autoVectorizeMissingEvents,
        repairMissingEventVectorsNow,
        repairMissingEventVectorsForCurrentChat,
        collectMissingEventVectorPairs,
        syncEventVectorsOnEdit,
        cancelPendingEventEditSync,
    };
}
