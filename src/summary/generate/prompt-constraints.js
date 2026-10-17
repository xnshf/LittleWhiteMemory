// Fact relevance, people/world grouping and descending-budget admission.
import { getContext } from "../../../../../../extensions.js";
import { getFacts } from "../data/store.js";
import { buildTrustedCharacters } from "../../vector/retrieval/entity-lexicon.js";
import { filterConstraintsByRelevance } from "./constraint-filter.js";
import { estimateTokens, normalize, formatConstraintLine, formatConstraintsStructured } from "./prompt-format.js";

export const CONSTRAINT_MAX = 2000;

export function getKnownCharacters(store) {
    const { name1, name2 } = getContext();
    const names = buildTrustedCharacters(store, { name1, name2 }) || new Set();
    // L3 subject filtering deliberately includes name1, unlike the entity lexicon.
    if (name1) names.add(normalize(name1));
    return names;
}

/** Selected event participants first; focus characters only if none were found. */
export function buildConstraintPeopleDict(recallResult, focusCharacters = []) {
    const dict = new Map();
    const add = (raw) => {
        const display = String(raw || '').trim();
        const key = normalize(display);
        if (!display || !key) return;
        if (!dict.has(key)) dict.set(key, display);
    };
    const selectedEvents = recallResult?.events || [];
    for (const item of selectedEvents) {
        const participants = item?.event?.participants || [];
        for (const p of participants) add(p);
    }
    if (dict.size === 0) {
        for (const f of (focusCharacters || [])) add(f);
    }
    return dict;
}

export function groupConstraintsForDisplay(facts, peopleDict) {
    const people = new Map();
    const world = [];
    for (const f of (facts || [])) {
        const subjectNorm = normalize(f?.s);
        const displayName = peopleDict.get(subjectNorm);
        if (displayName) {
            if (!people.has(displayName)) people.set(displayName, []);
            people.get(displayName).push(f);
        } else {
            world.push(f);
        }
    }
    return { people, world };
}

function tryConsumeConstraintLineBudget(line, budgetState) {
    const cost = estimateTokens(line);
    if (budgetState.used + cost > budgetState.max) return false;
    budgetState.used += cost;
    return true;
}

function selectConstraintsByBudgetDesc(grouped, budgetState) {
    const selectedPeople = new Map();
    const selectedWorld = [];
    const people = grouped?.people || new Map();
    const world = grouped?.world || [];
    for (const [name, facts] of people.entries()) {
        const picked = [];
        const sorted = [...facts].sort((a, b) => (b.since || 0) - (a.since || 0));
        for (const f of sorted) {
            // Commit the fact and its still-unpaid headers together. A later
            // oversized fact cannot roll back earlier accepted facts.
            const lines = [];
            if (!selectedPeople.size) lines.push('people:');
            if (!picked.length) lines.push(`  ${name}:`);
            lines.push(`    ${formatConstraintLine(f, false)}`);
            if (!tryConsumeConstraintLineBudget(lines.join('\n'), budgetState)) continue;
            picked.push(f);
            selectedPeople.set(name, picked);
        }
    }
    const sortedWorld = [...world].sort((a, b) => (b.since || 0) - (a.since || 0));
    for (const f of sortedWorld) {
        const line = `  ${formatConstraintLine(f, true)}`;
        const text = selectedWorld.length ? line : `world:\n${line}`;
        if (!tryConsumeConstraintLineBudget(text, budgetState)) continue;
        selectedWorld.push(f);
    }
    return { people: selectedPeople, world: selectedWorld };
}

function factsInBudgetOrder(grouped) {
    const ordered = [];
    for (const facts of (grouped?.people || new Map()).values()) {
        ordered.push(...[...facts].sort((a, b) => (b.since || 0) - (a.since || 0)));
    }
    ordered.push(...[...(grouped?.world || [])].sort((a, b) => (b.since || 0) - (a.since || 0)));
    return ordered;
}

/** Synchronous stage: preserve fact/context reads and the original timing span. */
export function assembleVectorConstraints(store, recallResult, focusCharacters, assembled, injectionStats, metrics, evidenceTrace) {
    const T_Constraint_Start = performance.now();
    const allFacts = getFacts();
    const knownCharacters = getKnownCharacters(store);
    const filteredConstraints = filterConstraintsByRelevance(
        allFacts,
        focusCharacters,
        knownCharacters,
        getContext().name1,
    );
    const constraintPeopleDict = buildConstraintPeopleDict(recallResult, focusCharacters);
    const groupedConstraints = groupConstraintsForDisplay(filteredConstraints, constraintPeopleDict);
    if (evidenceTrace) {
        for (const fact of factsInBudgetOrder(groupedConstraints)) evidenceTrace.fact('final', fact);
    }
    if (metrics) {
        metrics.constraint.total = allFacts.length;
        metrics.constraint.filtered = allFacts.length - filteredConstraints.length;
    }
    const constraintBudget = { used: 0, max: CONSTRAINT_MAX };
    const groupedSelectedConstraints = selectConstraintsByBudgetDesc(groupedConstraints, constraintBudget);
    if (evidenceTrace) {
        for (const fact of factsInBudgetOrder(groupedSelectedConstraints)) evidenceTrace.fact('prompt', fact);
    }
    const injectedConstraintFacts = (() => {
        let count = groupedSelectedConstraints.world.length;
        for (const facts of groupedSelectedConstraints.people.values()) {
            count += facts.length;
        }
        return count;
    })();
    const constraintLines = formatConstraintsStructured(groupedSelectedConstraints, 'asc');
    if (constraintLines.length) {
        assembled.constraints.lines.push(...constraintLines);
        assembled.constraints.tokens = constraintBudget.used;
        injectionStats.constraint.count = assembled.constraints.lines.length;
        injectionStats.constraint.tokens = constraintBudget.used;
        injectionStats.constraint.filtered = allFacts.length - filteredConstraints.length;
        if (metrics) {
            metrics.constraint.injected = injectedConstraintFacts;
            metrics.constraint.tokens = constraintBudget.used;
            metrics.constraint.samples = assembled.constraints.lines.slice(0, 3).map(line =>
                line.length > 60 ? line.slice(0, 60) + '...' : line
            );
            metrics.timing.constraintFilter = Math.round(performance.now() - T_Constraint_Start);
        }
    } else if (metrics) {
        metrics.timing.constraintFilter = Math.round(performance.now() - T_Constraint_Start);
    }
    return allFacts;
}
