import { getContext } from "../../../../../extensions.js";
import { xbLog } from "../support/debug-core.js";
import { getSettings, getVectorConfig } from "../summary/data/config.js";
import { getSummaryStore } from "../summary/data/store.js";
import { getEngineFingerprint } from "../vector/utils/embedder.js";
import { buildVectorIntegrityIssues } from "../vector/integrity-policy.js";
import { injectEntities } from "../vector/utils/tokenizer.js";
import { getEntityVocabulary } from "../vector/retrieval/entity-lexicon.js";
import { getMeta } from "../vector/storage/chunk-store.js";
import { buildIncrementalChunks, getChunkBuildStatus } from "../vector/pipeline/chunk-builder.js";
import { runVectorMaintenance } from "../vector/pipeline/vector-workflow.js";
import {
    incrementalExtractAtoms,
    getL0VectorBuildStatus,
    vectorizeMissingStateAtoms,
    getAnchorStats,
} from "../vector/pipeline/state-integration.js";
import {
    VECTOR_WRITE_SCOPES,
    captureMaintenanceSnapshot,
    claimWarningCooldown,
    invalidateMaintenanceEpoch,
    isMaintenanceSnapshotCurrent,
    isVectorWriteSessionCurrent,
    runVectorWriteTask,
} from "../vector/runtime/maintenance-coordinator.js";
import { warmupIndex, addChunkDocuments } from "../vector/retrieval/lexical-index.js";

const MODULE_ID = "storySummary";
const LEXICAL_WARMUP_DEBOUNCE_MS = 3000;
export const AUTO_L0_BACKFILL_DELAY_MS = 5000;
const BACKGROUND_VISIBLE_GRACE_MS = 6000;
const VECTOR_RETRY_MAX_MS = 300000;
const VECTOR_WARNING_COOLDOWN_MS = 120000; // 2分钟内不重复提醒

