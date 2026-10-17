import { xbLog } from '../../support/debug-core.js';
import { formatErrorDetails } from '../../support/error-details.js';

const MODULE_ID = 'recall';

export function observeRecallStage(observer, stage, ranked, value = undefined) {
    if (typeof observer !== 'function') return;
    try {
        observer({ stage, at: Date.now(), ranked, ...(value === undefined ? {} : { value }) });
    } catch (error) {
        xbLog.warn(MODULE_ID, `Recall stage observer failed: ${stage}`, error);
    }
}

export function recordExternalFailure(metrics, failure) {
    if (!metrics?.external?.failures || !failure) return;
    const details = failure.error?.embeddingFailure || failure;
    metrics.external.failures.push({
        stage: String(failure.stage || 'unknown'),
        kind: String(details.kind || 'unknown'),
        status: Number.isInteger(details.status) ? details.status : null,
        attempt: Number.isInteger(failure.attempt) ? failure.attempt : null,
        batchIndex: Number.isInteger(failure.batchIndex) ? failure.batchIndex : null,
        elapsedMs: Number.isFinite(failure.elapsedMs) ? failure.elapsedMs : null,
        message: failure.error ? formatErrorDetails(failure.error, { includeStack: false }) : '',
    });
}
