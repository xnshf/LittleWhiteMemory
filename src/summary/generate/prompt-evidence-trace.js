// Replay observation only; no admission or charging decisions live here.
import { parseEventRange } from "../../vector/retrieval/temporal-turn-carrier.js";

export function createEvidenceTraceRecorder(causalById) {
    const value = { final: [], prompt: [], eventEvidence: [] };
    const units = { final: new Map(), prompt: new Map() };
    const anonymousIds = new WeakMap();
    let nextAnonymousId = 1;

    const objectUnitId = (prefix, item) => {
        const persistentId = String(item?.id || '').trim();
        if (persistentId) return `${prefix}:${persistentId}`;
        if (item && typeof item === 'object') {
            if (!anonymousIds.has(item)) anonymousIds.set(item, nextAnonymousId++);
            return `${prefix}:anonymous-${anonymousIds.get(item)}`;
        }
        return `${prefix}:anonymous-${nextAnonymousId++}`;
    };
    const addFloors = (target, unitId, rawFloors, source, score = null) => {
        if (!units[target]) return;
        const normalizedFloors = [...new Set((rawFloors || [])
            .map(Number)
            .filter(floor => Number.isInteger(floor) && floor >= 0))];
        if (!normalizedFloors.length) return;

        let unit = units[target].get(unitId);
        if (!unit) {
            unit = { rank: units[target].size + 1, floors: new Set() };
            units[target].set(unitId, unit);
        }
        for (const normalizedFloor of normalizedFloors) {
            if (unit.floors.has(normalizedFloor)) continue;
            unit.floors.add(normalizedFloor);
            value[target].push({
                floor: normalizedFloor,
                rank: unit.rank,
                unitId,
                score: Number.isFinite(score) ? score : null,
                source,
            });
        }
    };
    const floor = (target, rawFloor, source, score = null, unitId = null) => {
        const normalizedFloor = Number(rawFloor);
        if (!Number.isInteger(normalizedFloor) || normalizedFloor < 0) return;
        addFloors(target, unitId || `${source}:${normalizedFloor}`, [normalizedFloor], source, score);
    };
    const eventUnitId = item => objectUnitId('event', item);
    const event = (target, item, source, score = null, unitId = eventUnitId(item)) => {
        const range = parseEventRange(item?.summary);
        if (!range) return;
        const eventFloors = [];
        for (let current = range.start; current <= range.end; current++) {
            eventFloors.push(current);
        }
        addFloors(target, unitId, eventFloors, source, score);
    };
    const causal = (target, item, causeIds = item?.causedBy || []) => {
        const unitId = eventUnitId(item);
        for (const eventId of causeIds) {
            const cause = causalById?.get(eventId);
            event(target, cause?.event, 'causal', cause?.similarity ?? null, unitId);
        }
    };
    const eventEvidence = (target, item, rawFloor) => {
        floor(target, rawFloor, 'event-evidence', null, eventUnitId(item));
    };
    const fact = (target, item) => {
        floor(
            target,
            item?.since ?? item?._addedAt,
            'constraint',
            null,
            objectUnitId('constraint', item),
        );
    };
    const arc = (target, item) => {
        const floors = [];
        for (const moment of (item?.moments || [])) {
            if (typeof moment !== 'object' || moment == null) continue;
            if (!Number.isInteger(Number(moment._addedAt))) continue;
            floors.push(moment._addedAt);
        }
        if (!floors.length) floors.push(item?._addedAt);
        addFloors(target, objectUnitId('arc', item), floors, 'arc');
    };
    return { value, floor, event, causal, eventEvidence, fact, arc };
}
