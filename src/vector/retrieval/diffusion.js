// ═══════════════════════════════════════════════════════════════════════════
// diffusion.js - PPR Graph Diffusion (Personalized PageRank)
//
// Spreads activation from seed L0 atoms through entity co-occurrence graph
// to discover narratively-connected but semantically-distant memories.
//
// Pipeline position: recall.js Stage 7.5
//   Input:  seeds (reranked L0 from Stage 6)
//   Output: additional L0 atoms → merged into l0Selected
//
// Algorithm:
//   1. Build undirected weighted graph over all L0 atoms
//      Candidate edges: WHAT + R semantic; WHO/WHERE are reweight-only
//   2. Personalized PageRank (Power Iteration)
//      Seeds weighted by rerankScore — Haveliwala (2002) topic-sensitive variant
//      α = 0.15 restart probability — Page et al. (1998)
//   3. Post-verification (Dense Cosine Gate)
//      Exclude seeds, cosine ≥ 0.45, final = PPR_norm × cosine ≥ 0.10
//
// References:
//   Page et al. "The PageRank Citation Ranking" (1998)
//   Haveliwala "Topic-Sensitive PageRank" (IEEE TKDE 2003)
//   Langville & Meyer "Eigenvector Methods for Web IR" (SIAM Review 2005)
//   Sun et al. "GraftNet" (EMNLP 2018)
//   Jaccard "Étude comparative de la distribution florale" (1912)
//   Szymkiewicz "Une contribution statistique" (1934) — Overlap coefficient
//   Rimmon-Kenan "Narrative Fiction" (2002) — Channel weight rationale
//
// Core PPR iteration aligned with NetworkX pagerank():
//   github.com/networkx/networkx — algorithms/link_analysis/pagerank_alg.py
// ═══════════════════════════════════════════════════════════════════════════

import { CONFIG } from './diffusion-config.js';
import { buildGraph } from './diffusion-graph.js';
import { normalize, cosineSimilarity } from './diffusion-math.js';

const MODULE_ID = 'diffusion';
const NOOP_LOGGER = { info() {} };

// ═══════════════════════════════════════════════════════════════════════════
// PPR: Seed vector construction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build personalization vector s from seeds, weighted by rerankScore.
 * Haveliwala (2002): non-uniform personalization improves topic sensitivity.
 *
 * @param {object[]} seeds - seed L0 entries with atomId and rerankScore
 * @param {Map<string, number>} idToIdx - atomId → array index
 * @param {number} N - total node count
 * @returns {Float64Array} personalization vector (L1-normalized, sums to 1)
 */
