import { getContext } from '../../../../../extensions.js';
import { getVectorConfig } from '../summary/data/config.js';
import { getSummaryStore } from '../summary/data/store.js';
import { getEngineFingerprint } from '../vector/utils/embedder.js';
import { getMeta, getStorageStats } from '../vector/storage/chunk-store.js';
import { getChunkBuildStatus } from '../vector/pipeline/chunk-builder.js';
import { getAnchorStats } from '../vector/pipeline/state-integration.js';
import { getStateAtomsCount, getStateVectorsCount } from '../vector/storage/state-store.js';
import { getRecallRuntimeStats } from '../vector/runtime/runtime.js';

export function compactRecallRuntimeStatsForLog(statsList = getRecallRuntimeStats()) {
    if (!Array.isArray(statsList) || !statsList.length) return "[]";
    return statsList.map((item) => {
        const stats = item?.stats || item || {};
        return [
            `chat=${stats.chatId || "-"}`,
            `backend=${stats.backend || "-"}`,
            `owner=${stats.owner || "-"}`,
            `status=${stats.status || "-"}`,
            `ready=${stats.ready ? 1 : 0}`,
            `warming=${stats.warming ? 1 : 0}`,
            `chunks=${stats.chunks ?? "-"}`,
            `l1v=${stats.chunkVectors ?? "-"}`,
            `l2v=${stats.eventVectors ?? "-"}`,
            `l0v=${stats.stateVectors ?? "-"}`,
            `ver=${stats.version ?? "-"}`,
            `err=${stats.lastError || "-"}`,
        ].join(" ");
    }).join(" | ");
}

function getCurrentRecallRuntimeStat(chatId, statsList = getRecallRuntimeStats()) {
    const list = Array.isArray(statsList) ? statsList : [];
    const current = list.find((item) => String(item?.chatId || "") === String(chatId || ""));
    if (current) return current;
    return {
        chatId: chatId || "",
        backend: "uninitialized",
        owner: "none",
        ready: false,
        warming: false,
        status: "cold",
        lastError: null,
        chunks: 0,
        chunkVectors: 0,
        eventVectors: 0,
        stateVectors: 0,
    };
}

export function createPanelStats({ postToFrame }) {
    async function sendVectorStatsToFrame() {
        const { chatId, chat } = getContext();
        if (!chatId) return;

        const store = getSummaryStore();
        const eventCount = store?.json?.events?.length || 0;
        const stats = await getStorageStats(chatId);
        const chunkStatus = await getChunkBuildStatus();
        const totalMessages = chat?.length || 0;
        const stateVectorsCount = await getStateVectorsCount(chatId);

        const cfg = getVectorConfig();
        let mismatch = false;
        if (cfg?.enabled && (stats.eventVectors > 0 || stats.chunks > 0)) {
            const fingerprint = getEngineFingerprint(cfg);
            const meta = await getMeta(chatId);
            mismatch = meta.fingerprint && meta.fingerprint !== fingerprint;
        }
        if (getContext().chatId !== chatId) return;

        postToFrame({
            type: "VECTOR_STATS",
            stats: {
                eventCount,
                eventVectors: stats.eventVectors,
                chunkCount: stats.chunkVectors,
                builtFloors: chunkStatus.builtFloors,
                totalFloors: chunkStatus.totalFloors,
                totalMessages,
                stateVectors: stateVectorsCount,
                recallRuntime: getCurrentRecallRuntimeStat(chatId),
            },
            mismatch,
        });
    }

    async function sendAnchorStatsToFrame() {
        const chatId = getContext().chatId;
        if (!chatId) return;
        const stats = await getAnchorStats();
        if (getContext().chatId !== chatId) return;
        const atomsCount = getStateAtomsCount();
        postToFrame({ type: "ANCHOR_STATS", stats: { ...stats, atomsCount } });
    }

    return { sendVectorStatsToFrame, sendAnchorStatsToFrame };
}
