import { getContext } from "../../../../../extensions.js";
import { xbLog } from '../support/debug-core.js';
import { getVectorConfig } from '../summary/data/config.js';
import { getSummaryStore } from '../summary/data/store.js';
import { embed, getEngineFingerprint, testOnlineService } from '../vector/utils/embedder.js';
import { testL0Service } from '../vector/llm/llm-service.js';
import { testRerankService } from '../vector/llm/reranker.js';
import { isRetryableEmbeddingFailure } from '../vector/llm/embedding-failure.js';
import {
    getMeta,
    updateMeta,
    saveEventVectors as saveEventVectorsToDb,
    clearEventVectors,
    clearAllChunks,
    saveChunks,
    saveChunkVectors,
} from '../vector/storage/chunk-store.js';
import { chunkMessage } from '../vector/pipeline/chunk-builder.js';
import { flushL12DurableCopy } from '../vector/storage/l12-durable-copy.js';
import { repairMissingChunks } from '../vector/pipeline/chunk-repair.js';
import {
    incrementalExtractAtoms,
    vectorizeMissingStateAtoms,
    clearAllAtomsAndVectors,
    getAnchorStats,
} from '../vector/pipeline/state-integration.js';
import { clearStateVectors, getStateAtoms, saveStateVectors } from '../vector/storage/state-store.js';
import {
    captureFrozenChatIdentity,
    isChatTargetCurrent,
    assertChatTargetUnchanged,
} from '../vector/storage/chat-target.js';
import {
    VECTOR_WRITE_SCOPES,
    cancelVectorWriteOperation,
    isVectorWriteSessionCurrent,
    runVectorWriteTask,
} from '../vector/runtime/maintenance-coordinator.js';
import { invalidateLexicalIndex, addChunkDocuments, clearChunkDocuments } from '../vector/retrieval/lexical-index.js';

const MODULE_ID = "storySummary";

// 用户可主动取消的写入操作。取消只作用于同名操作，不连坐其他写任务。
const VECTOR_GENERATION_OPERATION = 'vector-generation';
const ANCHOR_GENERATION_OPERATION = 'anchor-generation';

const R_AGG_MAX_CHARS = 256;

function buildRAggregateText(atom) {
    const uniq = new Set();
    for (const edge of (atom?.edges || [])) {
        const r = String(edge?.r || "").trim();
        if (!r) continue;
        uniq.add(r);
    }
    const joined = [...uniq].join(" ; ");
    if (!joined) return String(atom?.semantic || "").trim();
    return joined.length > R_AGG_MAX_CHARS ? joined.slice(0, R_AGG_MAX_CHARS) : joined;
}

function formatSafeFailure(code, httpStatus = null) {
    const safeCode = String(code || 'unknown').replace(/[^a-z0-9_:-]/gi, '').slice(0, 80) || 'unknown';
    const status = Number(httpStatus);
    return Number.isInteger(status) && status >= 100 && status <= 599
        ? `${safeCode}（HTTP ${status}）`
        : safeCode;
}

function getL0FailureAdvice(code) {
    if (code === 'l0_config_missing') {
        return '请先配置 L0 API Key，再点击“生成/补齐”继续；已完成楼层不会重复生成。';
    }
    return '请检查 L0 API、模型和网络后，再点击“生成/补齐”继续；已完成楼层不会重复生成。';
}

function getVectorFailureAdvice(code) {
    if (code === 'fingerprint_mismatch') {
        return '向量配置已经变化，请点击“完整重建”重新生成全部向量。';
    }
    if (code === 'embedding_config_missing') {
        return '请先配置 Embedding API Key，再点击“补齐缺漏”继续。';
    }
    if (code === 'embedding_url_invalid') {
        return '请检查 Embedding API URL，应为完整的 http:// 或 https:// 地址。';
    }
    if (['chunk_read_failed', 'state_vector_read_failed', 'state_vector_write_failed', 'chunk_write_failed', 'vector_write_failed', 'metadata_write_failed', 'durable_copy_failed'].includes(code)) {
        return '请确认浏览器存储可用且空间充足，刷新页面后再点击“补齐缺漏”继续。';
    }
    return '请检查 Embedding API、Key、额度和网络后，再点击“补齐缺漏”继续。';
}

