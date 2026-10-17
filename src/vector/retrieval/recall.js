// ═══════════════════════════════════════════════════════════════════════════
// Story Summary - Recall Engine (v9 - Dense-Gated Lexical + Entity Bypass Tuning)
//
// 命名规范：
// - 存储层用 L0/L1/L2/L3（StateAtom/Chunk/Event/Fact）
// - 召回层用语义名称：anchor/evidence/event/constraint
//
// v8 → v9 变更：
// - recallEvents() 返回 { events, scoreMap }，event 向量只按候选临时取回给 MMR
// - Lexical Event 合并前验 CONFIG.LEXICAL_EVENT_DENSE_MIN
// - Lexical Floor 进入融合前验 dense similarity ≥ 0.50（CONFIG.LEXICAL_FLOOR_DENSE_MIN）
// - Entity Bypass 阈值 0.85 → 0.80（CONFIG.EVENT_ENTITY_BYPASS_SIM）
// - metrics 新增 lexical.eventFilteredByDense / lexical.floorFilteredByDense
//
// 架构：
// 阶段 1: Query Build（确定性，无 LLM）
// 阶段 2: Round 1 Dense Retrieval（batch embed 3 段 → 加权平均）
// 阶段 3: Query Refinement（用已命中记忆产出 hints 段）
// 阶段 4: Round 2 Dense Retrieval（复用 R1 vec + embed hints → 加权平均）
// 阶段 5: Lexical Retrieval + Dense-Gated Event Merge
// 阶段 6: Floor W-RRF Fusion + Rerank + L1 配对
// 阶段 7: L1 配对组装（L0 → top-1 AI L1 + top-1 USER L1）
// 阶段 7.5: PPR Diffusion
// 阶段 8: L0 → L2 反向查找（后置，基于最终 l0Selected）
// 阶段 9: Causation Trace
// ═══════════════════════════════════════════════════════════════════════════

import {
    beginRecallRuntimeSession,
    diffuseRecallRuntimeL0,
    endRecallRuntimeSession,
    getRecallRuntimeMeta,
    scoreRecallRuntimeAnchors,
} from '../runtime/runtime.js';
import { getStateAtoms } from '../storage/state-store.js';
import { getEngineFingerprint } from '../utils/embedder.js';
import { xbLog } from '../../support/debug-core.js';
import { throwIfSignalAborted } from '../../support/abort-utils.js';
import { getContext } from '../../../../../../extensions.js';
import {
    buildQueryBundle,
    describeQueryFocusOwnership,
    refineQueryBundle,
} from './query-builder.js';
import { getLexicalIndex, searchLexicalIndex } from './lexical-index.js';
import { createMetrics, finalizeMetricsTiming } from './metrics.js';
import { recordRecallFallback } from '../../runtime/recall-diagnostics.js';
import { normalize } from './floor-fusion.js';
import { buildRound1QueryVector, buildRound2QueryVector } from './recall-query-vectors.js';
import { mergeLexicalEvents } from './recall-lexical-events.js';
import { rerankRecalledEvents } from './event-rerank.js';
import { recallEvents } from './event-dense-recall.js';
import { buildL1PairsForSelectedFloors } from './l1-pairs.js';
import { selectDirectEvidence } from './direct-evidence-retrieval.js';
import { buildSemanticRecallInputs } from './semantic-query.js';
import {
    releaseDirectEvidenceRuntimeLease,
    transferDirectEvidenceRuntimeLease,
} from './direct-evidence-session.js';
import {
    buildTemporalTurnCarrier,
    parseEventRange,
} from './temporal-turn-carrier.js';
import { classifyEventRecall } from './event-recall-classification.js';
import { CONFIG } from './recall-config.js';
import { observeRecallStage, recordExternalFailure } from './recall-stage.js';
import { locateAndPullEvidence } from './floor-evidence.js';

const MODULE_ID = 'recall';

// ═══════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════

function getLastMessages(chat, count = 3, excludeLastAi = false) {
    if (!chat?.length) return [];
    let messages = [...chat];
    if (excludeLastAi && messages.length > 0 && !messages[messages.length - 1]?.is_user) {
        messages = messages.slice(0, -1);
    }
    return messages.slice(-count);
}

// ═══════════════════════════════════════════════════════════════════════════
// [Anchors] L0 StateAtoms 检索
// ═══════════════════════════════════════════════════════════════════════════