export function createVectorMaintenance({ guard, isChatStale, isRuntimeActive, panelStats, executeSlashCommand, eventVectorSync }) {
    const { sendAnchorStatsToFrame, sendVectorStatsToFrame } = panelStats;
    const { collectMissingEventVectorPairs, repairMissingEventVectorsForCurrentChat } = eventVectorSync;

    let lexicalWarmupTimer = null;
    let autoL0BackfillTimer = null;
    let vectorIntegrityTimer = null;
    // 完整性检查连续失败时的退避间隔（纯内存态，切聊天/停用/卸载即清零）。
    let vectorIntegrityRetryDelayMs = 0;
    const pendingVectorMaintenanceByChat = new Map();
    let lastForegroundAt = Date.now();

    function getBackgroundQuietWaitMs() {
        if (document.hidden) return BACKGROUND_VISIBLE_GRACE_MS;
        const now = Date.now();
        return Math.max(0, BACKGROUND_VISIBLE_GRACE_MS - (now - lastForegroundAt));
    }

    function handleVisibilityChangeForBackground() {
        if (!document.hidden) {
            lastForegroundAt = Date.now();
        }
    }

    function handleViewportChangeForBackground() {}

    function isHostGenerating() {
        return !!document.body?.dataset?.generating;
    }

    /**
     * 后台任务（延迟维护、完整性检查）是否还该继续。
     * 模块已卸载、功能关闭、向量关闭或聊天已切走时一律停手。
     */
    function isBackgroundWorkLive(chatId) {
        return isRuntimeActive()
            && !!getSettings().storySummary?.enabled
            && !!getVectorConfig()?.enabled
            && !isChatStale(chatId);
    }

    function rememberVectorMaintenance(chatId, floor = null, reason = 'unknown') {
        if (!chatId) return;
        invalidateMaintenanceEpoch();
        let entry = pendingVectorMaintenanceByChat.get(chatId);
        if (!entry) {
            entry = { floors: new Set(), reasons: new Set(), updatedAt: 0 };
            pendingVectorMaintenanceByChat.set(chatId, entry);
        }
        if (Number.isFinite(floor) && floor >= 0) entry.floors.add(Number(floor));
        entry.reasons.add(reason);
        entry.updatedAt = Date.now();
    }

    function clearVectorMaintenance(chatId = null) {
        if (chatId) pendingVectorMaintenanceByChat.delete(chatId);
        else pendingVectorMaintenanceByChat.clear();
    }

    function deferVectorIntegrityUntilMaintenance(chatId) {
        const entry = pendingVectorMaintenanceByChat.get(chatId);
        if (!entry) return false;
        entry.reasons.add('integrity-check');
        return true;
    }

    function finishVectorMaintenance(chatId, { forceIntegrityCheck = false } = {}) {
        const entry = pendingVectorMaintenanceByChat.get(chatId);
        const shouldCheckIntegrity = forceIntegrityCheck || entry?.reasons?.has('integrity-check');
        clearVectorMaintenance(chatId);
        if (shouldCheckIntegrity && !isChatStale(chatId)) {
            scheduleVectorIntegrityCheck();
        }
    }

    /**
     * 维护任务被取消（配置切换 / 取消生成 / 卸载）时的收尾。
     * 必须保留待维护记录：里面可能挂着 deferVectorIntegrityUntilMaintenance 转交过来的
     * 'integrity-check' 责任，清掉就等于把那次完整性检查静默丢弃。
     */
    function retryVectorMaintenanceAfterCancel(chatId) {
        if (!isBackgroundWorkLive(chatId)) return;
        scheduleAutoL0Backfill(AUTO_L0_BACKFILL_DELAY_MS, chatId);
    }

    /**
     * 真实失败不在后台自循环。事实/派生数据本身就是下一次工作的唯一来源；清掉临时维护记录
     * 后立即恢复完整性检查，让缺失告警和其他层修复继续运行。下一条 AI 消息或用户手动操作
     * 会重新触发一次维护，而不会在 API 配置错误时无限占用队列。
     */
    function stopVectorMaintenanceAfterFailure(chatId) {
        if (!isBackgroundWorkLive(chatId)) return;
        clearVectorMaintenance(chatId);
        scheduleVectorIntegrityCheck(0);
    }

    function refreshEntityLexiconAndWarmup() {
        const vectorCfg = getVectorConfig();
        if (!vectorCfg?.enabled) return;

        const store = getSummaryStore();
        const { lexicon, displayMap, blockedTerms } = getEntityVocabulary(store, getContext());
        if (injectEntities(lexicon, displayMap, blockedTerms)) scheduleLexicalWarmup();
    }

    // 延迟向量维护：AI 后只调度，5 秒后统一维护 L0/L1，避免影响宿主收尾。
    async function maybeRunDelayedVectorMaintenance(scheduledChatId = null) {
        const { chatId, chat } = getContext();
        const targetChatId = scheduledChatId || chatId;
        if (!targetChatId || !chatId || targetChatId !== chatId || !chat?.length) return;

        if (isHostGenerating() || guard.isAnyRunning('summary', 'anchor', 'vector')) {
            scheduleAutoL0Backfill(AUTO_L0_BACKFILL_DELAY_MS, targetChatId);
            return;
        }

        const pendingEntry = pendingVectorMaintenanceByChat.get(chatId);

        let stats;
        let chunkStatus;
        let l0VectorStatus;
        try {
            stats = await getAnchorStats();
            chunkStatus = await getChunkBuildStatus();
            l0VectorStatus = await getL0VectorBuildStatus(chatId);
        } catch (e) {
            xbLog.error(MODULE_ID, "延迟向量维护状态检查失败", e);
            stopVectorMaintenanceAfterFailure(chatId);
            return;
        }
        const hasL0LlmWork = stats.pending > 0;
        const hasL0VectorWork = l0VectorStatus.success && l0VectorStatus.missing > 0;
        const hasL1Work = chunkStatus.pending > 0;

        if (!hasL0LlmWork && !hasL0VectorWork && !hasL1Work) {
            if (stats.incomplete > 0) {
                stopVectorMaintenanceAfterFailure(chatId);
                return;
            }
            finishVectorMaintenance(chatId);
            return;
        }

        if (!pendingEntry && (hasL0LlmWork || hasL0VectorWork)) {
            rememberVectorMaintenance(chatId, null, 'backfill');
        }

        const release = guard.acquire('anchor');
        if (!release) {
            scheduleAutoL0Backfill(AUTO_L0_BACKFILL_DELAY_MS, chatId);
            return;
        }

        try {
            const floorsText = pendingEntry?.floors?.size ? [...pendingEntry.floors].sort((a, b) => a - b).join(',') : '-';
            xbLog.info(MODULE_ID, `延迟向量维护开始 chat=${chatId} floors=${floorsText} l0Pending=${stats.pending} l0VectorMissing=${l0VectorStatus.missing || 0} l1Pending=${chunkStatus.pending}`);

            const writeResult = await runVectorWriteTask({
                chatId,
                kind: 'delayed-maintenance',
                scope: VECTOR_WRITE_SCOPES.EMBEDDING,
            }, async (writeSession) => {
                const vectorCfg = getVectorConfig();
                const currentChat = getContext()?.chat;
                const chatSnapshot = Array.isArray(currentChat) ? [...currentChat] : [];
                if (!vectorCfg?.enabled) {
                    return {
                        chunkResult: { success: true, status: 'disabled', built: 0 },
                        l0Result: null,
                        l0VectorResult: null,
                        deferred: false,
                        stale: false,
                        cancelled: false,
                        disabled: true,
                    };
                }
                if (isChatStale(chatId)) {
                    return {
                        chunkResult: { success: false, status: 'failed', code: 'stale_chat', built: 0 },
                        l0Result: null,
                        l0VectorResult: null,
                        deferred: false,
                        stale: true,
                        cancelled: false,
                    };
                }
                if (!isVectorWriteSessionCurrent(writeSession)) {
                    return { chunkResult: null, l0Result: null, l0VectorResult: null, deferred: false, stale: false, cancelled: true };
                }
                if (hasL0LlmWork || hasL0VectorWork || hasL1Work) {
                    if (isHostGenerating() || isChatStale(chatId)) {
                        return {
                            chunkResult: { success: true, status: 'up_to_date', built: 0 },
                            l0Result: null,
                            l0VectorResult: null,
                            deferred: !isChatStale(chatId),
                            stale: isChatStale(chatId),
                            cancelled: false,
                        };
                    }
                }
                const preparation = await runVectorMaintenance({
                    buildChunks: async () => {
                        if (!hasL1Work) return { success: true, status: 'up_to_date', built: 0 };
                        const result = await buildIncrementalChunks({
                            vectorConfig: vectorCfg,
                            targetChatId: chatId,
                            chatSnapshot,
                            signal: writeSession.signal,
                            shouldCancel: () => !isVectorWriteSessionCurrent(writeSession),
                        });
                        // These chunks are already committed. A later config
                        // cancellation must not suppress their lexical update.
                        if (result.built > 0 && !isChatStale(chatId)) {
                            addChunkDocuments(result.chunks, chatId);
                            scheduleLexicalWarmup();
                        }
                        return result;
                    },
                    extract: async () => {
                        if (!hasL0LlmWork) return { built: 0, failed: 0, llmFailed: 0, cancelled: false };
                        const preferredFloors = pendingEntry?.floors ? [...pendingEntry.floors] : [];
                        return await incrementalExtractAtoms(chatId, chatSnapshot, null, {
                            maxFloors: 20,
                            preferredFloors,
                            signal: writeSession.signal,
                            shouldCancel: () => !isVectorWriteSessionCurrent(writeSession),
                        });
                    },
                    vectorize: async (l0Result) => {
                        if (!l0VectorStatus.success) {
                            return { ...l0VectorStatus, success: false, status: 'failed' };
                        }
                        if (!hasL0VectorWork && Number(l0Result?.built || 0) <= 0) {
                            return { success: true, status: 'up_to_date', vectorized: 0 };
                        }
                        return await vectorizeMissingStateAtoms(chatId, null, {
                            vectorConfig: vectorCfg,
                            signal: writeSession.signal,
                            shouldCancel: () => !isVectorWriteSessionCurrent(writeSession),
                        });
                    },
                    inspect: getAnchorStats,
                    isCancelled: () => !isVectorWriteSessionCurrent(writeSession),
                });
                const { chunkResult, l0Result, l0VectorResult, l0Status } = preparation;
                if (preparation.cancelled) {
                    return { chunkResult, l0Result, l0VectorResult, l0Status, deferred: false, stale: false, cancelled: true };
                }

                return { chunkResult, l0Result, l0VectorResult, l0Status, deferred: false, stale: false, cancelled: false };
            });
            // writeResult 为空 = 任务在出队前就被取消（配置切换 / 取消生成 / 卸载）。
            if (!writeResult || writeResult.cancelled || writeResult.l0Result?.cancelled || writeResult.l0VectorResult?.cancelled) {
                retryVectorMaintenanceAfterCancel(chatId);
                return;
            }
            const { chunkResult, l0Result, l0VectorResult, l0Status, deferred, stale, disabled } = writeResult;

            if (disabled || stale) {
                clearVectorMaintenance(chatId);
                return;
            }

            if (deferred) {
                scheduleAutoL0Backfill(AUTO_L0_BACKFILL_DELAY_MS, chatId);
                return;
            }

            if (l0Result?.built > 0) {
                refreshEntityLexiconAndWarmup();
            }

            await sendAnchorStatsToFrame();
            await sendVectorStatsToFrame();
            const l0Failed = Number(l0Result?.llmFailed ?? l0Result?.failed ?? 0);
            const l0VectorFailed = Boolean(l0VectorResult && !l0VectorResult.success);
            if (chunkResult.success === false || l0Failed > 0 || l0VectorFailed) {
                // 真取消已在上面的 cancelled 分支返回，走到这里就是实打实的失败。
                // LLM 失败楼层与缺失 StateVector 都保留为可推导数据；本轮停止，避免后台循环扰民。
                stopVectorMaintenanceAfterFailure(chatId);
                xbLog.warn(MODULE_ID, `延迟向量维护未完成 l1=${chunkResult.success === false ? (chunkResult.code || 'unknown') : 'ok'} l0Failed=${l0Failed} l0Vector=${l0VectorResult?.code || 'ok'}，已停止自动重试并恢复完整性检查`);
                return;
            }
            if (Number(l0Status?.incomplete || 0) > 0) {
                if (Number(l0Status?.pending || 0) > 0) {
                    scheduleAutoL0Backfill(AUTO_L0_BACKFILL_DELAY_MS, chatId);
                    xbLog.info(MODULE_ID, `延迟向量维护完成一批，剩余 L0 楼层=${l0Status.incomplete}`);
                } else {
                    stopVectorMaintenanceAfterFailure(chatId);
                    xbLog.warn(MODULE_ID, `L0 仍有 ${l0Status.incomplete} 个终态失败楼层，已停止自动重试`);
                }
                return;
            }
            finishVectorMaintenance(chatId);

            xbLog.info(MODULE_ID, `延迟向量维护完成 l0=${l0Result?.built || 0} l1=${chunkResult.built || 0}`);
        } catch (e) {
            if (e?.name === 'AbortError') {
                retryVectorMaintenanceAfterCancel(chatId);
                return;
            }
            xbLog.error(MODULE_ID, "延迟向量维护失败", e);
            stopVectorMaintenanceAfterFailure(chatId);
        } finally {
            release();
        }
    }

    async function checkVectorIntegrityAndWarn({ allowEventRepair = true } = {}) {
        const vectorCfg = getVectorConfig();
        if (!vectorCfg?.enabled) return;
        if (guard.isAnyRunning('summary', 'vector', 'anchor')) {
            scheduleVectorIntegrityCheck(BACKGROUND_VISIBLE_GRACE_MS);
            return;
        }

        const { chat, chatId } = getContext();
        if (!chatId || !chat?.length) return;
        if (deferVectorIntegrityUntilMaintenance(chatId)) return;

        const snapshot = captureMaintenanceSnapshot(chatId);
        if (!snapshot) {
            scheduleVectorIntegrityCheck(BACKGROUND_VISIBLE_GRACE_MS);
            return;
        }

        const store = getSummaryStore();
        const totalFloors = chat.length;
        const anchorStats = await getAnchorStats();
        const sourceEvents = (store?.json?.events || []).map(event => ({
            id: event?.id,
            title: event?.title,
            summary: event?.summary,
        }));

        const meta = await getMeta(chatId);
        const fingerprint = getEngineFingerprint(vectorCfg);
        if (
            getContext()?.chatId !== chatId
            || !isMaintenanceSnapshotCurrent(snapshot)
        ) {
            scheduleVectorIntegrityCheck(BACKGROUND_VISIBLE_GRACE_MS);
            return;
        }

        const fingerprintMismatch = Boolean(meta.fingerprint && meta.fingerprint !== fingerprint);
        const chunkFloorGap = totalFloors - 1 - (meta.lastChunkFloor ?? -1);

        const l0VectorStatus = await getL0VectorBuildStatus(chatId, { vectorConfig: vectorCfg });
        if (
            getContext()?.chatId !== chatId
            || !isMaintenanceSnapshotCurrent(snapshot)
        ) {
            scheduleVectorIntegrityCheck(BACKGROUND_VISIBLE_GRACE_MS);
            return;
        }
        let missingEventPairs = [];
        if (!meta.fingerprint || meta.fingerprint === fingerprint) {
            missingEventPairs = await collectMissingEventVectorPairs(chatId, sourceEvents, fingerprint);
        }
        if (
            getContext()?.chatId !== chatId
            || !isMaintenanceSnapshotCurrent(snapshot)
        ) {
            scheduleVectorIntegrityCheck(BACKGROUND_VISIBLE_GRACE_MS);
            return;
        }
        if (allowEventRepair && missingEventPairs.length > 0) {
            await repairMissingEventVectorsForCurrentChat();
            if (getContext()?.chatId !== chatId) return;
            await checkVectorIntegrityAndWarn({ allowEventRepair: false });
            return;
        }
        const issues = buildVectorIntegrityIssues({
            fingerprintMismatch,
            chunkFloorGap,
            incompleteL0FloorCount: Number(anchorStats.incomplete || 0)
                + (l0VectorStatus.success ? Number(l0VectorStatus.missingFloors || 0) : 0),
            missingEventVectorCount: missingEventPairs.length,
        });

        if (issues.length > 0) {
            if (
                deferVectorIntegrityUntilMaintenance(chatId)
                || getContext()?.chatId !== chatId
                || !isMaintenanceSnapshotCurrent(snapshot)
            ) return;
            const eligible = issues.filter(issue => claimWarningCooldown(
                'integrity',
                chatId,
                issue.code,
                VECTOR_WARNING_COOLDOWN_MS,
            ));
            if (!eligible.length) return;
            const advice = eligible.some(issue => issue.code === 'fingerprint_mismatch')
                ? '向量模型已变化，请在“向量数据”中点击“完整重建”。'
                : '请在“向量数据”中点击“补齐缺漏”；锚点文本缺失则在“记忆锚点”中生成/补齐。';
            await executeSlashCommand(`/echo severity=warning 向量数据不完整：${eligible.map(issue => issue.message).join('、')}。${advice}`);
        }
    }

    function scheduleLexicalWarmup(delayMs = LEXICAL_WARMUP_DEBOUNCE_MS) {
        clearTimeout(lexicalWarmupTimer);
        const scheduledChatId = getContext().chatId || null;
        lexicalWarmupTimer = setTimeout(() => {
            lexicalWarmupTimer = null;
            if (isChatStale(scheduledChatId)) return;
            const quietWait = getBackgroundQuietWaitMs();
            if (quietWait > 0) {
                scheduleLexicalWarmup(quietWait);
                return;
            }
            warmupIndex();
        }, delayMs);
    }

    function scheduleAutoL0Backfill(delayMs = AUTO_L0_BACKFILL_DELAY_MS, chatIdOverride = null) {
        clearTimeout(autoL0BackfillTimer);
        const scheduledChatId = chatIdOverride || getContext().chatId || null;
        autoL0BackfillTimer = setTimeout(() => {
            autoL0BackfillTimer = null;
            if (isChatStale(scheduledChatId)) return;
            const quietWait = getBackgroundQuietWaitMs();
            if (quietWait > 0) {
                scheduleAutoL0Backfill(quietWait, scheduledChatId);
                return;
            }
            maybeRunDelayedVectorMaintenance(scheduledChatId);
        }, delayMs);
    }

    /** 完整性读取连续失败时 6s → 12s → 24s … 封顶 5min；成功后由调用方清零。 */
    function nextBackoffDelayMs(currentMs) {
        return currentMs ? Math.min(currentMs * 2, VECTOR_RETRY_MAX_MS) : BACKGROUND_VISIBLE_GRACE_MS;
    }

    function scheduleVectorIntegrityCheck(delayMs = 2000) {
        clearTimeout(vectorIntegrityTimer);
        const scheduledChatId = getContext().chatId || null;
        vectorIntegrityTimer = setTimeout(() => {
            vectorIntegrityTimer = null;
            if (isChatStale(scheduledChatId)) return;
            const quietWait = getBackgroundQuietWaitMs();
            if (quietWait > 0) {
                scheduleVectorIntegrityCheck(quietWait);
                return;
            }
            checkVectorIntegrityAndWarn().then(() => {
                vectorIntegrityRetryDelayMs = 0;
            }, (error) => {
                xbLog.warn(MODULE_ID, '向量完整性检查失败', error);
                if (isBackgroundWorkLive(scheduledChatId)) {
                    vectorIntegrityRetryDelayMs = nextBackoffDelayMs(vectorIntegrityRetryDelayMs);
                    scheduleVectorIntegrityCheck(vectorIntegrityRetryDelayMs);
                }
            });
        }, delayMs);
    }

    function clearDeferredVectorTasks() {
        clearTimeout(lexicalWarmupTimer);
        lexicalWarmupTimer = null;
        clearTimeout(autoL0BackfillTimer);
        autoL0BackfillTimer = null;
        clearTimeout(vectorIntegrityTimer);
        vectorIntegrityTimer = null;
        vectorIntegrityRetryDelayMs = 0;
        clearVectorMaintenance();
    }

    return {
        rememberVectorMaintenance,
        scheduleAutoL0Backfill,
        scheduleVectorIntegrityCheck,
        scheduleLexicalWarmup,
        refreshEntityLexiconAndWarmup,
        getBackgroundQuietWaitMs,
        handleVisibilityChangeForBackground,
        handleViewportChangeForBackground,
        clearDeferredVectorTasks,
    };
}
