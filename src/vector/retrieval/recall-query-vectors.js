import { embed } from '../utils/embedder.js';
import { xbLog } from '../../support/debug-core.js';
import { throwIfSignalAborted, waitForAbortableDelay } from '../../support/abort-utils.js';
import { recordRecallFallback } from '../../runtime/recall-diagnostics.js';
import { finalizeMetricsTiming } from './metrics.js';
import { recordExternalFailure } from './recall-stage.js';
import { weightedAverageVectors, computeSegmentWeights, computeR2Weights } from './query-weights.js';

const MODULE_ID = 'recall';

// Only query embedding/assembly lives here; the coordinator owns retrieval and leases.
export async function buildRound1QueryVector(querySegments, vectorConfig, { metrics, diagnostics, signal, totalStart }) {
    const segmentTexts = querySegments.map(s => s.text);
    let r1Vectors;
    if (diagnostics) diagnostics.stage = 'round1-embed';
    const T_R1_Embed_Start = performance.now();
    try {
        try {
            r1Vectors = await embed(segmentTexts, vectorConfig, { timeout: 10000, signal });
        } catch (e1) {
            throwIfSignalAborted(signal);
            recordExternalFailure(metrics, { stage: 'round1-embed', kind: 'request', attempt: 1, error: e1 });
            xbLog.warn(MODULE_ID, 'Round 1 向量化失败，500ms 后重试', e1);
            const retryWaitStart = performance.now();
            try {
                await waitForAbortableDelay(500, signal);
            } finally {
                metrics.timing.round1EmbedRetryWait = Math.round(performance.now() - retryWaitStart);
            }
            throwIfSignalAborted(signal);
            try {
                r1Vectors = await embed(segmentTexts, vectorConfig, { timeout: 15000, signal });
            } catch (e2) {
                throwIfSignalAborted(signal);
                recordExternalFailure(metrics, { stage: 'round1-embed', kind: 'request', attempt: 2, error: e2 });
                xbLog.error(MODULE_ID, 'Round 1 向量化重试仍失败', e2);
                const error = new Error('Embedding request failed after retry', { cause: e2 });
                error.code = 'RECALL_EMBEDDING_FAILED';
                error.stage = 'round1-embed';
                error.attempts = 2;
                throw error;
            }
        }
    } finally {
        metrics.timing.round1Embed = Math.round(performance.now() - T_R1_Embed_Start);
    }

    if (!r1Vectors?.length || r1Vectors.some(v => !v?.length)) {
        recordExternalFailure(metrics, { stage: 'round1-embed', kind: 'invalid-vector', attempt: 1 });
        if (metrics?.timing) finalizeMetricsTiming(metrics, performance.now() - totalStart);
        const error = new Error('Embedding API returned an empty query vector');
        error.code = 'RECALL_EMBEDDING_INVALID_RESPONSE';
        error.stage = 'round1-embed';
        throw error;
    }

    const r1Weights = computeSegmentWeights(querySegments);
    const queryVector_v0 = weightedAverageVectors(r1Vectors, r1Weights);

    if (metrics) {
        metrics.query.segmentWeights = r1Weights.map(w => Number(w.toFixed(3)));
    }

    return { r1Vectors, r1Weights, queryVector_v0 };
}

export async function buildRound2QueryVector(bundle, r1Vectors, queryVector_v0, vectorConfig, { metrics, diagnostics, signal }) {
    let queryVector_v1;

    if (bundle.hintsSegment) {
        if (diagnostics) diagnostics.stage = 'round2-embed';
        const T_R2_Embed_Start = performance.now();
        try {
            const [hintsVec] = await embed([bundle.hintsSegment.text], vectorConfig, { timeout: 10000, signal });
            metrics.timing.round2Embed = Math.round(performance.now() - T_R2_Embed_Start);

            if (hintsVec?.length) {
                const r2Weights = computeR2Weights(bundle.querySegments, bundle.hintsSegment);
                queryVector_v1 = weightedAverageVectors([...r1Vectors, hintsVec], r2Weights);

                if (metrics) {
                    metrics.query.r2Weights = r2Weights.map(w => Number(w.toFixed(3)));
                }

                xbLog.info(MODULE_ID,
                    `Round 2 weights: [${r2Weights.map(w => w.toFixed(2)).join(',')}]`
                );
            } else {
                recordExternalFailure(metrics, {
                    stage: 'round2-embed',
                    kind: 'invalid-vector',
                    attempt: 1,
                    elapsedMs: metrics.timing.round2Embed,
                });
                queryVector_v1 = queryVector_v0;
                recordRecallFallback(diagnostics, 'round2-embed', '空提示向量，使用第一轮向量');
            }
        } catch (e) {
            metrics.timing.round2Embed = Math.round(performance.now() - T_R2_Embed_Start);
            throwIfSignalAborted(signal);
            recordExternalFailure(metrics, {
                stage: 'round2-embed',
                kind: 'request',
                attempt: 1,
                elapsedMs: metrics.timing.round2Embed,
                error: e,
            });
            xbLog.warn(MODULE_ID, 'Round 2 hints 向量化失败，降级使用 Round 1 向量', e);
            queryVector_v1 = queryVector_v0;
            recordRecallFallback(diagnostics, 'round2-embed', e);
        }
    } else {
        queryVector_v1 = queryVector_v0;
    }

    return queryVector_v1;
}
