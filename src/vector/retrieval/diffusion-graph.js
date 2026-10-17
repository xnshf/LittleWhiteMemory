// Graph construction: WHAT and R semantic create candidates; WHO/WHERE only reweight.
import { CONFIG } from './diffusion-config.js';
import { normalize, cosineSimilarity } from './diffusion-math.js';

const MODULE_ID = 'diffusion';
const NOOP_LOGGER = { info() {} };

/**
 * Endpoint entity set from edges.s/edges.t (used for candidate pair generation).
 * @param {object} atom
 * @param {Set<string>} excludeEntities - entities to exclude (e.g. name1)
 * @returns {Set<string>}
 */
function extractEntities(atom, excludeEntities = new Set()) {
    const set = new Set();
    for (const e of (atom.edges || [])) {
        const s = normalize(e?.s);
        const t = normalize(e?.t);
        if (s && !excludeEntities.has(s)) set.add(s);
        if (t && !excludeEntities.has(t)) set.add(t);
    }
    return set;
}

/**
 * WHAT channel: interaction pairs "A↔B" (direction-insensitive).
 * @param {object} atom
 * @param {Set<string>} excludeEntities
 * @returns {Set<string>}
 */
function extractInteractionPairs(atom, excludeEntities = new Set()) {
    const set = new Set();
    for (const e of (atom.edges || [])) {
        const s = normalize(e?.s);
        const t = normalize(e?.t);
        if (s && t && !excludeEntities.has(s) && !excludeEntities.has(t)) {
            const pair = [s, t].sort().join('\u2194');
            set.add(pair);
        }
    }
    return set;
}

/**
 * WHERE channel: normalized location string
 * @param {object} atom
 * @returns {string} empty string if absent
 */
function extractLocation(atom) {
    return normalize(atom.where);
}

function getFloorDistance(a, b) {
    const fa = Number(a?.floor || 0);
    const fb = Number(b?.floor || 0);
    return Math.abs(fa - fb);
}

function getTimeScore(distance) {
    return Math.exp(-distance / CONFIG.TIME_DECAY_DIVISOR);
}

/**
 * Jaccard index: |A∩B| / |A∪B| (Jaccard 1912)
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0..1
 */
function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
    for (const x of smaller) {
        if (larger.has(x)) inter++;
    }
    const union = a.size + b.size - inter;
    return union > 0 ? inter / union : 0;
}

/**
 * Overlap coefficient: |A∩B| / min(|A|,|B|) (Szymkiewicz-Simpson 1934)
 * Used for directed pairs where set sizes are small (1-3); Jaccard
 * over-penalizes small-set asymmetry.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0..1
 */
function overlapCoefficient(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
    for (const x of smaller) {
        if (larger.has(x)) inter++;
    }
    return inter / smaller.size;
}

// ═══════════════════════════════════════════════════════════════════════════
// Graph construction
//
// Candidate pairs discovered via WHAT inverted index and R semantic top-k.
// WHO/WHERE are reweight-only signals and never create candidate pairs.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pre-extract features for all atoms
 * @param {object[]} allAtoms
 * @param {Set<string>} excludeEntities
 * @returns {object[]} feature objects with entities/interactionPairs/location
 */
function extractAllFeatures(allAtoms, excludeEntities = new Set()) {
    return allAtoms.map(atom => ({
        entities: extractEntities(atom, excludeEntities),
        interactionPairs: extractInteractionPairs(atom, excludeEntities),
        location: extractLocation(atom),
    }));
}

/**
 * Build inverted index: value → list of atom indices
 * @param {object[]} features
 * @returns {{ whatIndex: Map, locationFreq: Map }}
 */
function buildInvertedIndices(features) {
    const whatIndex = new Map();
    const locationFreq = new Map();

    for (let i = 0; i < features.length; i++) {
        for (const pair of features[i].interactionPairs) {
            if (!whatIndex.has(pair)) whatIndex.set(pair, []);
            whatIndex.get(pair).push(i);
        }
        const loc = features[i].location;
        if (loc) locationFreq.set(loc, (locationFreq.get(loc) || 0) + 1);
    }

    return { whatIndex, locationFreq };
}

