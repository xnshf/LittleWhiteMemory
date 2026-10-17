// Shared query-weight contract for query construction and R1/R2 vector assembly.
export const FOCUS_BASE_WEIGHT = 0.55;
export const CONTEXT_BASE_WEIGHTS = [0.15, 0.30];
export const FOCUS_BASE_WEIGHT_R2 = 0.45;
export const CONTEXT_BASE_WEIGHTS_R2 = [0.10, 0.20];
export const HINTS_BASE_WEIGHT = 0.25;
export const LENGTH_FULL_THRESHOLD = 50;
export const LENGTH_MIN_FACTOR = 0.35;
export const FOCUS_MIN_NORMALIZED_WEIGHT = 0.35;

export function computeLengthFactor(charCount) {
    if (charCount >= LENGTH_FULL_THRESHOLD) return 1.0;
    if (charCount <= 0) return LENGTH_MIN_FACTOR;
    return LENGTH_MIN_FACTOR + (1.0 - LENGTH_MIN_FACTOR) * (charCount / LENGTH_FULL_THRESHOLD);
}

export function weightedAverageVectors(vectors, weights) {
    if (!vectors?.length || !weights?.length || vectors.length !== weights.length) return null;

    const dims = vectors[0].length;
    const result = new Array(dims).fill(0);

    for (let i = 0; i < vectors.length; i++) {
        const w = weights[i];
        const v = vectors[i];
        if (!v?.length) continue;
        for (let d = 0; d < dims; d++) {
            result[d] += w * v[d];
        }
    }

    return result;
}

function clampMinNormalizedWeight(weights, targetIdx, minWeight) {
    if (!weights?.length) return [];
    if (targetIdx < 0 || targetIdx >= weights.length) return weights;

    const current = weights[targetIdx];
    if (current >= minWeight) return weights;

    const otherSum = 1 - current;
    if (otherSum <= 0) {
        const out = new Array(weights.length).fill(0);
        out[targetIdx] = 1;
        return out;
    }

    const remain = 1 - minWeight;
    const scale = remain / otherSum;

    const out = weights.map((w, i) => (i === targetIdx ? minWeight : w * scale));
    const drift = 1 - out.reduce((a, b) => a + b, 0);
    out[targetIdx] += drift;
    return out;
}

export function computeSegmentWeights(segments) {
    if (!segments?.length) return [];

    const adjusted = segments.map(s => s.baseWeight * computeLengthFactor(s.charCount));
    const sum = adjusted.reduce((a, b) => a + b, 0);
    const normalized = sum <= 0
        ? segments.map(() => 1 / segments.length)
        : adjusted.map(w => w / sum);

    const focusIdx = segments.length - 1;
    return clampMinNormalizedWeight(normalized, focusIdx, FOCUS_MIN_NORMALIZED_WEIGHT);
}

export function computeR2Weights(segments, hintsSegment) {
    if (!segments?.length) return [];

    const contextCount = segments.length - 1;
    const r2Base = [];
    for (let i = 0; i < contextCount; i++) {
        const weightIdx = Math.max(0, CONTEXT_BASE_WEIGHTS_R2.length - contextCount + i);
        r2Base.push(CONTEXT_BASE_WEIGHTS_R2[weightIdx] || CONTEXT_BASE_WEIGHTS_R2[0]);
    }
    r2Base.push(FOCUS_BASE_WEIGHT_R2);

    const adjusted = r2Base.map((w, i) => w * computeLengthFactor(segments[i].charCount));

    if (hintsSegment) {
        adjusted.push(hintsSegment.baseWeight * computeLengthFactor(hintsSegment.charCount));
    }

    const sum = adjusted.reduce((a, b) => a + b, 0);
    const normalized = sum <= 0
        ? adjusted.map(() => 1 / adjusted.length)
        : adjusted.map(w => w / sum);

    const focusIdx = segments.length - 1;
    return clampMinNormalizedWeight(normalized, focusIdx, FOCUS_MIN_NORMALIZED_WEIGHT);
}
