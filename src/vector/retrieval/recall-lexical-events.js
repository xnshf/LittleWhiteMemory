import { selectBoundedEventCandidates } from './event-candidate-selection.js';
import { classifyEventRecall } from './event-recall-classification.js';
import { CONFIG } from './recall-config.js';

// Append lexical-only candidates in lexical order, reserving eligible temporal winners.
// Return the shared ID set for the coordinator's later L0-linked event pass.
export function mergeLexicalEvents({ eventHits, eventIds, eventIndex, eventScoreMap, focusSet, temporalFloors, metrics }) {
    const existingEventIds = new Set(eventHits.map(e => e.event?.id).filter(Boolean));
    let lexicalEventCount = 0;
    let lexicalEventFilteredByDense = 0;
    const lexicalCandidates = [];

    for (const eid of eventIds) {
        if (existingEventIds.has(eid)) continue;

        const ev = eventIndex.get(eid);
        if (!ev) continue;

        // Dense gate: 验证 event 向量与 query 的语义相关性
        const sim = eventScoreMap.get(eid) ?? 0;
        if (!sim) {
            // 无向量无法验证相关性，丢弃
            lexicalEventFilteredByDense++;
            continue;
        }

        if (sim < CONFIG.LEXICAL_EVENT_DENSE_MIN) {
            lexicalEventFilteredByDense++;
            continue;
        }

        // 实体归属与 DIRECT 分类：与 Dense 路径统一标准
        const { ownership, recallType, evidenceEligible } = classifyEventRecall(
            ev,
            focusSet,
            sim,
            { evidenceMinSimilarity: CONFIG.EVENT_EVIDENCE_MIN_SIMILARITY },
        );

        lexicalCandidates.push({
            event: ev,
            similarity: sim,
            _recallType: recallType,
            _ownership: ownership,
            _evidenceEligible: evidenceEligible,
        });
    }
    // Keep the 100-additional-event cap, but reserve eligible temporal winners
    // before cutting the lexical tail. No new scoring/API calls are needed.
    const lexicalSelected = selectBoundedEventCandidates(
        lexicalCandidates, CONFIG.EVENT_CANDIDATE_MAX, temporalFloors,
    ).candidates;
    for (const candidate of lexicalSelected) {
        eventHits.push(candidate);
        existingEventIds.add(candidate.event.id);
    }
    lexicalEventCount = lexicalSelected.length;

    if (metrics) {
        metrics.lexical.eventFilteredByDense = lexicalEventFilteredByDense;

        if (lexicalEventCount > 0) {
            metrics.event.byRecallType.lexical = lexicalEventCount;
            metrics.event.selected += lexicalEventCount;
        }
    }

    return { existingEventIds, lexicalEventCount, lexicalEventFilteredByDense };
}
