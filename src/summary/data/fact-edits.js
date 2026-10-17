import { isRelationFact, parseRelationTarget } from "./fact-predicates.js";

function getNextFactIdValue(facts) {
    let max = 0;
    for (const fact of facts || []) {
        const match = String(fact?.id || "").match(/^f-(\d+)$/);
        if (match) max = Math.max(max, Number.parseInt(match[1], 10) || 0);
    }
    return max + 1;
}

export function mergeCharacterRelationshipsIntoFacts(existingFacts, relationships, floorHint = 0) {
    const safeFacts = Array.isArray(existingFacts) ? existingFacts : [];
    const safeRels = Array.isArray(relationships) ? relationships : [];

    const nonRelationFacts = safeFacts.filter((fact) => fact?.retracted || !isRelationFact(fact));
    const oldRelationByKey = new Map();

    for (const fact of safeFacts) {
        const to = parseRelationTarget(fact?.p);
        const from = String(fact?.s || "").trim();
        if (!from || !to) continue;
        oldRelationByKey.set(`${from}->${to}`, fact);
    }

    let nextFactId = getNextFactIdValue(safeFacts);
    const newRelationFacts = [];

    for (const rel of safeRels) {
        const from = String(rel?.from || "").trim();
        const to = String(rel?.to || "").trim();
        if (!from || !to) continue;

        const key = `${from}->${to}`;
        const oldFact = oldRelationByKey.get(key);
        const label = String(rel?.label || "").trim() || "未知";
        const trend = String(rel?.trend || "").trim() || "陌生";
        const id = oldFact?.id || `f-${nextFactId++}`;

        newRelationFacts.push({
            id,
            s: from,
            p: oldFact?.p || `对${to}的关系`,
            o: label,
            trend,
            since: oldFact?.since ?? floorHint,
            _addedAt: oldFact?._addedAt ?? floorHint,
        });
    }

    return [...nonRelationFacts, ...newRelationFacts];
}

function factKeyBySubjectPredicate(fact) {
    const s = String(fact?.s || "").trim();
    const p = String(fact?.p || "").trim();
    return `${s}::${p}`;
}

export function mergeEditedFactsWithTimestamps(existingFacts, editedFacts, floorHint = 0) {
    const currentFacts = Array.isArray(existingFacts) ? existingFacts : [];
    const incomingFacts = Array.isArray(editedFacts) ? editedFacts : [];
    const oldMap = new Map(currentFacts.map((f) => [factKeyBySubjectPredicate(f), f]));

    let nextFactId = getNextFactIdValue(currentFacts);
    const merged = [];

    for (const fact of incomingFacts) {
        const s = String(fact?.s || "").trim();
        const p = String(fact?.p || "").trim();
        const o = String(fact?.o || "").trim();
        if (!s || !p || !o) continue;

        const key = `${s}::${p}`;
        const oldFact = oldMap.get(key);
        const since = oldFact?.since ?? fact?.since ?? floorHint;
        const addedAt = oldFact?._addedAt ?? fact?._addedAt ?? floorHint;

        const out = {
            id: oldFact?.id || fact?.id || `f-${nextFactId++}`,
            s,
            p,
            o,
            since,
            _addedAt: addedAt,
        };
        if (oldFact?._isState != null) out._isState = oldFact._isState;

        const mergedTrend = fact?.trend ?? oldFact?.trend;
        if (mergedTrend != null && String(mergedTrend).trim()) {
            out.trend = String(mergedTrend).trim();
        }
        merged.push(out);
    }

    return merged;
}