async function recallAnchors(queryVector, vectorConfig, metrics, snapshot = null, signal = null) {
    const { chatId } = getContext();
    if (!chatId || !queryVector?.length) {
        return { hits: [], floors: new Set() };
    }
    const canUseSnapshot = snapshot?.chatId === chatId;

    const meta = canUseSnapshot && snapshot?.meta
        ? snapshot.meta
        : await getRecallRuntimeMeta(chatId, { signal });
    const fp = getEngineFingerprint(vectorConfig);
    if (meta?.fingerprint && meta.fingerprint !== fp) {
        xbLog.warn(MODULE_ID, 'Anchor fingerprint 不匹配');
        return { hits: [], floors: new Set() };
    }

    const atomsList = getStateAtoms();
    const atomMap = new Map(atomsList.map(a => [a.atomId, a]));

    const runtimeScores = await scoreRecallRuntimeAnchors(chatId, queryVector, { signal });
    if (metrics) {
        metrics.timing.runtimeScoreAnchors = runtimeScores?.stats?.timings?.scoreAnchorsMs ?? null;
    }
    const scored = (runtimeScores?.scores || [])
        .map(s => {
            const atom = atomMap.get(s.atomId);
            if (!atom) return null;
            return { ...s, atom };
        })
        .filter(Boolean)
        .filter(s => s.similarity >= CONFIG.ANCHOR_MIN_SIMILARITY)
        .sort((a, b) => b.similarity - a.similarity);

    const floors = new Set(scored.map(s => s.floor));

    if (metrics) {
        metrics.anchor.matched = scored.length;
        metrics.anchor.floorsHit = floors.size;
    }

    return { hits: scored, floors };
}

// ═══════════════════════════════════════════════════════════════════════════
// [Causation] 因果链追溯
// ═══════════════════════════════════════════════════════════════════════════

function buildEventIndex(allEvents) {
    const map = new Map();
    for (const e of allEvents || []) {
        if (e?.id) map.set(e.id, e);
    }
    return map;
}

function traceCausation(eventHits, eventIndex, maxDepth = CONFIG.CAUSAL_CHAIN_MAX_DEPTH) {
    const out = new Map();
    const idRe = /^evt-\d+$/;
    let maxActualDepth = 0;

    function visit(parentId, depth, chainFrom) {
        if (depth > maxDepth) return;
        if (!idRe.test(parentId)) return;

        const ev = eventIndex.get(parentId);
        if (!ev) return;

        if (depth > maxActualDepth) maxActualDepth = depth;

        const existed = out.get(parentId);
        if (!existed) {
            out.set(parentId, { event: ev, depth, chainFrom: [chainFrom] });
        } else {
            if (depth < existed.depth) existed.depth = depth;
            if (!existed.chainFrom.includes(chainFrom)) existed.chainFrom.push(chainFrom);
        }

        for (const next of (ev.causedBy || [])) {
            visit(String(next || '').trim(), depth + 1, chainFrom);
        }
    }

    for (const r of eventHits || []) {
        const rid = r?.event?.id;
        if (!rid) continue;
        for (const cid of (r.event?.causedBy || [])) {
            visit(String(cid || '').trim(), 1, rid);
        }
    }

    const results = Array.from(out.values())
        .sort((a, b) => {
            const refDiff = b.chainFrom.length - a.chainFrom.length;
            if (refDiff !== 0) return refDiff;
            return a.depth - b.depth;
        })
        .slice(0, CONFIG.CAUSAL_INJECT_MAX);

    return { results, maxDepth: maxActualDepth };
}

export async function hydrateSelectedDirectEvidence(selectedDirect, context, metrics) {
    const startedAt = performance.now();
    if (context?.diagnostics) context.diagnostics.stage = 'direct-evidence';
    try {
        const result = await selectDirectEvidence(selectedDirect, context);
        const stats = result.stats || {};
        if (metrics?.evidence) {
            metrics.evidence.directEvidenceStatus = result.status || 'failed';
            for (const [key, field] of Object.entries({
                parents: 'directEvidenceParents', floors: 'directEvidenceFloors',
                sourceCandidates: 'directEvidenceSourceCandidates', candidates: 'directEvidenceCandidates',
                relevantItems: 'directEvidenceRelevantItems', vectorHits: 'directEvidenceVectorHits',
                missingVectors: 'directEvidenceMissingVectors', missingEventVectors: 'directEvidenceMissingEventVectors',
                eventItems: 'directEvidenceEventItems', conversationItems: 'directEvidenceConversationItems',
                lexicalItems: 'directEvidenceLexicalItems', temporalCandidates: 'directEvidenceTemporalCandidates',
                temporalFloorWinners: 'directEvidenceTemporalFloorWinners',
                temporalProtectedCandidates: 'directEvidenceTemporalProtectedCandidates',
            })) metrics.evidence[field] = Number(stats[key] || 0);
            metrics.evidence.directEvidenceItems = result.items.length;
        }
        if (result.status === 'partial-vectors') {
            recordRecallFallback(context?.diagnostics, 'direct-evidence',
                `部分向量缺失：L1=${stats.missingVectors || 0}, events=${stats.missingEventVectors || 0}，保留可用通道结果`);
        }
        return result;
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        xbLog.warn(MODULE_ID, 'DIRECT evidence retrieval failed; keep the existing evidence path', error);
        recordRecallFallback(context?.diagnostics, 'direct-evidence', error);
        if (metrics?.evidence) {
            metrics.evidence.directEvidenceStatus = 'failed';
            metrics.evidence.directEvidenceItems = 0;
        }
        return { items: [], status: 'failed', stats: {} };
    } finally {
        if (metrics?.timing) metrics.timing.directEvidenceRetrieval = Math.round(performance.now() - startedAt);
        await releaseDirectEvidenceContext(context, metrics);
    }
}