export function createVectorGeneration({
    guard,
    postToFrame,
    panelStats,
    executeSlashCommand,
    changeRecallData,
    getActiveChatId,
    eventVectorSync,
    maintenance,
}) {
    const { sendAnchorStatsToFrame, sendVectorStatsToFrame } = panelStats;
    const { repairMissingEventVectorsNow } = eventVectorSync;
    const { scheduleVectorIntegrityCheck, scheduleLexicalWarmup } = maintenance;

    async function handleAnchorGenerateNow(targetChatId, writeSession) {
        const isCancelled = () => getContext()?.chatId !== targetChatId || !isVectorWriteSessionCurrent(writeSession);
        if (isCancelled()) return;
        try {
            const vectorCfg = getVectorConfig();
            if (!vectorCfg?.enabled) {
                await executeSlashCommand("/echo severity=warning 请先启用向量检索");
                return;
            }
            const { chat } = getContext();
            if (!chat?.length) return;
            const stats = await getAnchorStats();
            if (isCancelled()) return;
            if (stats.incomplete <= 0) {
                await executeSlashCommand('/echo severity=info 记忆锚点已完整');
                return;
            }
            if (!vectorCfg.l0Api?.key) {
                await executeSlashCommand('/echo severity=error 请配置 L0 API Key 后再生成锚点');
                return;
            }
            const result = await incrementalExtractAtoms(
                targetChatId,
                [...chat],
                (message, current, total) => postToFrame({ type: "ANCHOR_GEN_PROGRESS", current, total, message }),
                {
                    signal: writeSession.signal,
                    shouldCancel: isCancelled,
                    retryFailedFloors: true,
                },
            );
            if (isCancelled() || result.cancelled) return;
            if (result.llmFailed > 0) {
                const failure = formatSafeFailure(result.failureCode, result.httpStatus);
                await executeSlashCommand(`/echo severity=error 已保存成功提取的锚点；${result.llmFailed} 个楼层未完成（${failure}）。${getL0FailureAdvice(result.failureCode)}`);
            } else {
                await executeSlashCommand('/echo severity=info 锚点生成完成，可在“向量数据”中补齐缺漏');
            }
        } catch (error) {
            if (error?.name === 'AbortError' || isCancelled()) return;
            xbLog.error(MODULE_ID, '记忆锚点生成失败', error);
            await executeSlashCommand('/echo severity=error 记忆锚点生成失败：internal_error');
        } finally {
            await sendAnchorStatsToFrame();
        }
    }
    async function handleAnchorGenerate() {
        if (guard.isAnyRunning('anchor', 'vector')) {
            postToFrame({ type: "ANCHOR_GEN_PROGRESS", current: -1, total: 0 });
            await executeSlashCommand('/echo severity=info 向量或锚点任务正在运行，请稍后再试');
            return;
        }
        const release = guard.acquire('anchor');
        if (!release) return;
        const targetChatId = getContext()?.chatId || '';
        try {
            return await runVectorWriteTask(
                {
                    chatId: targetChatId,
                    kind: 'manual-anchor-generation',
                    scope: VECTOR_WRITE_SCOPES.EMBEDDING,
                    operationId: ANCHOR_GENERATION_OPERATION,
                },
                (writeSession) => handleAnchorGenerateNow(targetChatId, writeSession),
            );
        } finally {
            release();
            postToFrame({ type: "ANCHOR_GEN_PROGRESS", current: -1, total: 0 });
        }
    }

    async function handleAnchorClear() {
        const targetChatId = getContext()?.chatId || '';
        if (!targetChatId) return;
        const target = captureFrozenChatIdentity(targetChatId);

        await runVectorWriteTask(
            { chatId: targetChatId, kind: 'clear-anchors', scope: VECTOR_WRITE_SCOPES.IO },
            async () => {
                if (getContext()?.chatId !== targetChatId) return;
                await assertChatTargetUnchanged(target, 'anchor clear');
                await changeRecallData(targetChatId, () => clearAllAtomsAndVectors(targetChatId));
            },
        );
        if (getContext()?.chatId !== targetChatId) return;
        await sendAnchorStatsToFrame();
        await sendVectorStatsToFrame();

        await executeSlashCommand("/echo severity=info 记忆锚点已清空");
        xbLog.info(MODULE_ID, "记忆锚点已清空");
    }

    function handleAnchorCancel() {
        cancelVectorWriteOperation(ANCHOR_GENERATION_OPERATION, 'Anchor generation cancelled');
        scheduleVectorIntegrityCheck(0);
    }

    async function handleTestOnlineService(provider, config, target = "embedding") {
        try {
            postToFrame({ type: "VECTOR_ONLINE_STATUS", target, status: "downloading", message: "连接中..." });
            let result;
            if (target === "l0") result = await testL0Service(config);
            else if (target === "rerank") result = await testRerankService(config);
            else result = await testOnlineService(provider, config);
            postToFrame({
                type: "VECTOR_ONLINE_STATUS",
                target,
                status: "success",
                message: target === "embedding"
                    ? `连接成功 (${result.dims}维)`
                    : (result.message || "连接成功"),
            });
        } catch (e) {
            postToFrame({ type: "VECTOR_ONLINE_STATUS", target, status: "error", message: e.message });
        }
    }

    async function generateVectorsNow(vectorCfg, targetChatId, writeSession) {
        if (getContext()?.chatId !== targetChatId || !isVectorWriteSessionCurrent(writeSession)) return;
        try {
            if (!vectorCfg?.enabled) {
                return;
            }

            const { chatId, chat } = getContext();
            if (!chatId || !chat?.length) return;
            const chatSnapshot = [...chat];
            const atoms = structuredClone(getStateAtoms());
            const sourceEvents = structuredClone(getSummaryStore()?.json?.events || []);
            const target = captureFrozenChatIdentity(targetChatId);
            const isTargetActive = () => getActiveChatId() === targetChatId && isChatTargetCurrent(target);

            if (!vectorCfg.embeddingApi?.key) {
                postToFrame({ type: "VECTOR_ONLINE_STATUS", status: "error", message: "请配置 Embedding API Key" });
                return;
            }

            const operationSignal = writeSession.signal;
            const isCancelled = () => (
                operationSignal?.aborted
                || !isVectorWriteSessionCurrent(writeSession)
            );

            const fingerprint = getEngineFingerprint(vectorCfg);
            const batchSize = 20;

            // 全量重建从清空开始，属于不可回退的永久写入；先复验身份再动手。
            await assertChatTargetUnchanged(target, 'vector rebuild clear');

            await clearAllChunks(chatId);
            clearChunkDocuments(chatId);
            if (isCancelled()) return;
            await clearEventVectors(chatId);
            if (isCancelled()) return;
            await clearStateVectors(chatId);
            if (isCancelled()) return;
            await updateMeta(chatId, { lastChunkFloor: -1, fingerprint });
            if (isCancelled()) return;

            // Helper to embed with retry
            const embedWithRetry = async (texts, phase, currentBatchIdx, totalItems) => {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    if (isCancelled() || !isTargetActive()) return null;
                    try {
                        const vectors = await embed(texts, vectorCfg, { signal: operationSignal });
                        if (
                            !Array.isArray(vectors)
                            || vectors.length < texts.length
                            || vectors.slice(0, texts.length).some(vector => !vector?.length)
                        ) {
                            throw new Error(`Embedding 响应数量不匹配: expect>=${texts.length}, got=${vectors?.length || 0}`);
                        }
                        return vectors;
                    } catch (e) {
                        if (e?.name === "AbortError" || isCancelled() || !isTargetActive()) return null;
                        xbLog.error(MODULE_ID, `${phase} 向量化单次失败`, e);
                        if (attempt === 3 || !isRetryableEmbeddingFailure(e)) throw e;

                        // 等待 60 秒重试
                        const waitSec = 60;
                        for (let s = waitSec; s > 0; s--) {
                            if (isCancelled() || !isTargetActive()) return null;
                            postToFrame({
                                type: "VECTOR_GEN_PROGRESS",
                                phase,
                                current: currentBatchIdx,
                                total: totalItems,
                                message: `触发限流，${s}s 后重试...`
                            });
                            await new Promise(r => setTimeout(r, 1000));
                        }
                        postToFrame({ type: "VECTOR_GEN_PROGRESS", phase, current: currentBatchIdx, total: totalItems, message: "正在重试..." });
                    }
                }
                return null;
            };

            if (!atoms.length) {
                postToFrame({ type: "VECTOR_GEN_PROGRESS", phase: "L0", current: 0, total: 0, message: "L0 为空，跳过" });
            } else {
                postToFrame({ type: "VECTOR_GEN_PROGRESS", phase: "L0", current: 0, total: atoms.length, message: "L0 向量化..." });

                let l0Completed = 0;
                for (let i = 0; i < atoms.length; i += batchSize) {
                    if (isCancelled()) break;

                    const batch = atoms.slice(i, i + batchSize);
                    const semTexts = batch.map(a => a.semantic);
                    const rTexts = batch.map(a => buildRAggregateText(a));

                    const vectors = await embedWithRetry(semTexts.concat(rTexts), "L0", l0Completed, atoms.length);
                    if (!vectors) break; // cancelled
                    if (isCancelled() || !isTargetActive()) return;

                    const split = semTexts.length;
                    if (!Array.isArray(vectors) || vectors.length < split * 2) {
                        xbLog.error(MODULE_ID, `embed长度不匹配: expect>=${split * 2}, got=${vectors?.length || 0}`);
                        continue;
                    }
                    const semVectors = vectors.slice(0, split);
                    const rVectors = vectors.slice(split, split + split);
                    const items = batch.map((a, j) => ({
                        atomId: a.atomId,
                        floor: a.floor,
                        vector: semVectors[j],
                        rVector: rVectors[j] || semVectors[j],
                    }));
                    if (isCancelled()) return;
                    await saveStateVectors(chatId, items, fingerprint);
                    l0Completed += batch.length;
                    postToFrame({ type: "VECTOR_GEN_PROGRESS", phase: "L0", current: l0Completed, total: atoms.length });
                }
            }

            if (isCancelled() || !isTargetActive()) return;

            const allChunks = [];
            for (let floor = 0; floor < chatSnapshot.length; floor++) {
                if (isCancelled()) break;

                const message = chatSnapshot[floor];
                if (!message) continue;

                const chunks = chunkMessage(floor, message);
                if (!chunks.length) continue;

                allChunks.push(...chunks);
            }

            let l1Vectors = [];
            if (!allChunks.length) {
                postToFrame({ type: "VECTOR_GEN_PROGRESS", phase: "L1", current: 0, total: 0, message: "L1 为空，跳过" });
            } else {
                postToFrame({ type: "VECTOR_GEN_PROGRESS", phase: "L1", current: 0, total: allChunks.length, message: "L1 向量化..." });
                if (isCancelled() || !isTargetActive()) return;
                await saveChunks(chatId, allChunks);
                addChunkDocuments(allChunks, chatId);

                let l1Completed = 0;
                for (let i = 0; i < allChunks.length; i += batchSize) {
                    if (isCancelled()) break;

                    const batch = allChunks.slice(i, i + batchSize);
                    const texts = batch.map(c => c.text);

                    const vectors = await embedWithRetry(texts, "L1", l1Completed, allChunks.length);
                    if (!vectors) break; // cancelled
                    if (isCancelled() || !isTargetActive()) return;

                    const items = batch.map((c, j) => ({
                        chunkId: c.chunkId,
                        inputText: c.text,
                        vector: vectors[j],
                    }));
                    if (isCancelled()) return;
                    await saveChunkVectors(chatId, items, fingerprint);
                    l1Vectors = l1Vectors.concat(items);
                    l1Completed += batch.length;
                    postToFrame({ type: "VECTOR_GEN_PROGRESS", phase: "L1", current: l1Completed, total: allChunks.length });
                }
            }

            if (isCancelled() || !isTargetActive()) return;

            const l2Pairs = sourceEvents
                .map((e) => ({ id: e.id, text: `${e.title || ""} ${e.summary || ""}`.trim() }))
                .filter((p) => p.text);

            if (!l2Pairs.length) {
                postToFrame({ type: "VECTOR_GEN_PROGRESS", phase: "L2", current: 0, total: 0, message: "L2 为空，跳过" });
            } else {
                postToFrame({ type: "VECTOR_GEN_PROGRESS", phase: "L2", current: 0, total: l2Pairs.length, message: "L2 向量化..." });

                let l2Completed = 0;
                for (let i = 0; i < l2Pairs.length; i += batchSize) {
                    if (isCancelled()) break;

                    const batch = l2Pairs.slice(i, i + batchSize);
                    const texts = batch.map(p => p.text);

                    const vectors = await embedWithRetry(texts, "L2", l2Completed, l2Pairs.length);
                    if (!vectors) break; // cancelled
                    if (isCancelled() || !isTargetActive()) return;

                    const items = batch.map((p, idx) => ({
                        eventId: p.id,
                        inputText: p.text,
                        vector: vectors[idx],
                    }));
                    if (isCancelled()) return;
                    await saveEventVectorsToDb(chatId, items, fingerprint);
                    l2Completed += batch.length;
                    postToFrame({ type: "VECTOR_GEN_PROGRESS", phase: "L2", current: l2Completed, total: l2Pairs.length });
                }
            }

            // Full rebuild completed: vector boundary should match latest floor.
            if (isCancelled() || !isTargetActive()) return;
            await assertChatTargetUnchanged(target, 'vector rebuild metadata write');
            await updateMeta(chatId, { lastChunkFloor: chatSnapshot.length - 1 });
            await flushL12DurableCopy(chatId);

            await sendVectorStatsToFrame();

            xbLog.info(MODULE_ID, `向量生成完成: L0=${atoms.length}, L1=${l1Vectors.length}, L2=${l2Pairs.length}`);
        } catch (e) {
            if (e?.name === 'AbortError' || !isVectorWriteSessionCurrent(writeSession)) return;
            xbLog.error(MODULE_ID, '向量生成失败', e);
            await executeSlashCommand('/echo severity=error 向量生成或持久副本提交未完成，请检查 API 与存储后重试');
            await sendVectorStatsToFrame();
        }
    }

    async function repairVectorsNow(vectorCfg, targetChatId, writeSession) {
        const isCancelled = () => getContext()?.chatId !== targetChatId || !isVectorWriteSessionCurrent(writeSession);
        if (isCancelled() || !vectorCfg?.enabled) return;
        const meta = await getMeta(targetChatId);
        if (isCancelled()) return;
        const fingerprint = getEngineFingerprint(vectorCfg);
        if (meta.fingerprint && meta.fingerprint !== fingerprint) {
            await executeSlashCommand(`/echo severity=warning ${getVectorFailureAdvice('fingerprint_mismatch')}`);
            return;
        }
        const chat = [...(getContext()?.chat || [])];
        if (!chat.length) return;
        // 冻结目标身份：补齐可能长时间运行，写库前必须复验。
        const target = captureFrozenChatIdentity(targetChatId);
        try {
            await assertChatTargetUnchanged(target, 'vector repair');
        } catch (error) {
            xbLog.warn(MODULE_ID, '目标聊天身份已变化，已取消向量补齐', error);
            return;
        }
        const progress = phase => (current, total) => postToFrame({
            type: 'VECTOR_GEN_PROGRESS', phase, current, total,
            message: total ? `${phase}：${current}/${total}` : `${phase} 无缺漏`,
        });
        const stages = [
            ['L1', () => repairMissingChunks({
                chatId: targetChatId, chat, vectorConfig: vectorCfg, signal: writeSession.signal,
                shouldCancel: isCancelled, onProgress: progress('L1'),
            })],
            ['L0', () => vectorizeMissingStateAtoms(targetChatId, progress('L0'), {
                vectorConfig: vectorCfg, signal: writeSession.signal, shouldCancel: isCancelled,
            })],
            ['L2', () => repairMissingEventVectorsNow(targetChatId, writeSession, progress('L2'))],
        ];
        const failures = [];
        let repaired = 0;
        for (const [phase, run] of stages) {
            if (isCancelled()) return;
            postToFrame({ type: 'VECTOR_GEN_PROGRESS', phase, current: 0, total: 0, message: `检查 ${phase} 缺漏...` });
            let result;
            try {
                result = await run();
            } catch (error) {
                if (isCancelled()) return;
                xbLog.warn(MODULE_ID, `${phase} 向量补齐失败`, error);
                result = {
                    success: false,
                    code: String(error?.code || 'repair_failed'),
                    ...(Number.isInteger(Number(error?.httpStatus)) ? { httpStatus: Number(error.httpStatus) } : {}),
                };
            }
            const count = Number(result.repaired ?? result.vectorized ?? 0);
            repaired += count;
            if (phase === 'L1' && count > 0) {
                invalidateLexicalIndex();
                scheduleLexicalWarmup();
            }
            if (isCancelled() || result.cancelled) return;
            if (!result.success) failures.push(`${phase}（${formatSafeFailure(result.code, result.httpStatus)}）`);
        }
        if (failures.length) {
            await executeSlashCommand(`/echo severity=warning 已补齐 ${repaired} 条向量；${failures.join('、')} 未完成，请检查 API 或存储后再点“补齐缺漏”。`);
        } else {
            await executeSlashCommand(`/echo severity=info ${repaired ? `已补齐 ${repaired} 条向量` : '已有材料的向量已完整'}`);
        }
    }

    async function handleGenerateVectors(mode = 'rebuild') {
        if (guard.isAnyRunning('anchor', 'vector')) {
            postToFrame({ type: 'VECTOR_GEN_PROGRESS', current: -1, total: 0 });
            await executeSlashCommand('/echo severity=info 向量或锚点任务正在运行，请稍后再试');
            return;
        }
        const release = guard.acquire('vector');
        if (!release) return;
        const targetChatId = getContext()?.chatId || '';
        try {
            return await runVectorWriteTask(
                {
                    chatId: targetChatId,
                    kind: mode === 'repair' ? 'missing-vector-repair' : 'full-vector-generation',
                    scope: VECTOR_WRITE_SCOPES.EMBEDDING,
                    operationId: VECTOR_GENERATION_OPERATION,
                },
                (writeSession) => {
                    const currentConfig = getVectorConfig();
                    if (!currentConfig?.enabled) return;
                    return mode === 'repair'
                        ? repairVectorsNow(currentConfig, targetChatId, writeSession)
                        : generateVectorsNow(currentConfig, targetChatId, writeSession);
                },
            );
        } catch (error) {
            xbLog.error(MODULE_ID, '向量任务失败', error);
            await executeSlashCommand('/echo severity=error 向量任务未完成，请检查 API 或存储后重试');
        } finally {
            release();
            postToFrame({ type: 'VECTOR_GEN_PROGRESS', current: -1, total: 0 });
            await sendVectorStatsToFrame();
        }
    }

    async function handleClearVectors() {
        const targetChatId = getContext()?.chatId || '';
        if (!targetChatId) return;
        const target = captureFrozenChatIdentity(targetChatId);

        await runVectorWriteTask(
            { chatId: targetChatId, kind: 'clear-vectors', scope: VECTOR_WRITE_SCOPES.IO },
            () => changeRecallData(targetChatId, async () => {
                if (getContext()?.chatId !== targetChatId) return;
                await assertChatTargetUnchanged(target, 'vector clear');
                await clearEventVectors(targetChatId);
                await clearAllChunks(targetChatId);
                clearChunkDocuments(targetChatId);
                await clearStateVectors(targetChatId);
                // Reset both boundary and fingerprint so next incremental build starts from floor 0
                // without being blocked by stale engine fingerprint mismatch.
                await updateMeta(targetChatId, { lastChunkFloor: -1, fingerprint: null });
            }),
        );
        if (getContext()?.chatId !== targetChatId) return;
        await sendVectorStatsToFrame();
        await executeSlashCommand('/echo severity=info 向量数据已清除。如需恢复，请点击“补齐缺漏”。');
        xbLog.info(MODULE_ID, "向量数据已清除");
    }

    function handleVectorCancel() {
        cancelVectorWriteOperation(VECTOR_GENERATION_OPERATION, 'Vector generation cancelled');
        scheduleVectorIntegrityCheck(0);
    }

    return {
        handleAnchorGenerate,
        handleAnchorClear,
        handleAnchorCancel,
        handleTestOnlineService,
        handleGenerateVectors,
        handleClearVectors,
        handleVectorCancel,
    };
}
