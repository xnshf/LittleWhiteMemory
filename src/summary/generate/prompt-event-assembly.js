// Event admission and evidence ownership. Hydration and release stay in prompt.js.
import { parseEventRange, TEMPORAL_PROTECTION_POLICY } from "../../vector/retrieval/temporal-turn-carrier.js";
import { buildRankRelevance } from "./direct-evidence-packing.js";
import { buildTemporalEventPackingOrder } from "./temporal-event-packing.js";
import { packEventEvidence } from "./event-evidence-packing.js";
import {
    estimateTokens, buildL0DisplayText, formatL1Line, buildEvidenceGroup, formatEventWithEvidence,
} from "./prompt-format.js";

export const EVENT_BUDGET_MAX = 5000;
const RELATED_EVENT_MAX = 500;
const TOP_N_STAR = 5;
const DIRECT_EVIDENCE_FLOOR_OVERHEAD_TOKENS = 10;

function getEventSortKey(event) {
    const r = parseEventRange(event?.summary);
    if (r) return r.start;
    const m = String(event?.id || "").match(/evt-(\d+)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

function eventTraceSource(item) {
    if (item?._recallType === 'DIRECT') return 'direct-event';
    if (item?._recallType === 'CAUSAL') return 'causal-event';
    return 'related-event';
}

/** Select complete events before requesting their L1 evidence. */
export function selectPromptEvents(recallResult, injectionStats, metrics, evidenceTrace) {
    const candidates = (recallResult?.events || []).filter(e => e?.event?.summary);
    const eventRankingScore = item => Number.isFinite(item?._eventRerankScore)
        ? item._eventRerankScore
        : Number(item?.similarity || 0);
    if (evidenceTrace) {
        for (const item of candidates) {
            evidenceTrace.event('final', item.event, eventTraceSource(item), eventRankingScore(item));
            evidenceTrace.causal('final', item.event);
        }
    }
    const eventBudget = { used: 0, max: EVENT_BUDGET_MAX };
    const relatedBudget = { used: 0, max: RELATED_EVENT_MAX };
    const selectedDirect = [];
    const selectedRelated = [];

    // One ordinary-rank winner per temporal floor, at most five globally.
    // Overflow rejoins ordinary admission; neither ledger is relaxed.
    const eventTemporalFloors = (recallResult?.eventTemporalFloors || []).filter(Number.isInteger);
    let temporalProtectedCount = 0;
    let temporalDroppedCount = 0;
    const temporalEventPacking = buildTemporalEventPackingOrder(candidates, eventTemporalFloors);
    const eventPackingOrder = temporalEventPacking.order;

    let eventBudgetRejected = 0;
    let eventRelatedBudgetRejected = 0;
    for (let packingIndex = 0; packingIndex < eventPackingOrder.length; packingIndex++) {
        const { candidateRank, temporal } = eventPackingOrder[packingIndex];
        const e = candidates[candidateRank];
        if (eventBudget.used >= eventBudget.max) {
            if (temporal) {
                temporalDroppedCount++;
                eventBudgetRejected++;
                continue;
            }
            eventBudgetRejected += eventPackingOrder.length - packingIndex;
            break;
        }
        const isDirect = e._recallType === "DIRECT";
        if (!isDirect && relatedBudget.used >= relatedBudget.max) {
            if (temporal) temporalDroppedCount++;
            eventRelatedBudgetRejected++;
            continue;
        }
        const text = formatEventWithEvidence(e, 0, []);
        const cost = estimateTokens(text);
        const fitEventBudget = eventBudget.used + cost <= eventBudget.max;
        const fitRelatedBudget = isDirect || (relatedBudget.used + cost <= relatedBudget.max);
        if (!fitEventBudget || !fitRelatedBudget) {
            if (temporal) temporalDroppedCount++;
            if (!fitEventBudget) {
                eventBudgetRejected++;
                // Oversized events do not block later complete events that fit.
                continue;
            }
            eventRelatedBudgetRejected++;
            continue;
        }
        if (temporal) temporalProtectedCount++;
        const selected = {
            event: e.event,
            evidenceGroups: [],
            candidateRank,
        };
        (isDirect ? selectedDirect : selectedRelated).push(selected);
        injectionStats.event.selected++;
        injectionStats.event.tokens += cost;
        eventBudget.used += cost;
        if (!isDirect) relatedBudget.used += cost;
    }
    if (metrics) {
        metrics.event.temporalFloorsProtected = eventTemporalFloors.length;
        metrics.event.temporalProtected = temporalProtectedCount;
        metrics.event.temporalDropped = temporalDroppedCount;
        metrics.event.temporalWinners = temporalEventPacking.winnerCount;
        metrics.event.temporalProtectionCap = TEMPORAL_PROTECTION_POLICY.maxProtectedEvents;
        metrics.event.temporalOverflow = temporalEventPacking.overflowCount;
        metrics.event.budgetTruncated = {
            candidates: candidates.length,
            selected: injectionStats.event.selected,
            dropped: Math.max(0, candidates.length - injectionStats.event.selected),
            budgetRejected: eventBudgetRejected,
            relatedBudgetRejected: eventRelatedBudgetRejected,
        };
    }
    return { candidates, selectedDirect, selectedRelated };
}

function directEvidenceItemTokens(item) {
    if (item.kind === 'l0') {
        return estimateTokens(buildL0DisplayText(item.l0));
    }
    return estimateTokens(formatL1Line(item.chunk, item.chunk.isUser === true));
}

/** L1 retains its selected owner; L0/fallback use the first matching candidate. */
function enumerateDirectEvidenceItems(selectedInPackingOrder, l0Selected, directL1Candidates, relevance) {
    const ownedRanges = selectedInPackingOrder
        .map(selected => {
            const range = parseEventRange(selected.event?.summary);
            return range ? { selected, range } : null;
        })
        .filter(Boolean);
    const findOwner = floor => (
        ownedRanges.find(({ range }) => floor >= range.start && floor <= range.end)?.selected || null
    );
    const l0Items = [];
    const seenL0Ids = new Set();
    for (const l0 of l0Selected || []) {
        const owner = findOwner(l0.floor);
        if (!owner) continue;
        const id = `l0:${l0.id}`;
        if (seenL0Ids.has(id)) continue;
        seenL0Ids.add(id);
        l0Items.push({
            kind: 'l0',
            id,
            floor: l0.floor,
            l0,
            owner,
            score: Number(relevance.l0ByFloor?.get(l0.floor) || 0),
            temporal: false,
        });
    }
    // Fallback L1 is eligible only once an L0 on its parent floor is admitted.
    const fallbackItems = [];
    const l1Items = [];
    const seenL1Ids = new Set();
    for (const chunk of directL1Candidates || []) {
        if (!chunk?.chunkId) continue;
        const id = `l1:${chunk.chunkId}`;
        if (seenL1Ids.has(id)) continue;
        const fallbackParentFloor = Number.isInteger(chunk?._directEvidenceFallbackParentFloor)
            ? chunk._directEvidenceFallbackParentFloor
            : null;
        const itemFloor = fallbackParentFloor ?? Number(chunk.floor);
        if (!Number.isInteger(itemFloor)) continue;
        const owner = chunk.ownerEventId
            ? ownedRanges.find(({ selected, range }) => selected.event.id === chunk.ownerEventId
                && itemFloor >= range.start && itemFloor <= range.end)?.selected
            : findOwner(itemFloor);
        if (!owner) continue;
        seenL1Ids.add(id);
        const item = {
            kind: 'l1',
            id,
            floor: itemFloor,
            chunk,
            owner,
            score: Number(relevance.l1ByChunkId?.get(chunk.chunkId) || 0),
            temporal: chunk._directEvidenceTemporalCarrier === true,
            ordinaryEligible: chunk._directEvidencePassedMinScore !== false,
            fallbackParentFloor,
        };
        if (fallbackParentFloor != null) fallbackItems.push(item);
        else l1Items.push(item);
    }
    return { l0Items, l1Items, fallbackItems };
}

/** Group admitted items for presentation only, never for admission. */
function attachAdmittedEvidenceToEvents(admittedItems) {
    for (const item of admittedItems || []) {
        if (!item.owner.evidenceGroups) item.owner.evidenceGroups = [];
    }
    const byOwner = new Map();
    for (const item of admittedItems || []) {
        if (!byOwner.has(item.owner)) byOwner.set(item.owner, new Map());
        const floors = byOwner.get(item.owner);
        if (!floors.has(item.floor)) floors.set(item.floor, { l0Atoms: [], l1Chunks: [] });
        const bucket = floors.get(item.floor);
        if (item.kind === 'l0') bucket.l0Atoms.push(item.l0);
        else bucket.l1Chunks.push(item.chunk);
    }
    for (const [owner, floors] of byOwner) {
        const groups = [];
        for (const [floor, bucket] of floors) {
            const group = buildEvidenceGroup(floor, bucket.l0Atoms, bucket.l1Chunks);
            group.temporal = bucket.l1Chunks.some(chunk => chunk._directEvidenceTemporalCarrier === true);
            groups.push(group);
        }
        groups.sort((left, right) => left.floor - right.floor);
        owner.evidenceGroups = groups;
    }
}

export function markEvidenceGroupUsed(group, usedEvidenceIds) {
    for (const l0 of group?.l0Atoms || []) usedEvidenceIds.add(`l0:${l0.id}`);
    for (const chunk of group?.l1Chunks || []) usedEvidenceIds.add(`l1:${chunk.chunkId}`);
}

function l1FallbackFromPairs(l1ByFloor) {
    const byId = new Map();
    for (const [parentFloor, pair] of l1ByFloor || []) {
        const normalizedParentFloor = Number(parentFloor);
        if (!Number.isInteger(normalizedParentFloor)) continue;
        for (const chunk of [pair?.userTop1, pair?.aiTop1]) {
            if (!chunk?.chunkId || byId.has(chunk.chunkId)) continue;
            byId.set(chunk.chunkId, {
                ...chunk,
                _directEvidenceFallbackParentFloor: normalizedParentFloor,
            });
        }
    }
    return [...byId.values()];
}

export function unusedL1PairChunks(l1ByFloor, floor, usedEvidenceIds) {
    const pair = l1ByFloor.get(floor);
    return [pair?.userTop1, pair?.aiTop1].filter(chunk => (
        chunk?.chunkId && !usedEvidenceIds.has(`l1:${chunk.chunkId}`)
    ));
}

/** Admit individual evidence, then claim stable IDs in the caller's shared set. */
export function assembleEventEvidence({
    selection, selectedEvidenceOwners, l0Selected, l1ByFloor, directEvidenceL1, directEvidenceStatus,
    causalById, eventEvidenceBudget, temporalEvidenceProtectionBudget, usedEvidenceIds,
    injectionStats, metrics, evidenceTrace,
}) {
    const { selectedDirect, selectedRelated } = selection;
    const hasSelectedL1 = ['applied', 'partial-vectors'].includes(directEvidenceStatus);
    const directL1Candidates = hasSelectedL1
        ? (directEvidenceL1 || [])
        : l1FallbackFromPairs(l1ByFloor);
    const directEvidenceRelevance = {
        l0ByFloor: buildRankRelevance(l0Selected, l0 => l0.floor),
        l1ByChunkId: hasSelectedL1
            ? buildRankRelevance(directL1Candidates, chunk => chunk.chunkId)
            : new Map(),
    };
    const enumeration = enumerateDirectEvidenceItems(
        selectedEvidenceOwners,
        l0Selected,
        directL1Candidates,
        directEvidenceRelevance,
    );
    if (evidenceTrace) {
        for (const item of [...enumeration.l0Items, ...enumeration.l1Items, ...enumeration.fallbackItems]) {
            evidenceTrace.eventEvidence('final', item.owner.event, item.floor);
        }
    }
    selectedDirect.sort((a, b) => getEventSortKey(a.event) - getEventSortKey(b.event));
    selectedRelated.sort((a, b) => getEventSortKey(a.event) - getEventSortKey(b.event));
    const causalOwners = [
        ...selectedDirect.map((item, index) => ({ ...item, label: `[印象深的事]第${index + 1}条` })),
        ...selectedRelated.map((item, index) => ({ ...item, label: `[其他人的事]第${index + 1}条` })),
    ].sort((left, right) => left.candidateRank - right.candidateRank);
    const packed = packEventEvidence({
        ...enumeration,
        causalOwners, causesById: causalById, budget: eventEvidenceBudget,
        estimateTokens, getTokenCost: directEvidenceItemTokens,
        floorOverheadTokens: DIRECT_EVIDENCE_FLOOR_OVERHEAD_TOKENS,
        protectedBudget: temporalEvidenceProtectionBudget,
    });
    const allAdmittedItems = packed.items;
    const causalEvidence = packed.causal;
    if (evidenceTrace) {
        const admitted = new Set(allAdmittedItems.map(item => item.id));
        evidenceTrace.value.eventEvidence = [
            ...enumeration.l0Items, ...enumeration.l1Items, ...enumeration.fallbackItems,
        ].map(item => ({
            id: item.id, kind: item.kind, floor: item.floor,
            ownerEventId: item.owner.event.id,
            lane: item.chunk?.evidenceLane || (item.kind === 'l0' ? 'l0' : 'fallback'),
            score: item.score,
            eventScore: item.chunk?.eventScore ?? null,
            queryScore: item.chunk?.queryScore ?? null,
            lexicalScore: item.chunk?.lexicalScore ?? null,
            tokenCost: directEvidenceItemTokens(item),
            temporal: item.temporal,
            admitted: admitted.has(item.id),
        }));
    }
    for (const item of allAdmittedItems) {
        usedEvidenceIds.add(item.id);
        if (evidenceTrace) evidenceTrace.eventEvidence('prompt', item.owner.event, item.floor);
    }
    attachAdmittedEvidenceToEvents(allAdmittedItems);
    injectionStats.directEvidence.units = allAdmittedItems.reduce(
        (floors, item) => {
            floors.add(`${item.owner.candidateRank}:${item.floor}`);
            return floors;
        },
        new Set(),
    ).size;
    injectionStats.directEvidence.l0 = allAdmittedItems.filter(item => item.kind === 'l0').length;
    injectionStats.directEvidence.l1 = allAdmittedItems.filter(item => item.kind === 'l1').length;
    const directEvidenceEnumeratedCount = enumeration.l0Items.length
        + enumeration.l1Items.length
        + enumeration.fallbackItems.length;
    const directEvidenceTemporalProtectedItems = allAdmittedItems.filter(item => item.temporalProtected === true);
    injectionStats.directEvidence.tokens = eventEvidenceBudget.used - causalEvidence.stats.tokens;
    // Actual charged ledger includes each floor's first heading overhead.
    const directEvidenceTemporalProtectedTokens = temporalEvidenceProtectionBudget.used;
    if (metrics?.evidence) {
        metrics.evidence.directEvidencePromptGroups = injectionStats.directEvidence.units;
        metrics.evidence.directEvidencePromptItems = injectionStats.directEvidence.l0 + injectionStats.directEvidence.l1;
        metrics.evidence.directEvidencePromptTokens = injectionStats.directEvidence.tokens;
        metrics.evidence.l0ProtectedTokens = packed.l0ProtectedTokens;
        metrics.evidence.directEvidenceEnumerated = directEvidenceEnumeratedCount;
        metrics.evidence.directEvidenceAdmitted = allAdmittedItems.length;
        metrics.evidence.directEvidenceSkippedByBudget = Math.max(
            0,
            directEvidenceEnumeratedCount - allAdmittedItems.length,
        );
        metrics.evidence.directEvidenceTemporalProtectedItems = directEvidenceTemporalProtectedItems.length;
        metrics.evidence.directEvidenceTemporalProtectedTokens = directEvidenceTemporalProtectedTokens;
        metrics.evidence.directEvidenceTemporalProtectionBudgetMax = temporalEvidenceProtectionBudget.max;
    }
    return { causalEvidence, causalOwners };
}

/** Called after distant evidence admission, at the original rendering point. */
export function renderPromptEvents(selection, causalEvidence, causalOwners, assembled, evidenceTrace) {
    const { candidates, selectedDirect, selectedRelated } = selection;
    const renderSelectedEvent = (item, index) => formatEventWithEvidence(
        item.event,
        index + 1,
        item.evidenceGroups,
        (causalEvidence.byEvent.get(item.event.id) || []).map(cause => cause.text),
    );
    assembled.directEvents.lines = selectedDirect.map((item, index) => {
        const text = renderSelectedEvent(item, index);
        return item.candidateRank < TOP_N_STAR ? `⭐${text}` : text;
    });
    assembled.relatedEvents.lines = selectedRelated.map(renderSelectedEvent);
    if (evidenceTrace) {
        for (const item of causalOwners) {
            evidenceTrace.event('prompt', item.event, eventTraceSource(candidates[item.candidateRank]));
            evidenceTrace.causal('prompt', item.event,
                (causalEvidence.byEvent.get(item.event.id) || []).map(cause => cause.causeId));
        }
    }
}
