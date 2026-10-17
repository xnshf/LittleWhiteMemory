import { getContext } from '../../../../../../extensions.js';
import { getStateAtoms } from '../storage/state-store.js';
import { getRerankBatchDiagnostics, rerankChunks } from '../llm/reranker.js';
import { xbLog } from '../../support/debug-core.js';
import { fuseByFloor, buildMustKeepFloors, mapChunkFloorToAiFloor } from './floor-fusion.js';
import { pullAndScoreL1 } from './l1-pairs.js';
import { CONFIG } from './recall-config.js';
import { observeRecallStage, recordExternalFailure } from './recall-stage.js';

const MODULE_ID = 'recall';

// ═══════════════════════════════════════════════════════════════════════════
// [Stage 6] Floor 融合 + Rerank
// ═══════════════════════════════════════════════════════════════════════════

export async function locateAndPullEvidence(anchorHits, queryVector, rerankQuery, lexicalResult, lexicalTerms, metrics, stageObserver, signal = null) {
    const { chatId, chat, name1, name2 } = getContext();
    if (!chatId) return { l0Selected: [], l1ScoredByFloor: new Map(), mustKeepFloors: [] };
    const captureStages = typeof stageObserver === 'function';

    const T_Start = performance.now();

    // ─────────────────────────────────────────────────────────────────
    // 6a. Dense floor rank（加权聚合：maxSim×0.6 + meanSim×0.4）
    // ─────────────────────────────────────────────────────────────────

    const denseFloorMax = new Map();
    for (const a of (anchorHits || [])) {
        const cur = denseFloorMax.get(a.floor);
        if (!cur || a.similarity > cur) {
            denseFloorMax.set(a.floor, a.similarity);
        }
    }

    const denseFloorRank = [...denseFloorMax.entries()]
        .map(([floor, maxSim]) => ({
            id: floor,
            score: maxSim,
        }))
        .sort((a, b) => b.score - a.score);

    // ─────────────────────────────────────────────────────────────────
    // 6b. Lexical floor rank（密度加成 + Dense 门槛过滤）
    // ─────────────────────────────────────────────────────────────────

    const atomFloorSet = new Set(getStateAtoms().map(a => a.floor));

    const lexFloorAgg = new Map();
    // Replay-only observer data: preserves the pre-gate lexical floor set without affecting recall.
    const lexFloorBeforeDense = captureStages ? new Map() : null;
    let lexFloorFilteredByDense = 0;

    for (const { chunkId, score } of (lexicalResult?.chunkScores || [])) {
        const match = chunkId?.match(/^c-(\d+)-/);
        if (!match) continue;
        const floor = mapChunkFloorToAiFloor(parseInt(match[1], 10), chat);
        if (floor == null) continue;

        // 预过滤：必须有 L0 atoms
        if (!atomFloorSet.has(floor)) continue;

        if (lexFloorBeforeDense) {
            const raw = lexFloorBeforeDense.get(floor);
            if (!raw) {
                lexFloorBeforeDense.set(floor, { maxScore: score, hitCount: 1 });
            } else {
                raw.maxScore = Math.max(raw.maxScore, score);
                raw.hitCount++;
            }
        }

        // Dense 门槛：lexical floor 必须有最低 dense 相关性
        const denseMax = denseFloorMax.get(floor);
        if (!denseMax || denseMax < CONFIG.LEXICAL_FLOOR_DENSE_MIN) {
            lexFloorFilteredByDense++;
            continue;
        }

        const cur = lexFloorAgg.get(floor);
        if (!cur) {
            lexFloorAgg.set(floor, { maxScore: score, hitCount: 1 });
        } else {
            cur.maxScore = Math.max(cur.maxScore, score);
            cur.hitCount++;
        }
    }

    const lexFloorRank = [...lexFloorAgg.entries()]
        .map(([floor, info]) => ({
            id: floor,
            score: info.maxScore * (1 + CONFIG.LEX_DENSITY_BONUS * Math.log2(Math.max(1, info.hitCount))),
        }))
        .sort((a, b) => b.score - a.score);

    if (captureStages) {
        observeRecallStage(stageObserver, 'lexicalPreDenseGate', [...lexFloorBeforeDense.entries()]
            .map(([floor, info]) => ({
                floor,
                score: info.maxScore * (1 + CONFIG.LEX_DENSITY_BONUS * Math.log2(Math.max(1, info.hitCount))),
                denseScore: denseFloorMax.get(floor) ?? null,
                passedDenseGate: (denseFloorMax.get(floor) ?? -Infinity) >= CONFIG.LEXICAL_FLOOR_DENSE_MIN,
            }))
            .sort((a, b) => b.score - a.score));

        observeRecallStage(stageObserver, 'lexical', lexFloorRank.map(item => ({
            floor: item.id,
            score: item.score,
        })));
    }

    if (metrics) {
        metrics.lexical.floorFilteredByDense = lexFloorFilteredByDense;
    }

    // ─────────────────────────────────────────────────────────────────
    // 6b.5 Fusion Guard: lexical must-keep floors
    // ─────────────────────────────────────────────────────────────────

    const mustKeep = buildMustKeepFloors(lexicalResult, lexicalTerms, atomFloorSet, chat, CONFIG);

    // ─────────────────────────────────────────────────────────────────
    // 6c. Floor W-RRF 融合
    // ─────────────────────────────────────────────────────────────────

    const T_Fusion_Start = performance.now();
    const { top: fusedFloors, all: fusedFloorsPreCap, totalUnique } = fuseByFloor(denseFloorRank, lexFloorRank, CONFIG.FUSION_CAP, CONFIG);
    const fusionTime = Math.round(performance.now() - T_Fusion_Start);

    if (captureStages) {
        observeRecallStage(stageObserver, 'fusionPreCap', fusedFloorsPreCap.map((item, index) => ({
            floor: item.id,
            rank: index + 1,
            score: item.fusionScore,
        })));

        observeRecallStage(stageObserver, 'fusion', fusedFloors.map(item => ({
            floor: item.id,
            score: item.fusionScore,
        })));
    }

    if (metrics) {
        metrics.fusion.denseFloors = denseFloorRank.length;
        metrics.fusion.lexFloors = lexFloorRank.length;
        metrics.fusion.totalUnique = totalUnique;
        metrics.fusion.afterCap = fusedFloors.length;
        metrics.fusion.time = fusionTime;
        metrics.fusion.lexDensityBonus = CONFIG.LEX_DENSITY_BONUS;
        metrics.evidence.floorCandidates = fusedFloors.length;
        metrics.evidence.mustKeepTermsCount = mustKeep.terms.length;
        metrics.evidence.mustKeepFloorsCount = mustKeep.floors.length;
        metrics.evidence.mustKeepFloors = mustKeep.floors.map(x => x.floor).slice(0, 10);
        metrics.evidence.lexHitButNotSelected = Math.max(0, mustKeep.lexHitButNotSelected - mustKeep.floors.length);
    }

    if (fusedFloors.length === 0) {
        if (captureStages) observeRecallStage(stageObserver, 'rerank', []);
        if (metrics) {
            metrics.evidence.floorsSelected = 0;
            metrics.evidence.l0Collected = 0;
            metrics.evidence.l1Pulled = 0;
            metrics.evidence.l1Attached = 0;
            metrics.evidence.l1CosineTime = 0;
            metrics.evidence.rerankApplied = false;
        }
        return { l0Selected: [], l1ScoredByFloor: new Map(), mustKeepFloors: [] };
    }

    // ─────────────────────────────────────────────────────────────────
    // 6d. 拉取 L1 chunks + cosine 打分
    // ─────────────────────────────────────────────────────────────────

    const floorsToFetch = new Set();
    const prefetchedFloorItems = fusedFloors;
    for (const f of prefetchedFloorItems) {
        floorsToFetch.add(f.id);
        const userFloor = f.id - 1;
        if (userFloor >= 0 && chat?.[userFloor]?.is_user) {
            floorsToFetch.add(userFloor);
        }
    }

    if (metrics) {
        metrics.evidence.l1PrefetchAiFloors = prefetchedFloorItems.length;
        metrics.evidence.l1PrefetchWithContextFloors = floorsToFetch.size;
    }

    const l1ScoredByFloor = await pullAndScoreL1(chatId, [...floorsToFetch], queryVector, signal);

    // ─────────────────────────────────────────────────────────────────
    // 6e. 构建 rerank documents（每个 floor: USER chunks + AI chunks）
    // ─────────────────────────────────────────────────────────────────

    const normalFloors = fusedFloors.filter(f => !mustKeep.floorSet.has(f.id));

    const rerankCandidates = [];
    for (const f of normalFloors) {
        const aiFloor = f.id;
        const userFloor = aiFloor - 1;

        const aiChunks = l1ScoredByFloor.get(aiFloor) || [];
        const userChunks = (userFloor >= 0 && chat?.[userFloor]?.is_user)
            ? (l1ScoredByFloor.get(userFloor) || [])
            : [];

        const parts = [];
        const userName = chat?.[userFloor]?.name || name1 || '用户';
        const aiName = chat?.[aiFloor]?.name || name2 || '角色';

        if (userChunks.length > 0) {
            parts.push(`${userName}：${userChunks.map(c => c.text).join(' ')}`);
        }
        if (aiChunks.length > 0) {
            parts.push(`${aiName}：${aiChunks.map(c => c.text).join(' ')}`);
        }

        const text = parts.join('\n');
        if (!text.trim()) continue;

        rerankCandidates.push({
            floor: aiFloor,
            text,
            fusionScore: f.fusionScore,
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // 6f. Rerank
    // ─────────────────────────────────────────────────────────────────

    const T_Rerank_Start = performance.now();

    const reranked = await rerankChunks(rerankQuery, rerankCandidates, {
        topN: CONFIG.RERANK_TOP_N,
        minScore: CONFIG.RERANK_MIN_SCORE,
        signal,
    });

    const rerankTime = Math.round(performance.now() - T_Rerank_Start);
    const rerankBatchDiagnostics = getRerankBatchDiagnostics(reranked);

    if (metrics) {
        metrics.evidence.rerankApplied = true;
        metrics.evidence.beforeRerank = rerankCandidates.length;
        metrics.evidence.afterRerank = reranked.length;
        metrics.evidence.droppedByRerankCount = Math.max(0, rerankCandidates.length - reranked.length);
        metrics.evidence.rerankBatchTotal = rerankBatchDiagnostics.totalBatches;
        metrics.evidence.rerankBatchFailed = rerankBatchDiagnostics.failedBatches;
        metrics.evidence.rerankFailed = rerankBatchDiagnostics.failedBatches > 0;
        for (const failure of rerankBatchDiagnostics.failures) {
            recordExternalFailure(metrics, { stage: 'rerank', ...failure });
        }
        metrics.timing.evidenceRerank = rerankTime;

        const scores = reranked.map(c => c._rerankScore || 0).filter(s => s > 0);
        if (scores.length > 0) {
            scores.sort((a, b) => a - b);
            metrics.evidence.rerankScores = {
                min: Number(scores[0].toFixed(3)),
                max: Number(scores[scores.length - 1].toFixed(3)),
                mean: Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3)),
            };
        }

        if (rerankCandidates.length > 0) {
            const totalLen = rerankCandidates.reduce((s, c) => s + (c.text?.length || 0), 0);
            metrics.evidence.rerankDocAvgLength = Math.round(totalLen / rerankCandidates.length);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // 6g. 收集 L0 atoms
    // ─────────────────────────────────────────────────────────────────

    // Floor-based L0 collection:
    // once a floor is selected by fusion/rerank, L0 atoms come from that floor.
    // Dense anchor hits are used as similarity signals (ranking), not hard admission.
    const allAtoms = getStateAtoms();
    const atomById = new Map(allAtoms.map(a => [a.atomId, a]));
    const anchorSimilarityByAtomId = new Map((anchorHits || []).map(h => [h.atomId, h.similarity || 0]));
    const matchedAtomsByFloor = new Map();
    for (const hit of (anchorHits || [])) {
        const atom = hit.atom || atomById.get(hit.atomId);
        if (!atom) continue;
        if (!matchedAtomsByFloor.has(hit.floor)) matchedAtomsByFloor.set(hit.floor, []);
        matchedAtomsByFloor.get(hit.floor).push({
            atom,
            similarity: hit.similarity,
        });
    }
    for (const arr of matchedAtomsByFloor.values()) {
        arr.sort((a, b) => b.similarity - a.similarity);
    }

    const mustKeepMissing = mustKeep.floors
        .filter(mf => !reranked.some(r => r.floor === mf.floor))
        .map(mf => ({
            floor: mf.floor,
            _rerankScore: 0.12 + Math.min(0.05, 0.01 * (mf.termCoverage || 1)),
            _isMustKeep: true,
        }));

    const finalFloorItems = [
        ...reranked.map(r => ({ ...r, _isMustKeep: false })),
        ...mustKeepMissing,
    ];

    if (captureStages) {
        observeRecallStage(stageObserver, 'rerank', finalFloorItems.map(item => ({
            floor: item.floor,
            score: Number.isFinite(item?._rerankScore) ? item._rerankScore : null,
            source: item._isMustKeep ? 'must-keep' : 'rerank',
        })));
    }

    const allAtomsByFloor = new Map();
    for (const atom of allAtoms) {
        const f = Number(atom?.floor);
        if (!Number.isInteger(f) || f < 0) continue;
        if (!allAtomsByFloor.has(f)) allAtomsByFloor.set(f, []);
        allAtomsByFloor.get(f).push(atom);
    }

    const l0Selected = [];

    for (const item of finalFloorItems) {
        const floor = item.floor;
        const rerankScore = Number.isFinite(item?._rerankScore) ? item._rerankScore : 0;

        const floorAtoms = allAtomsByFloor.get(floor) || [];
        floorAtoms.sort((a, b) => {
            const sa = anchorSimilarityByAtomId.get(a.atomId) || 0;
            const sb = anchorSimilarityByAtomId.get(b.atomId) || 0;
            return sb - sa;
        });

        for (const atom of floorAtoms) {
            const similarity = anchorSimilarityByAtomId.get(atom.atomId) || 0;
            l0Selected.push({
                id: `anchor-${atom.atomId}`,
                atomId: atom.atomId,
                floor: atom.floor,
                similarity,
                rerankScore,
                atom,
                text: atom.semantic || '',
            });
        }

    }

    if (metrics) {
        metrics.evidence.floorsSelected = finalFloorItems.length;
        metrics.evidence.l0Collected = l0Selected.length;

        metrics.evidence.l1Pulled = 0;
        metrics.evidence.l1Attached = 0;
        metrics.evidence.l1CosineTime = 0;
        metrics.evidence.contextPairsAdded = 0;
    }

    const totalTime = Math.round(performance.now() - T_Start);
    if (metrics) {
        metrics.timing.evidenceRetrieval = Math.max(0, totalTime - fusionTime - rerankTime);
    }

    xbLog.info(MODULE_ID,
        `Evidence: ${denseFloorRank.length} dense floors + ${lexFloorRank.length} lex floors (${lexFloorFilteredByDense} lex filtered by dense) → fusion=${fusedFloors.length} → rerank(normal)=${reranked.length} + mustKeep=${mustKeepMissing.length} floors → L0=${l0Selected.length} (${totalTime}ms)`
    );

    return {
        l0Selected,
        l1ScoredByFloor,
        mustKeepFloors: mustKeep.floors.map(x => x.floor),
    };
}