/**
 * Collect candidate pairs from inverted index
 * @param {Map} index - value → [atomIndex, ...]
 * @param {Set<number>} pairSet - packed pair collector
 * @param {number} N - total atom count (for pair packing)
 * @param {object[]} allAtoms - supplies the same floor window as R semantics
 * @returns {number} skipped pair occurrences, before cross-group deduplication
 */
function collectPairsFromIndex(index, pairSet, N, allAtoms) {
    let skippedOccurrences = 0;
    for (const indices of index.values()) {
        const byFloor = indices.map(idx => ({ idx, floor: Number(allAtoms[idx]?.floor || 0) }))
            .sort((a, b) => a.floor - b.floor);
        const pairs = [];
        for (let a = 0; a < byFloor.length; a++) {
            for (let b = a + 1; b < byFloor.length; b++) {
                if (byFloor[b].floor - byFloor[a].floor > CONFIG.TIME_WINDOW_MAX) break;
                const lo = Math.min(byFloor[a].idx, byFloor[b].idx);
                const hi = Math.max(byFloor[a].idx, byFloor[b].idx);
                pairs.push(lo * N + hi);
            }
        }
        skippedOccurrences += indices.length * (indices.length - 1) / 2 - pairs.length;
        // Restore the original source-index traversal order, even for shuffled
        // floors. PPR must see the same edge order and floating-point sums.
        pairs.sort((a, b) => a - b);
        for (const pair of pairs) pairSet.add(pair);
    }
    return skippedOccurrences;
}

/**
 * Build weighted undirected graph over L0 atoms.
 *
 * @param {object[]} allAtoms
 * @param {object[]} stateVectors
 * @param {Set<string>} excludeEntities
 * @returns {{ neighbors: object[][], edgeCount: number, channelStats: object, buildTime: number }}
 */