export async function releaseDirectEvidenceContext(context, metrics) {
    const startedAt = performance.now();
    try {
        return await releaseDirectEvidenceRuntimeLease(context, endRecallRuntimeSession);
    } catch (error) {
        xbLog.warn(MODULE_ID, 'Deferred DIRECT evidence runtime session release failed', error);
        recordRecallFallback(context?.diagnostics, 'runtime-release', error);
        return false;
    } finally {
        if (metrics?.timing) {
            metrics.timing.runtimeEndSession = Number(metrics.timing.runtimeEndSession || 0)
                + Math.round(performance.now() - startedAt);
        }
    }
}

function finalizeRecallTiming(metrics, totalStart) {
    if (metrics?.timing) finalizeMetricsTiming(metrics, performance.now() - totalStart);
}

// ═══════════════════════════════════════════════════════════════════════════
// 主函数
// ═══════════════════════════════════════════════════════════════════════════

export async function recallMemory(allEvents, vectorConfig, options = {}) {
    const T0 = performance.now();
    const { chat, chatId, name1 } = getContext();
    const {
        excludeLastAi = false,
        stageObserver = null,
        deferRuntimeRelease = false,
        signal = null,
        diagnostics = null,
    } = options;
    const captureStages = typeof stageObserver === 'function';
    const events = Array.isArray(allEvents) ? allEvents : [];

    const metrics = createMetrics();
    if (diagnostics) {
        diagnostics.metrics = metrics;
        diagnostics.stage = 'query-build';
    }
    metrics.lexical.denseGateThresholds = { event: CONFIG.LEXICAL_EVENT_DENSE_MIN, floor: CONFIG.LEXICAL_FLOOR_DENSE_MIN };

    metrics.anchor.needRecall = true;

    try {

    const snapshot = { chatId, meta: null, stateVectors: null };

    // ═══════════════════════════════════════════════════════════════════
    // 阶段 1: Query Build
    // ═══════════════════════════════════════════════════════════════════

    const T_Build_Start = performance.now();

    const lastMessages = getLastMessages(chat, CONFIG.LAST_MESSAGES_K, excludeLastAi);

    // Non-blocking preload: keep recall latency stable.
    // If not ready yet, query-builder will gracefully fall back to TF terms.
    const lexicalPreload = getLexicalIndex().then(() => null, error => {
        xbLog.warn(MODULE_ID, 'Preload lexical index failed; continue with TF fallback', error);
        return error;
    });

    const bundle = buildQueryBundle(lastMessages);
    if (captureStages) {
        observeRecallStage(stageObserver, 'queryFocusOwnership', [], describeQueryFocusOwnership(bundle));
    }
    const focusTerms = bundle.focusTerms || bundle.focusEntities || [];
    const focusCharacters = bundle.focusCharacters || [];
    const queryFloor = Array.isArray(chat) ? chat.lastIndexOf(lastMessages[lastMessages.length - 1]) : -1;
    const queryBoundary = queryFloor >= 0 ? queryFloor : (chat?.length || 0);
    const temporalCarrier = buildTemporalTurnCarrier({
        chat, query: bundle.focusQuery, userName: name1,
        queryFloor: queryBoundary,
    });
    snapshot.temporalCarrier = temporalCarrier;

    metrics.query.buildTime = Math.round(performance.now() - T_Build_Start);
    metrics.anchor.focusTerms = focusTerms;
    metrics.anchor.focusCharacters = focusCharacters;

    if (metrics.query?.lengths) {
        metrics.query.lengths.v0Chars = bundle.querySegments.reduce((sum, s) => sum + s.text.length, 0);
        metrics.query.lengths.v1Chars = null;
        metrics.query.lengths.rerankChars = String(bundle.rerankQuery || '').length;
    }

    xbLog.info(MODULE_ID,
        `Query Build: focus_terms=[${focusTerms.join(',')}] focus_characters=[${focusCharacters.join(',')}] segments=${bundle.querySegments.length} lexTerms=[${bundle.lexicalTerms.slice(0, 5).join(',')}]`
    );

    // ═══════════════════════════════════════════════════════════════════
    // 阶段 2: Round 1 Dense Retrieval（batch embed → 加权平均）
    // ═══════════════════════════════════════════════════════════════════

    if (!bundle.querySegments.length) {
        if (diagnostics) diagnostics.reason = '没有可用的查询内容';
        metrics.timing.total = Math.round(performance.now() - T0);
        return {
            events: [], l0Selected: [], l1ByFloor: new Map(), causalChain: [],
            focusEntities: focusTerms,
            focusTerms,
            focusCharacters,
            mustKeepFloors: [],
            elapsed: metrics.timing.total,
            metrics,
        };
    }

    const { r1Vectors, r1Weights, queryVector_v0 } = await buildRound1QueryVector(
        bundle.querySegments, vectorConfig, { metrics, diagnostics, signal, totalStart: T0 },
    );

    if (!queryVector_v0?.length) {
        if (diagnostics) diagnostics.reason = '查询向量无法合成';
        metrics.timing.total = Math.round(performance.now() - T0);
        return {
            events: [], l0Selected: [], l1ByFloor: new Map(), causalChain: [],
            focusEntities: focusTerms,
            focusTerms,
            focusCharacters,
            mustKeepFloors: [],
            elapsed: metrics.timing.total,
            metrics,
        };
    }

    let runtimeLease = null;
    try {
    const T_Runtime_Begin_Start = performance.now();
    if (diagnostics) diagnostics.stage = 'runtime-load';
    if (chatId) {
        throwIfSignalAborted(signal);
        // Session acquisition must finish so its lease can always be released;
        // cancellation is checked immediately after ownership is established.
        runtimeLease = await beginRecallRuntimeSession(chatId, { reason: 'recallMemory' });
        throwIfSignalAborted(signal);
        snapshot.meta = await getRecallRuntimeMeta(chatId, { signal });
        metrics.timing.runtimeLoadFromDB = runtimeLease?.stats?.timings?.loadFromDBMs ?? 0;
        metrics.timing.runtimeBuildEntry = runtimeLease?.stats?.timings?.buildEntryMs ?? 0;
    }
    metrics.timing.runtimeBeginSession = Math.round(performance.now() - T_Runtime_Begin_Start);

    const T_R1_Anchor_Start = performance.now();
    if (diagnostics) diagnostics.stage = 'round1-retrieval';
    const { hits: anchorHits_v0 } = await recallAnchors(queryVector_v0, vectorConfig, null, snapshot, signal);
    const r1AnchorTime = Math.round(performance.now() - T_R1_Anchor_Start);
    metrics.timing.round1AnchorSearch = r1AnchorTime;

    const T_R1_Event_Start = performance.now();
    const { events: eventHits_v0 } = await recallEvents(
        queryVector_v0,
        events,
        vectorConfig,
        focusCharacters,
        null,
        snapshot,
        signal,
    );
    const r1EventTime = Math.round(performance.now() - T_R1_Event_Start);
    metrics.timing.round1EventRetrieval = r1EventTime;

    xbLog.info(MODULE_ID,
        `Round 1: anchors=${anchorHits_v0.length} events=${eventHits_v0.length} weights=[${r1Weights.map(w => w.toFixed(2)).join(',')}] (anchor=${r1AnchorTime}ms event=${r1EventTime}ms)`
    );
    if (captureStages) {
        observeRecallStage(stageObserver, 'r1Dense', anchorHits_v0.map(hit => ({
            floor: hit.floor,
            score: hit.similarity,
        })));
    }

    // ═══════════════════════════════════════════════════════════════════
    // 阶段 3: Query Refinement
    // ═══════════════════════════════════════════════════════════════════

    const T_Refine_Start = performance.now();

    refineQueryBundle(bundle, anchorHits_v0, eventHits_v0);

    metrics.query.refineTime = Math.round(performance.now() - T_Refine_Start);

    if (metrics.query?.lengths && bundle.hintsSegment) {
        metrics.query.lengths.v1Chars = metrics.query.lengths.v0Chars + bundle.hintsSegment.text.length;
    }

    xbLog.info(MODULE_ID,
        `Refinement: focus_terms=[${focusTerms.join(',')}] focus_characters=[${focusCharacters.join(',')}] hasHints=${!!bundle.hintsSegment} (${metrics.query.refineTime}ms)`
    );

    // ═══════════════════════════════════════════════════════════════════
    // 阶段 4: Round 2 Dense Retrieval（复用 R1 向量 + embed hints）
    // ═══════════════════════════════════════════════════════════════════

    const queryVector_v1 = bundle.hintsSegment
        ? await buildRound2QueryVector(bundle, r1Vectors, queryVector_v0, vectorConfig, { metrics, diagnostics, signal })
        : queryVector_v0;

    const semanticInputs = buildSemanticRecallInputs(bundle, queryVector_v1);
    if (captureStages) {
        observeRecallStage(
            stageObserver,
            'semanticQuery',
            [],
            semanticInputs.eventRerank,
        );
    }

    const T_R2_Anchor_Start = performance.now();
    if (diagnostics) diagnostics.stage = 'round2-retrieval';
    const { hits: anchorHits, floors: anchorFloors_dense } = await recallAnchors(
        queryVector_v1,
        vectorConfig,
        metrics,
        snapshot,
        signal,
    );
    metrics.timing.anchorSearch = Math.round(performance.now() - T_R2_Anchor_Start);

    const T_R2_Event_Start = performance.now();
    let { events: eventHits, scoreMap: eventScoreMap } = await recallEvents(
        queryVector_v1,
        events,
        vectorConfig,
        focusCharacters,
        metrics,
        snapshot,
        signal,
    );
    metrics.timing.eventRetrieval = Math.round(performance.now() - T_R2_Event_Start);

    xbLog.info(MODULE_ID,
        `Round 2: anchors=${anchorHits.length} floors=${anchorFloors_dense.size} events=${eventHits.length}`
    );
    if (captureStages) {
        observeRecallStage(stageObserver, 'r2Dense', anchorHits.map(hit => ({
            floor: hit.floor,
            score: hit.similarity,
        })));
    }

    // ═══════════════════════════════════════════════════════════════════
    // 阶段 5: Lexical Retrieval + Dense-Gated Event Merge
    // ═══════════════════════════════════════════════════════════════════

    const T_Lex_Start = performance.now();
    if (diagnostics) diagnostics.stage = 'lexical-search';

    let lexicalResult = {
        atomIds: [], atomFloors: new Set(),
        chunkIds: [], chunkFloors: new Set(),
        eventIds: [], chunkScores: [], searchTime: 0,
        idfEnabled: false, idfDocCount: 0, topIdfTerms: [], termSearches: 0,
        queryTerms: [],
        termFloorHits: {},
        floorLexScores: [],
    };

    let indexReadyTime = 0;
    const T_Index_Ready = performance.now();
    try {
        // Consume the speculative attempt inside this run, so a late failure
        // cannot append diagnostics after an empty/cancelled run has finished.
        const preloadError = await lexicalPreload;
        throwIfSignalAborted(signal);
        if (preloadError) recordRecallFallback(diagnostics, 'lexical-preload', preloadError);
        let index;
        try {
            index = await getLexicalIndex();
        } finally {
            indexReadyTime = Math.round(performance.now() - T_Index_Ready);
        }
        throwIfSignalAborted(signal);
        if (index) {
            lexicalResult = await searchLexicalIndex(index, bundle.lexicalTerms);
            for (const failure of lexicalResult.failures) {
                recordRecallFallback(diagnostics, 'lexical-search', new Error(
                    `Lexical term search failed: ${failure.term}`, { cause: failure.error },
                ));
            }
        }
    } catch (e) {
        throwIfSignalAborted(signal);
        xbLog.warn(MODULE_ID, 'Lexical 检索失败', e);
        recordRecallFallback(diagnostics, 'lexical-search', e);
    }
    throwIfSignalAborted(signal);

    const lexTime = Math.round(performance.now() - T_Lex_Start);

    if (metrics) {
        metrics.lexical.atomHits = lexicalResult.atomIds.length;
        metrics.lexical.chunkHits = lexicalResult.chunkIds.length;
        metrics.lexical.eventHits = lexicalResult.eventIds.length;
        metrics.lexical.searchTime = lexicalResult.searchTime || 0;
        metrics.lexical.indexReadyTime = indexReadyTime;
        metrics.lexical.terms = lexicalResult.queryTerms.slice(0, 10);
        metrics.lexical.idfEnabled = !!lexicalResult.idfEnabled;
        metrics.lexical.idfDocCount = lexicalResult.idfDocCount || 0;
        metrics.lexical.topIdfTerms = lexicalResult.topIdfTerms || [];
        metrics.lexical.termSearches = lexicalResult.termSearches || 0;
    }

    // 合并 L2 events（lexical 命中但 dense 未命中的 events）
    // ★ Dense 门槛：验证 event 向量与 queryVector_v1 的 cosine similarity
    const eventIndex = buildEventIndex(events);
    let l0LinkedCount = 0;
    const focusSetForLexical = new Set((focusCharacters || []).map(normalize));
    const { existingEventIds, lexicalEventCount, lexicalEventFilteredByDense } = mergeLexicalEvents({
        eventHits, eventIds: lexicalResult.eventIds, eventIndex, eventScoreMap,
        focusSet: focusSetForLexical, temporalFloors: temporalCarrier.exactFloors, metrics,
    });

    xbLog.info(MODULE_ID,
        `Lexical: chunks=${lexicalResult.chunkIds.length} events=${lexicalResult.eventIds.length} mergedEvents=+${lexicalEventCount} filteredByDense=${lexicalEventFilteredByDense} floorFiltered=${metrics.lexical.floorFilteredByDense || 0} idfEnabled=${lexicalResult.idfEnabled ? 'yes' : 'no'} idfDocs=${lexicalResult.idfDocCount || 0} termSearches=${lexicalResult.termSearches || 0} (indexReady=${indexReadyTime}ms search=${lexicalResult.searchTime || 0}ms total=${lexTime}ms)`
    );

    // ═══════════════════════════════════════════════════════════════════
    // 阶段 6: Floor 粒度融合 + Rerank + L1 配对
    // ═══════════════════════════════════════════════════════════════════

    if (diagnostics) diagnostics.stage = 'floor-evidence';
    const { l0Selected, l1ScoredByFloor, mustKeepFloors } = await locateAndPullEvidence(
        anchorHits,
        queryVector_v1,
        bundle.rerankQuery,
        lexicalResult,
        lexicalResult.queryTerms,
        metrics,
        stageObserver,
        signal
    );
    if (metrics.evidence.rerankFailed) recordRecallFallback(diagnostics, 'floor-rerank', '重排失败，使用融合顺序');

    // ═══════════════════════════════════════════════════════════════════
    // Stage 7.5: PPR Diffusion Activation
    //
    // Spread from reranked seeds through entity co-occurrence graph.
    // Diffused atoms merge into l0Selected at lower scores than seeds,
    // consumed by prompt.js through the same budget pipeline.
    // ═══════════════════════════════════════════════════════════════════

    if (diagnostics) diagnostics.stage = 'diffusion';
    const diffusionResult = await diffuseRecallRuntimeL0(
        chatId,
        l0Selected,          // seeds (rerank-verified)
        getStateAtoms(),     // all L0 atoms; vectors stay in runtime
        queryVector_v1,      // R2 query vector (for cosine gate)
        { name1, signal },
    );
    const diffused = diffusionResult?.diffused || [];
    if (captureStages) {
        observeRecallStage(stageObserver, 'graph', diffused.map(item => ({
            floor: item.floor,
            score: item.finalScore,
            source: 'graph',
        })));
    }
    metrics.diffusion = {
        ...(metrics.diffusion || {}),
        ...(diffusionResult?.metrics || {}),
    };
    metrics.timing.runtimeDiffuseL0 = metrics.diffusion?.time || metrics.timing.diffusion || 0;

    for (const da of diffused) {
        l0Selected.push({
            id: `diffused-${da.atomId}`,
            atomId: da.atomId,
            floor: da.floor,
            similarity: da.finalScore,
            rerankScore: da.finalScore,
            atom: da.atom,
            text: da.atom.semantic || '',
        });
    }
    metrics.timing.diffusion = metrics.diffusion?.time || 0;

    // ═══════════════════════════════════════════════════════════════════
    // Stage 8: L0 → L2 反向查找（后置，基于最终 l0Selected）
    // ═══════════════════════════════════════════════════════════════════

    const recalledL0Floors = new Set(l0Selected.map(x => x.floor));

    for (const event of events) {
        if (existingEventIds.has(event.id)) continue;

        const range = parseEventRange(event.summary);
        if (!range) continue;

        let hasOverlap = false;
        for (const floor of recalledL0Floors) {
            if (floor >= range.start && floor <= range.end) {
                hasOverlap = true;
                break;
            }
        }
        if (!hasOverlap) continue;

        // Dense similarity 门槛（与 Lexical Event 对齐）
        const sim = eventScoreMap.get(event.id) ?? 0;
        if (sim < CONFIG.LEXICAL_EVENT_DENSE_MIN) continue;

        // 实体归属与 DIRECT 分类：与所有路径统一标准
        const { ownership, recallType, evidenceEligible } = classifyEventRecall(
            event,
            focusSetForLexical,
            sim,
            { evidenceMinSimilarity: CONFIG.EVENT_EVIDENCE_MIN_SIMILARITY },
        );

        eventHits.push({
            event,
            similarity: sim,
            _recallType: recallType,
            _ownership: ownership,
            _evidenceEligible: evidenceEligible,
        });
        existingEventIds.add(event.id);
        l0LinkedCount++;
    }

    if (metrics && l0LinkedCount > 0) {
        metrics.event.byRecallType.l0Linked = l0LinkedCount;
        metrics.event.selected += l0LinkedCount;
    }

    xbLog.info(MODULE_ID,
        `L0-linked events: ${recalledL0Floors.size} floors → ${l0LinkedCount} events linked (sim≥${CONFIG.LEXICAL_EVENT_DENSE_MIN})`
    );

    const l1ByFloor = await buildL1PairsForSelectedFloors(
        l0Selected,
        queryVector_v1,
        l1ScoredByFloor,
        metrics,
        signal,
    );

    // ═══════════════════════════════════════════════════════════════════
    // 阶段 9: Causation Trace
    // ═══════════════════════════════════════════════════════════════════

    const { results: causalMap, maxDepth: causalMaxDepth } = traceCausation(eventHits, eventIndex);

    const recalledIdSet = new Set(eventHits.map(x => x?.event?.id).filter(Boolean));
    const causalChain = causalMap
        .filter(x => x?.event?.id && !recalledIdSet.has(x.event.id))
        .map(x => ({
            event: x.event,
            similarity: 0,
            _recallType: 'CAUSAL',
            _causalDepth: x.depth,
            chainFrom: x.chainFrom,
        }));

    if (metrics.event.byRecallType) {
        metrics.event.byRecallType.causal = causalChain.length;
    }
    metrics.event.causalChainDepth = causalMaxDepth;
    metrics.event.causalCount = causalChain.length;

    // Candidate packing always consumes relevance order. Normalize the base
    // order before L2 rerank; once reranked, keep that result
    // intact because cosine similarity and cross-encoder scores are not on
    // the same scale.
    eventHits = [...eventHits].sort((left, right) => (
        Number(right?.similarity || 0) - Number(left?.similarity || 0)
    ));

    if (diagnostics) diagnostics.stage = 'event-rerank';
    const eventRerank = await rerankRecalledEvents(eventHits, {
        ...semanticInputs.eventRerank,
        chat,
        queryFloor: queryBoundary,
        signal,
    });
    metrics.event.rerank = {
        status: eventRerank.status,
        sourceCandidates: eventRerank.sourceCount,
        candidates: eventRerank.candidateCount,
        tailCandidates: eventRerank.tailCount,
        exactTime: {
            marker: eventRerank.exactTimeMarker,
            floors: eventRerank.exactTimeFloorCount,
            candidates: eventRerank.exactTimeCandidateCount,
            winners: eventRerank.exactTimeWinnerCount,
            reserved: eventRerank.exactTimeReservedCount,
            overflow: eventRerank.exactTimeOverflowCount,
            forced: eventRerank.exactTimeForcedCount,
        },
        batchTotal: eventRerank.diagnostics.totalBatches,
        batchFailed: eventRerank.diagnostics.failedBatches,
    };
    metrics.timing.eventRerank = eventRerank.rerankMs;
    for (const failure of eventRerank.diagnostics.failures) {
        recordExternalFailure(metrics, { stage: 'event-rerank', ...failure });
    }
    if (eventRerank.status === 'applied') {
        eventHits = eventRerank.events;
    } else if (eventRerank.status === 'rerank-failed') {
        recordRecallFallback(diagnostics, 'event-rerank', '重排失败，保留原事件顺序');
        xbLog.warn(MODULE_ID, `Event rerank ${eventRerank.status}; keep original event order`);
    }

    let directEvidenceContext = null;
    if (!eventHits.some(item => item?._evidenceEligible === true)) {
        metrics.evidence.directEvidenceStatus = 'skipped-no-eligible-events';
    } else {
        directEvidenceContext = {
            diagnostics,
            chatId,
            ...semanticInputs.directEvidence,
            lexicalScores: lexicalResult.chunkScores,
            temporalCarrier,
            signal,
        };
        metrics.evidence.directEvidenceStatus = 'ready';
    }

    // ═══════════════════════════════════════════════════════════════════
    // 完成
    // ═══════════════════════════════════════════════════════════════════

    finalizeRecallTiming(metrics, T0);
    metrics.event.entityNames = focusCharacters;
    metrics.event.entitiesUsed = focusCharacters.length;
    metrics.event.focusTermsCount = focusTerms.length;

    if (xbLog.isEnabled()) {
        xbLog.info(MODULE_ID, `[Recall v9] Retrieval subtotal (before assembly/release): ${metrics.timing.total}ms`);
        xbLog.info(MODULE_ID, `[Recall v9] Timing attribution: external=${metrics.timing.externalTotal || 0}ms localKnown=${metrics.timing.localKnownTotal || 0}ms unattributed=${metrics.timing.unattributed || 0}ms | r1Embed=${metrics.timing.round1Embed || 0}ms r2Embed=${metrics.timing.round2Embed || 0}ms floorRerank=${metrics.timing.evidenceRerank || 0}ms eventRerank=${metrics.timing.eventRerank || 0}ms`);
        xbLog.info(MODULE_ID, `[Recall v9] Query Build: ${metrics.query.buildTime}ms | Refine: ${metrics.query.refineTime}ms`);
        xbLog.info(MODULE_ID, `[Recall v9] R1 weights: [${r1Weights.map(w => w.toFixed(2)).join(', ')}]`);
        xbLog.info(MODULE_ID, `[Recall v9] Focus terms: [${focusTerms.join(', ')}]`);
        xbLog.info(MODULE_ID, `[Recall v9] Focus characters: [${focusCharacters.join(', ')}]`);
        xbLog.info(MODULE_ID, `[Recall v9] Round 2 Anchors: ${anchorHits.length} hits -> ${anchorFloors_dense.size} floors`);
        xbLog.info(MODULE_ID, `[Recall v9] Lexical: chunks=${lexicalResult.chunkIds.length} events=${lexicalResult.eventIds.length} evtMerged=+${lexicalEventCount} evtFiltered=${lexicalEventFilteredByDense} floorFiltered=${metrics.lexical.floorFilteredByDense || 0} (idx=${indexReadyTime}ms search=${lexicalResult.searchTime || 0}ms total=${lexTime}ms)`);
        xbLog.info(MODULE_ID, `[Recall v9] Fusion (floor, weighted): dense=${metrics.fusion.denseFloors} lex=${metrics.fusion.lexFloors} -> cap=${metrics.fusion.afterCap} (${metrics.fusion.time}ms)`);
        xbLog.info(MODULE_ID, `[Recall v9] Fusion Guard: mustKeepTerms=${metrics.evidence.mustKeepTermsCount || 0} mustKeepFloors=[${(metrics.evidence.mustKeepFloors || []).join(', ')}]`);
        xbLog.info(MODULE_ID, `[Recall v9] Floor Rerank: ${metrics.evidence.beforeRerank || 0} -> ${metrics.evidence.floorsSelected || 0} floors -> L0=${metrics.evidence.l0Collected || 0} (${metrics.timing.evidenceRerank || 0}ms)`);
        xbLog.info(MODULE_ID, `[Recall v9] L1: prefetchedAI=${metrics.evidence.l1PrefetchAiFloors || 0} totalFloors=${metrics.evidence.l1PrefetchWithContextFloors || 0} | ${metrics.evidence.l1Pulled || 0} pulled -> ${metrics.evidence.l1Attached || 0} attached (${metrics.evidence.l1CosineTime || 0}ms)`);
        xbLog.info(MODULE_ID, `[Recall v9] L1 breakdown: chunkDB=${metrics.evidence.l1ChunkFetchTime || 0}ms vectorDB=${metrics.evidence.l1VectorFetchTime || 0}ms cacheWarm=${!!metrics.evidence.l1CacheWarm} chunkCache=${metrics.evidence.l1ChunkCacheHits || 0}/${metrics.evidence.l1ChunkCacheMisses || 0} vectorCache=${metrics.evidence.l1VectorCacheHits || 0}/${metrics.evidence.l1VectorCacheMisses || 0} deserialize=${metrics.evidence.l1DeserializeTime || 0}ms score=${metrics.evidence.l1ScoreTime || 0}ms sort=${metrics.evidence.l1SortTime || 0}ms vectors=${metrics.evidence.l1VectorHits || 0} missing=${metrics.evidence.l1MissingVectors || 0}`);
        xbLog.info(MODULE_ID, `[Recall v9] Events: ${eventHits.length} hits (l0Linked=+${l0LinkedCount}), ${causalChain.length} causal`);
        xbLog.info(MODULE_ID, `[Recall v9] Diffusion: ${metrics.diffusion?.seedCount || 0} seeds -> ${metrics.diffusion?.pprActivated || 0} activated -> ${metrics.diffusion?.finalCount || 0} final (${metrics.diffusion?.time || 0}ms | graph=${metrics.diffusion?.buildTime || 0}ms ppr=${metrics.diffusion?.pprTime || 0}ms post=${metrics.diffusion?.postVerifyTime || 0}ms)`);
    }

    if (directEvidenceContext && deferRuntimeRelease) {
        runtimeLease = transferDirectEvidenceRuntimeLease(
            directEvidenceContext,
            runtimeLease,
            true,
        );
    }

    return {
        events: eventHits,
        causalChain,
        l0Selected,
        l1ByFloor,
        directEvidenceContext,
        // 时间精确命中的楼层对 L2 事件同样适用：prompt 层的事件预算选择
        // 依赖它保证时间命中事件进入最终 Prompt（与 DIRECT 证据无关）。
        eventTemporalFloors: temporalCarrier.exactFloors,
        eventTemporalMarker: temporalCarrier.marker,
        focusEntities: focusTerms,
        focusTerms,
        focusCharacters,
        mustKeepFloors: mustKeepFloors || [],
        elapsed: metrics.timing.total,
        metrics,
    };
    } finally {
        if (runtimeLease) {
            const T_Runtime_End_Start = performance.now();
            try {
                await endRecallRuntimeSession(runtimeLease);
            } catch (error) {
                xbLog.warn(MODULE_ID, 'Recall runtime session release failed', error);
                recordRecallFallback(diagnostics, 'runtime-release', error);
            }
            metrics.timing.runtimeEndSession = Math.round(performance.now() - T_Runtime_End_Start);
        }
    }
    } finally {
        finalizeRecallTiming(metrics, T0);
    }
}