function buildSeedVector(seeds, idToIdx, N) {
    const s = new Float64Array(N);
    let total = 0;

    for (const seed of seeds) {
        const idx = idToIdx.get(seed.atomId);
        if (idx == null) continue;

        const score = Math.max(0, seed.rerankScore || seed.similarity || 0);
        s[idx] += score;
        total += score;
    }

    // L1 normalize to probability distribution
    if (total > 0) {
        for (let i = 0; i < N; i++) s[i] /= total;
    }

    return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// PPR: Column normalization + dangling node detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Column-normalize adjacency into transition matrix W.
 *
 * Column j of W: W_{ij} = weight(i,j) / Σ_k weight(k,j)
 * Dangling nodes (no outgoing edges): handled in powerIteration
 * via redistribution to personalization vector s.
 * (Langville & Meyer 2005, §4.1)
 *
 * @param {object[][]} neighbors - neighbors[j] = [{target, weight}, ...]
 * @param {number} N
 * @returns {{ columns: object[][], dangling: number[] }}
 */
function columnNormalize(neighbors, N) {
    const columns = Array.from({ length: N }, () => []);
    const dangling = [];

    for (let j = 0; j < N; j++) {
        const edges = neighbors[j];

        let sum = 0;
        for (let e = 0; e < edges.length; e++) sum += edges[e].weight;

        if (sum <= 0) {
            dangling.push(j);
            continue;
        }

        const col = columns[j];
        for (let e = 0; e < edges.length; e++) {
            col.push({ target: edges[e].target, prob: edges[e].weight / sum });
        }
    }

    return { columns, dangling };
}

// ═══════════════════════════════════════════════════════════════════════════
// PPR: Power Iteration
//
// Aligned with NetworkX pagerank() (pagerank_alg.py):
//
//   NetworkX "alpha" = damping = our (1 − α)
//   NetworkX "1-alpha" = teleportation = our α
//
//   Per iteration:
//     π_new[i] = α·s[i] + (1−α)·( Σ_j W_{ij}·π[j] + dangling_sum·s[i] )
//
// Convergence: Perron-Frobenius theorem guarantees unique stationary
// distribution for irreducible aperiodic column-stochastic matrix.
// Rate: ‖π^(t+1) − π^t‖₁ ≤ (1−α)^t (geometric).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run PPR Power Iteration.
 *
 * @param {object[][]} columns - column-normalized transition matrix
 * @param {Float64Array} s - personalization vector (sums to 1)
 * @param {number[]} dangling - dangling node indices
 * @param {number} N - node count
 * @returns {{ pi: Float64Array, iterations: number, finalError: number }}
 */
function powerIteration(columns, s, dangling, N) {
    const alpha = CONFIG.ALPHA;
    const d = 1 - alpha;       // damping factor = prob of following edges
    const epsilon = CONFIG.EPSILON;
    const maxIter = CONFIG.MAX_ITER;

    // Initialize π to personalization vector
    let pi = new Float64Array(N);
    for (let i = 0; i < N; i++) pi[i] = s[i];

    let iterations = 0;
    let finalError = 0;

    for (let iter = 0; iter < maxIter; iter++) {
        const piNew = new Float64Array(N);

        // Dangling mass: probability at nodes with no outgoing edges
        // redistributed to personalization vector (Langville & Meyer 2005)
        let danglingSum = 0;
        for (let k = 0; k < dangling.length; k++) {
            danglingSum += pi[dangling[k]];
        }

        // Sparse matrix-vector product: (1−α) · W · π
        for (let j = 0; j < N; j++) {
            const pj = pi[j];
            if (pj === 0) continue;

            const col = columns[j];
            const dpj = d * pj;
            for (let e = 0; e < col.length; e++) {
                piNew[col[e].target] += dpj * col[e].prob;
            }
        }

        // Restart + dangling contribution:
        // α · s[i] + (1−α) · danglingSum · s[i]
        const restartCoeff = alpha + d * danglingSum;
        for (let i = 0; i < N; i++) {
            piNew[i] += restartCoeff * s[i];
        }

        // L1 convergence check
        let l1 = 0;
        for (let i = 0; i < N; i++) {
            l1 += Math.abs(piNew[i] - pi[i]);
        }

        pi = piNew;
        iterations = iter + 1;
        finalError = l1;

        if (l1 < epsilon) break;
    }

    return { pi, iterations, finalError };
}

// ═══════════════════════════════════════════════════════════════════════════
// Post-verification: Dense Cosine Gate
//
// PPR measures graph-structural relevance ("same characters").
// Cosine gate measures semantic relevance ("related to current topic").
// Product combination ensures both dimensions are satisfied
// (CombMNZ — Fox & Shaw, TREC-2 1994).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Filter PPR-activated nodes by semantic relevance.
 *
 * For each non-seed node with PPR > 0:
 *   1. cosine(queryVector, stateVector) ≥ COSINE_GATE
 *   2. finalScore = PPR_normalized × cosine ≥ SCORE_FLOOR
 *   3. Top DIFFUSION_CAP by finalScore
 *
 * @param {Float64Array} pi - PPR stationary distribution
 * @param {string[]} atomIds - index → atomId
 * @param {Map<string, object>} atomById - atomId → atom object
 * @param {Set<string>} seedAtomIds - seed atomIds (excluded from output)
 * @param {Map<string, Float32Array>} vectorMap - atomId → embedding vector
 * @param {Float32Array|number[]} queryVector - R2 weighted query vector
 * @returns {{ diffused: object[], gateStats: object }}
 */
function postVerify(pi, atomIds, atomById, seedAtomIds, vectorMap, queryVector) {
    const N = atomIds.length;
    const gateStats = { passed: 0, filtered: 0, noVector: 0 };

    // Find max PPR score among non-seed nodes (for normalization)
    let maxPPR = 0;
    for (let i = 0; i < N; i++) {
        if (pi[i] > 0 && !seedAtomIds.has(atomIds[i])) {
            if (pi[i] > maxPPR) maxPPR = pi[i];
        }
    }

    if (maxPPR <= 0) {
        return { diffused: [], gateStats };
    }

    const candidates = [];

    for (let i = 0; i < N; i++) {
        const atomId = atomIds[i];

        // Skip seeds and zero-probability nodes
        if (seedAtomIds.has(atomId)) continue;
        if (pi[i] <= 0) continue;

        // Require state vector for cosine verification
        const vec = vectorMap.get(atomId);
        if (!vec?.length) {
            gateStats.noVector++;
            continue;
        }

        // Cosine gate
        const cos = cosineSimilarity(queryVector, vec);
        if (cos < CONFIG.COSINE_GATE) {
            gateStats.filtered++;
            continue;
        }

        // Final score = PPR_normalized × cosine
        const pprNorm = pi[i] / maxPPR;
        const finalScore = pprNorm * cos;

        if (finalScore < CONFIG.SCORE_FLOOR) {
            gateStats.filtered++;
            continue;
        }

        gateStats.passed++;

        const atom = atomById.get(atomId);
        if (!atom) continue;

        candidates.push({
            atomId,
            floor: atom.floor,
            atom,
            finalScore,
            pprScore: pi[i],
            pprNormalized: pprNorm,
            cosine: cos,
        });
    }

    // Sort by finalScore descending, cap at DIFFUSION_CAP
    candidates.sort((a, b) => b.finalScore - a.finalScore);
    const diffused = candidates.slice(0, CONFIG.DIFFUSION_CAP);

    return { diffused, gateStats };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Spread activation from seed L0 atoms through entity co-occurrence graph.
 *
 * Called from recall.js Stage 7.5, after locateAndPullEvidence and before
 * Causation Trace. Results are merged into l0Selected and consumed by
 * prompt.js through existing budget/formatting pipeline (zero downstream changes).
 *
 * @param {object[]} seeds - l0Selected from recall Stage 6
 *   Each: { atomId, rerankScore, similarity, atom, ... }
 * @param {object[]} allAtoms - getStateAtoms() result
 *   Each: { atomId, floor, semantic, edges, where }
 * @param {object[]} stateVectors - getAllStateVectors() result
 *   Each: { atomId, floor, vector: Float32Array, rVector?: Float32Array }
 * @param {Float32Array|number[]} queryVector - R2 weighted query vector
 * @param {object|null} metrics - metrics object (optional, mutated in-place)
 * @returns {object[]} Additional L0 atoms for l0Selected
 *   Each: { atomId, floor, atom, finalScore, pprScore, pprNormalized, cosine }
 */
export function diffuseFromSeeds(seeds, allAtoms, stateVectors, queryVector, metrics, options = {}) {
    const T0 = performance.now();
    const logger = options?.logger || NOOP_LOGGER;

    // ─── Early exits ─────────────────────────────────────────────────

    if (!seeds?.length || !allAtoms?.length || !queryVector?.length) {
        fillMetricsEmpty(metrics);
        return [];
    }

    // Align with entity-lexicon hard rule: exclude name1 from graph features.
    const { name1 } = options || {};
    const excludeEntities = new Set();
    if (name1) excludeEntities.add(normalize(name1));

    // ─── 1. Build atom index ─────────────────────────────────────────

    const T_Index = performance.now();
    const atomById = new Map();
    const atomIds = [];
    const idToIdx = new Map();

    for (let i = 0; i < allAtoms.length; i++) {
        const a = allAtoms[i];
        atomById.set(a.atomId, a);
        atomIds.push(a.atomId);
        idToIdx.set(a.atomId, i);
    }

    const N = allAtoms.length;
    const indexTime = Math.round(performance.now() - T_Index);

    // Validate seeds against atom index
    const validSeeds = seeds.filter(s => idToIdx.has(s.atomId));
    const seedAtomIds = new Set(validSeeds.map(s => s.atomId));

    if (!validSeeds.length) {
        fillMetricsEmpty(metrics);
        return [];
    }

    // ─── 2. Build graph ──────────────────────────────────────────────

    const graph = buildGraph(allAtoms, stateVectors, excludeEntities, logger);

    if (graph.edgeCount === 0) {
        fillMetrics(metrics, {
            seedCount: validSeeds.length,
            graphNodes: N,
            graphEdges: 0,
            channelStats: graph.channelStats,
            candidatePairs: graph.candidatePairs,
            pairsFromWhat: graph.pairsFromWhat,
            pairsFromRSem: graph.pairsFromRSem,
            rSemAvgSim: graph.rSemAvgSim,
            whatWindowSkippedOccurrences: graph.whatWindowSkippedOccurrences,
            topKPrunedPairs: graph.topKPrunedPairs,
            edgeDensity: graph.edgeDensity,
            reweightWhoUsed: graph.reweightWhoUsed,
            reweightWhereUsed: graph.reweightWhereUsed,
            indexTime,
            time: graph.buildTime,
        });
        logger.info(MODULE_ID, 'No graph edges - skipping diffusion');
        return [];
    }

    // ─── 3. Build seed vector ────────────────────────────────────────

    const T_Seed = performance.now();
    const s = buildSeedVector(validSeeds, idToIdx, N);
    const seedVectorTime = Math.round(performance.now() - T_Seed);

    // ─── 4. Column normalize ─────────────────────────────────────────

    const T_Normalize = performance.now();
    const { columns, dangling } = columnNormalize(graph.neighbors, N);
    const normalizeTime = Math.round(performance.now() - T_Normalize);

    // ─── 5. PPR Power Iteration ──────────────────────────────────────

    const T_PPR = performance.now();
    const { pi, iterations, finalError } = powerIteration(columns, s, dangling, N);
    const pprTime = Math.round(performance.now() - T_PPR);

    // Count activated non-seed nodes
    let pprActivated = 0;
    for (let i = 0; i < N; i++) {
        if (pi[i] > 0 && !seedAtomIds.has(atomIds[i])) pprActivated++;
    }

    // ─── 6. Post-verification ────────────────────────────────────────

    const T_VectorMap = performance.now();
    const vectorMap = new Map();
    for (const sv of (stateVectors || [])) {
        vectorMap.set(sv.atomId, sv.vector);
    }
    const vectorMapTime = Math.round(performance.now() - T_VectorMap);

    const T_PostVerify = performance.now();
    const { diffused, gateStats } = postVerify(
        pi, atomIds, atomById, seedAtomIds, vectorMap, queryVector
    );
    const postVerifyTime = Math.round(performance.now() - T_PostVerify);

    // ─── 7. Metrics ──────────────────────────────────────────────────

    const totalTime = Math.round(performance.now() - T0);

    fillMetrics(metrics, {
        seedCount: validSeeds.length,
        graphNodes: N,
        graphEdges: graph.edgeCount,
        channelStats: graph.channelStats,
        candidatePairs: graph.candidatePairs,
        pairsFromWhat: graph.pairsFromWhat,
        pairsFromRSem: graph.pairsFromRSem,
        rSemAvgSim: graph.rSemAvgSim,
        whatWindowSkippedOccurrences: graph.whatWindowSkippedOccurrences,
        topKPrunedPairs: graph.topKPrunedPairs,
        edgeDensity: graph.edgeDensity,
        reweightWhoUsed: graph.reweightWhoUsed,
        reweightWhereUsed: graph.reweightWhereUsed,
        indexTime,
        buildTime: graph.buildTime,
        seedVectorTime,
        normalizeTime,
        iterations,
        convergenceError: finalError,
        pprTime,
        pprActivated,
        cosineGatePassed: gateStats.passed,
        cosineGateFiltered: gateStats.filtered,
        cosineGateNoVector: gateStats.noVector,
        vectorMapTime,
        postVerifyTime,
        postGatePassRate: pprActivated > 0
            ? Math.round((gateStats.passed / pprActivated) * 100)
            : 0,
        finalCount: diffused.length,
        scoreDistribution: diffused.length > 0
            ? calcScoreStats(diffused.map(d => d.finalScore))
            : { min: 0, max: 0, mean: 0 },
        time: totalTime,
    });

    logger.info(MODULE_ID,
        `Diffusion: ${validSeeds.length} seeds → ` +
        `graph(${N}n/${graph.edgeCount}e) → ` +
        `PPR(${iterations}it, ε=${finalError.toExponential(1)}, ${pprTime}ms) → ` +
        `${pprActivated} activated → ` +
        `gate(${gateStats.passed}\u2713/${gateStats.filtered}\u2717` +
        `${gateStats.noVector ? `/${gateStats.noVector}?` : ''}) → ` +
        `${diffused.length} final ` +
        `(index=${indexTime}ms graph=${graph.buildTime}ms seed=${seedVectorTime}ms normalize=${normalizeTime}ms ppr=${pprTime}ms vectorMap=${vectorMapTime}ms post=${postVerifyTime}ms total=${totalTime}ms)`
    );

    return diffused;
}

// ═══════════════════════════════════════════════════════════════════════════
// Metrics helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute min/max/mean distribution
 * @param {number[]} scores
 * @returns {{ min: number, max: number, mean: number }}
 */
function calcScoreStats(scores) {
    if (!scores.length) return { min: 0, max: 0, mean: 0 };
    const sorted = [...scores].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        min: Number(sorted[0].toFixed(3)),
        max: Number(sorted[sorted.length - 1].toFixed(3)),
        mean: Number((sum / sorted.length).toFixed(3)),
    };
}

/**
 * Fill metrics with empty diffusion block
 */
function fillMetricsEmpty(metrics) {
    if (!metrics) return;
    metrics.diffusion = {
        seedCount: 0,
        graphNodes: 0,
        graphEdges: 0,
        iterations: 0,
        convergenceError: 0,
        pprActivated: 0,
        cosineGatePassed: 0,
        cosineGateFiltered: 0,
        cosineGateNoVector: 0,
        finalCount: 0,
        scoreDistribution: { min: 0, max: 0, mean: 0 },
        byChannel: { what: 0, where: 0, rSem: 0, who: 0 },
        candidatePairs: 0,
        pairsFromWhat: 0,
        pairsFromRSem: 0,
        rSemAvgSim: 0,
        whatWindowSkippedOccurrences: 0,
        topKPrunedPairs: 0,
        edgeDensity: 0,
        reweightWhoUsed: 0,
        reweightWhereUsed: 0,
        indexTime: 0,
        buildTime: 0,
        seedVectorTime: 0,
        normalizeTime: 0,
        pprTime: 0,
        vectorMapTime: 0,
        postVerifyTime: 0,
        postGatePassRate: 0,
        time: 0,
    };
}

/**
 * Fill metrics with diffusion results
 */
function fillMetrics(metrics, data) {
    if (!metrics) return;
    metrics.diffusion = {
        seedCount: data.seedCount || 0,
        graphNodes: data.graphNodes || 0,
        graphEdges: data.graphEdges || 0,
        iterations: data.iterations || 0,
        convergenceError: data.convergenceError || 0,
        pprActivated: data.pprActivated || 0,
        cosineGatePassed: data.cosineGatePassed || 0,
        cosineGateFiltered: data.cosineGateFiltered || 0,
        cosineGateNoVector: data.cosineGateNoVector || 0,
        postGatePassRate: data.postGatePassRate || 0,
        finalCount: data.finalCount || 0,
        scoreDistribution: data.scoreDistribution || { min: 0, max: 0, mean: 0 },
        byChannel: data.channelStats || { what: 0, where: 0, rSem: 0, who: 0 },
        candidatePairs: data.candidatePairs || 0,
        pairsFromWhat: data.pairsFromWhat || 0,
        pairsFromRSem: data.pairsFromRSem || 0,
        rSemAvgSim: data.rSemAvgSim || 0,
        whatWindowSkippedOccurrences: data.whatWindowSkippedOccurrences || 0,
        topKPrunedPairs: data.topKPrunedPairs || 0,
        edgeDensity: data.edgeDensity || 0,
        reweightWhoUsed: data.reweightWhoUsed || 0,
        reweightWhereUsed: data.reweightWhereUsed || 0,
        indexTime: data.indexTime || 0,
        buildTime: data.buildTime || 0,
        seedVectorTime: data.seedVectorTime || 0,
        normalizeTime: data.normalizeTime || 0,
        pprTime: data.pprTime || 0,
        vectorMapTime: data.vectorMapTime || 0,
        postVerifyTime: data.postVerifyTime || 0,
        time: data.time || 0,
    };
}
