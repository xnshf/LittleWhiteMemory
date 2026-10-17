import { getContext } from '../../../../../../extensions.js';
import {
    getRecallRuntimeEventVectorsByIds,
    getRecallRuntimeMeta,
    scoreRecallRuntimeEvents,
} from '../runtime/runtime.js';
import { getEngineFingerprint } from '../utils/embedder.js';
import { xbLog } from '../../support/debug-core.js';
import { normalize } from './floor-fusion.js';
import { calcSimilarityStats } from './metrics.js';
import { selectBoundedEventCandidates } from './event-candidate-selection.js';
import { selectDiverseEvents } from './event-diversity-selection.js';
import { eventOwnership, classifyEventRecall } from './event-recall-classification.js';
import { CONFIG } from './recall-config.js';

const MODULE_ID = 'recall';

// ═══════════════════════════════════════════════════════════════════════════
// [Events] L2 Events 检索
// 返回 { events, scoreMap }；不回传整库 event vectors
// ═══════════════════════════════════════════════════════════════════════════

export async function recallEvents(queryVector, allEvents, vectorConfig, focusCharacters, metrics, snapshot = null, signal = null) {
    const { chatId } = getContext();
    if (!chatId || !queryVector?.length || !allEvents?.length) {
        return { events: [], scoreMap: new Map(), vectorMap: new Map() };
    }
    const canUseSnapshot = snapshot?.chatId === chatId;

    const meta = canUseSnapshot && snapshot?.meta
        ? snapshot.meta
        : await getRecallRuntimeMeta(chatId, { signal });
    const fp = getEngineFingerprint(vectorConfig);
    if (meta?.fingerprint && meta.fingerprint !== fp) {
        xbLog.warn(MODULE_ID, 'Event fingerprint 不匹配');
        return { events: [], scoreMap: new Map(), vectorMap: new Map() };
    }

    const focusSet = new Set((focusCharacters || []).map(normalize));

    const runtimeScores = await scoreRecallRuntimeEvents(chatId, queryVector, { signal });
    if (metrics) {
        metrics.timing.runtimeScoreEvents = runtimeScores?.stats?.timings?.scoreEventsMs ?? null;
    }
    const scoreMap = new Map((runtimeScores?.scores || []).map((item) => [item.eventId, item.similarity]));
    if (!scoreMap.size) {
        return { events: [], scoreMap, vectorMap: new Map() };
    }

    const scored = allEvents.map(event => {
        const baseSim = scoreMap.get(event.id) ?? 0;

        const ownership = eventOwnership(event, focusSet);

        return {
            _id: event.id,
            event,
            similarity: baseSim,
            _ownership: ownership,
            vector: null,
        };
    });

    if (metrics) {
        metrics.event.inStore = allEvents.length;
    }

    let candidates = scored
        .filter(s => s.similarity >= CONFIG.EVENT_MIN_SIMILARITY)
        .sort((a, b) => b.similarity - a.similarity);

    // 实体过滤（准入规则不变：强语义 bypass 或明确谈焦点人物）
    if (focusSet.size > 0) {
        const beforeFilter = candidates.length;

        candidates = candidates.filter(c => {
            if (c.similarity >= CONFIG.EVENT_ENTITY_BYPASS_SIM) return true;
            return c._ownership === 'focus';
        });

        if (metrics) {
            metrics.event.entityFilter = {
                focusCharacters: focusCharacters || [],
                before: beforeFilter,
                after: candidates.length,
                filtered: beforeFilter - candidates.length,
            };
        }
    }

    candidates = selectBoundedEventCandidates(
        candidates, CONFIG.EVENT_CANDIDATE_MAX, snapshot?.temporalCarrier?.exactFloors,
    ).candidates;
    if (metrics) metrics.event.considered = candidates.length;
    const candidateEventIds = candidates.map(c => c._id).filter(Boolean);
    const candidateVectors = await getRecallRuntimeEventVectorsByIds(chatId, candidateEventIds, { signal });
    if (metrics) {
        metrics.timing.runtimeGetEventVectors = candidateVectors?._stats?.timings?.getEventVectorsByIdsMs ?? 0;
    }
    const vectorMap = new Map(candidateVectors.map(v => [v.eventId, v.vector]));
    for (const candidate of candidates) {
        candidate.vector = vectorMap.get(candidate._id) || null;
    }
    const missingCandidateVectors = Math.max(0, candidateEventIds.length - vectorMap.size);
    if (metrics) {
        metrics.event.candidateVectorsMissing = missingCandidateVectors;
    }
    if (missingCandidateVectors > 0) {
        xbLog.warn(MODULE_ID, `L2候选向量缺失 ${missingCandidateVectors}/${candidateEventIds.length}，MMR diversity 可能退化`);
    }
    // MMR 选择
    const diversified = selectDiverseEvents(
        candidates,
        CONFIG.EVENT_SELECT_MAX,
        CONFIG.EVENT_MMR_LAMBDA,
    );
    const { candidates: selected } = selectBoundedEventCandidates(
        candidates, CONFIG.EVENT_SELECT_MAX, snapshot?.temporalCarrier?.exactFloors, diversified,
    );

    let directCount = 0;
    let relatedCount = 0;
    const byOwnership = { focus: 0, other: 0, unknown: 0 };

    const results = selected.map(s => {
        const { ownership, recallType, evidenceEligible } = classifyEventRecall(
            s.event,
            focusSet,
            s.similarity,
            { evidenceMinSimilarity: CONFIG.EVENT_EVIDENCE_MIN_SIMILARITY },
        );
        byOwnership[ownership]++;
        if (recallType === 'DIRECT') directCount++;
        else relatedCount++;

        return {
            event: s.event,
            similarity: s.similarity,
            _recallType: recallType,
            _ownership: ownership,
            _evidenceEligible: evidenceEligible,
        };
    });

    if (metrics) {
        metrics.event.selected = results.length;
        metrics.event.byRecallType = { direct: directCount, related: relatedCount, causal: 0, lexical: 0, l0Linked: 0 };
        metrics.event.byOwnership = byOwnership;
        metrics.event.similarityDistribution = calcSimilarityStats(results.map(r => r.similarity));
    }

    return { events: results, scoreMap, vectorMap };
}