export function buildGraph(allAtoms, stateVectors = [], excludeEntities = new Set(), logger = NOOP_LOGGER) {
    const N = allAtoms.length;
    const T0 = performance.now();

    const features = extractAllFeatures(allAtoms, excludeEntities);
    const { whatIndex, locationFreq } = buildInvertedIndices(features);

    // Candidate pairs: WHAT + R semantic
    const pairSetByWhat = new Set();
    const pairSetByRSem = new Set();
    const rSemByPair = new Map();
    const pairSet = new Set();
    const whatWindowSkippedOccurrences = collectPairsFromIndex(whatIndex, pairSetByWhat, N, allAtoms);

    const rVectorByAtomId = new Map(
        (stateVectors || [])
            .filter(v => v?.atomId && v?.rVector?.length)
            .map(v => [v.atomId, v.rVector])
    );
    const rVectors = allAtoms.map(a => rVectorByAtomId.get(a.atomId) || null);

    const directedNeighbors = Array.from({ length: N }, () => []);
    let rSemSimSum = 0;
    let rSemSimCount = 0;
    let topKPrunedPairs = 0;

    // Enumerate only pairs within floor window to avoid O(N^2) full scan.
    const sortedByFloor = allAtoms
        .map((atom, idx) => ({ idx, floor: Number(atom?.floor || 0) }))
        .sort((a, b) => a.floor - b.floor);

    for (let left = 0; left < sortedByFloor.length; left++) {
        const i = sortedByFloor[left].idx;
        const baseFloor = sortedByFloor[left].floor;

        for (let right = left + 1; right < sortedByFloor.length; right++) {
            const floorDelta = sortedByFloor[right].floor - baseFloor;
            if (floorDelta > CONFIG.TIME_WINDOW_MAX) break;

            const j = sortedByFloor[right].idx;
            const vi = rVectors[i];
            const vj = rVectors[j];
            if (!vi?.length || !vj?.length) continue;

            const sim = cosineSimilarity(vi, vj);
            if (sim < CONFIG.R_SEM_MIN_SIM) continue;

            directedNeighbors[i].push({ target: j, sim });
            directedNeighbors[j].push({ target: i, sim });
            rSemSimSum += sim;
            rSemSimCount++;
        }
    }

    for (let i = 0; i < N; i++) {
        const arr = directedNeighbors[i];
        if (!arr.length) continue;
        arr.sort((a, b) => b.sim - a.sim);
        if (arr.length > CONFIG.R_SEM_TOPK) {
            topKPrunedPairs += arr.length - CONFIG.R_SEM_TOPK;
        }
        for (const n of arr.slice(0, CONFIG.R_SEM_TOPK)) {
            const lo = Math.min(i, n.target);
            const hi = Math.max(i, n.target);
            const packed = lo * N + hi;
            pairSetByRSem.add(packed);
            const prev = rSemByPair.get(packed) || 0;
            if (n.sim > prev) rSemByPair.set(packed, n.sim);
        }
    }
    for (const p of pairSetByWhat) pairSet.add(p);
    for (const p of pairSetByRSem) pairSet.add(p);

    // Compute edge weights for all candidates
    const neighbors = Array.from({ length: N }, () => []);
    let edgeCount = 0;
    const channelStats = { what: 0, where: 0, rSem: 0, who: 0 };
    let reweightWhoUsed = 0;
    let reweightWhereUsed = 0;

    for (const packed of pairSet) {
        const i = Math.floor(packed / N);
        const j = packed % N;

        const distance = getFloorDistance(allAtoms[i], allAtoms[j]);
        const wTime = getTimeScore(distance);

        const fi = features[i];
        const fj = features[j];

        const wWhat = overlapCoefficient(fi.interactionPairs, fj.interactionPairs);
        const wRSem = rSemByPair.get(packed) || 0;
        const wWho = jaccard(fi.entities, fj.entities);
        let wWhere = 0.0;
        if (fi.location && fi.location === fj.location) {
            const freq = locationFreq.get(fi.location) || 1;
            const damp = Math.max(
                CONFIG.WHERE_FREQ_DAMP_MIN,
                Math.min(1, CONFIG.WHERE_FREQ_DAMP_PIVOT / Math.max(1, freq))
            );
            wWhere = damp;
        }

        const weight =
            CONFIG.GAMMA.what * wWhat +
            CONFIG.GAMMA.rSem * wRSem +
            CONFIG.GAMMA.who * wWho +
            CONFIG.GAMMA.where * wWhere +
            CONFIG.GAMMA.time * wTime;

        if (weight > 0) {
            neighbors[i].push({ target: j, weight });
            neighbors[j].push({ target: i, weight });
            edgeCount++;

            if (wWhat > 0) channelStats.what++;
            if (wRSem > 0) channelStats.rSem++;
            if (wWho > 0) channelStats.who++;
            if (wWhere > 0) channelStats.where++;
            if (wWho > 0) reweightWhoUsed++;
            if (wWhere > 0) reweightWhereUsed++;
        }
    }

    const buildTime = Math.round(performance.now() - T0);

    logger.info(MODULE_ID,
        `Graph: ${N} nodes, ${edgeCount} edges ` +
        `(candidate_by_what=${pairSetByWhat.size} candidate_by_r_sem=${pairSetByRSem.size}) ` +
        `(what=${channelStats.what} r_sem=${channelStats.rSem} who=${channelStats.who} where=${channelStats.where}) ` +
        `(reweight_who_used=${reweightWhoUsed} reweight_where_used=${reweightWhereUsed}) ` +
        `(what_window_skipped_occurrences=${whatWindowSkippedOccurrences} topk_pruned=${topKPrunedPairs}) ` +
        `(${buildTime}ms)`
    );

    const totalPairs = N > 1 ? (N * (N - 1)) / 2 : 0;
    const edgeDensity = totalPairs > 0 ? Number((edgeCount / totalPairs * 100).toFixed(2)) : 0;

    return {
        neighbors,
        edgeCount,
        channelStats,
        buildTime,
        candidatePairs: pairSet.size,
        pairsFromWhat: pairSetByWhat.size,
        pairsFromRSem: pairSetByRSem.size,
        rSemAvgSim: rSemSimCount ? Number((rSemSimSum / rSemSimCount).toFixed(3)) : 0,
        whatWindowSkippedOccurrences,
        topKPrunedPairs,
        reweightWhoUsed,
        reweightWhereUsed,
        edgeDensity,
    };
}
