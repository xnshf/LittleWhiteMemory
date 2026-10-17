// Story Summary - Stored-data normalization and legacy format migration
// Mutates stored objects in place; preserves the existing reference/changed semantics.

import { normalizeCharacterAliases } from './character-aliases.js';
import { isLegacySummaryHistoryEntry, normalizeSummaryUndo } from './summary-undo.js';

export function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return { value: [], changed: value != null };
    }

    const next = [];
    let changed = false;
    for (const item of value) {
        let text = '';
        if (typeof item === 'string') {
            text = item.trim();
        } else if (isPlainObject(item)) {
            // Old data may store names/ids as lightweight objects; only accept explicit text-like fields.
            text = String(item.name || item.text || item.id || '').trim();
            changed = true;
        } else if (item != null) {
            changed = true;
        }
        if (!text) {
            if (item != null) changed = true;
            continue;
        }
        next.push(text);
        if (typeof item !== 'string' || item !== text) {
            changed = true;
        }
    }

    if (!changed && next.length !== value.length) {
        changed = true;
    }

    return { value: changed ? next : value, changed };
}

function normalizeSummaryHistory(history) {
    if (!Array.isArray(history)) {
        return { value: [], changed: history != null };
    }

    const next = [];
    let changed = false;
    for (const item of history) {
        const endMesId = Number(item?.endMesId);
        if (!Number.isFinite(endMesId)) {
            changed = true;
            continue;
        }
        const normalizedEndMesId = Math.trunc(endMesId);
        const isExactFormat = item?.format === 1;
        const undo = isExactFormat ? normalizeSummaryUndo(item.undo) : null;
        const previousEndMesId = Number(item?.previousEndMesId);
        const hasExactBoundary = isExactFormat
            && undo
            && Number.isInteger(previousEndMesId)
            && previousEndMesId < normalizedEndMesId;
        const normalized = hasExactBoundary
            ? { format: 1, previousEndMesId, endMesId: normalizedEndMesId, undo }
            : (isLegacySummaryHistoryEntry(item)
                ? { endMesId: normalizedEndMesId }
                : { format: 1, endMesId: normalizedEndMesId });
        const itemIsCanonical = isPlainObject(item)
            && item.endMesId === normalizedEndMesId
            && (hasExactBoundary
                ? item.format === 1 && item.previousEndMesId === previousEndMesId && undo === item.undo
                : (normalized.format === 1
                    ? item.format === 1 && item.undo == null && item.previousEndMesId == null
                    : item.format == null && item.undo == null && item.previousEndMesId == null))
            && Object.keys(item).every(key => key === 'format' || key === 'previousEndMesId' || key === 'endMesId' || key === 'undo');
        next.push(itemIsCanonical ? item : normalized);
        if (!itemIsCanonical) {
            changed = true;
        }
    }

    if (!changed && next.length !== history.length) {
        changed = true;
    }

    return { value: changed ? next : history, changed };
}

export function normalizeSummaryJson(json) {
    if (json == null) {
        return { value: null, changed: false };
    }

    if (!isPlainObject(json)) {
        return {
            value: {
                keywords: [],
                events: [],
                characters: { main: [] },
                arcs: [],
                facts: [],
            },
            changed: true,
        };
    }

    let changed = false;
    const next = json;

    const normalizedKeywords = Array.isArray(next.keywords)
        ? next.keywords.filter(isPlainObject)
        : [];
    if (!Array.isArray(next.keywords) || normalizedKeywords.length !== next.keywords.length) {
        next.keywords = normalizedKeywords;
        changed = true;
    }

    if (!Array.isArray(next.events)) {
        next.events = [];
        changed = true;
    } else {
        const events = [];
        for (const event of next.events) {
            if (!isPlainObject(event)) {
                changed = true;
                continue;
            }

            let normalizedEvent = event;

            const participants = normalizeStringArray(event.participants);
            if (participants.changed) {
                normalizedEvent = normalizedEvent === event ? { ...event } : normalizedEvent;
                normalizedEvent.participants = participants.value;
                changed = true;
            }

            const causedBy = normalizeStringArray(event.causedBy);
            if (causedBy.changed) {
                normalizedEvent = normalizedEvent === event ? { ...event } : normalizedEvent;
                normalizedEvent.causedBy = causedBy.value;
                changed = true;
            }

            events.push(normalizedEvent);
        }

        if (events.length !== next.events.length) {
            changed = true;
        }
        if (changed) {
            next.events = events;
        }
    }

    if (!isPlainObject(next.characters)) {
        next.characters = { main: [] };
        changed = true;
    } else if (!Array.isArray(next.characters.main)) {
        next.characters.main = [];
        changed = true;
    } else {
        const main = next.characters.main.filter(item => typeof item === 'string' || isPlainObject(item));
        if (main.length !== next.characters.main.length) {
            next.characters.main = main;
            changed = true;
        }
    }

    if (!Array.isArray(next.arcs)) {
        next.arcs = [];
        changed = true;
    } else {
        const arcs = [];
        for (const arc of next.arcs) {
            if (!isPlainObject(arc)) {
                changed = true;
                continue;
            }

            const moments = Array.isArray(arc.moments)
                ? arc.moments.filter(item => typeof item === 'string' || isPlainObject(item))
                : [];

            if (!Array.isArray(arc.moments) || moments.length !== arc.moments.length) {
                arcs.push({ ...arc, moments });
                changed = true;
                continue;
            }

            arcs.push(arc);
        }

        if (arcs.length !== next.arcs.length) {
            changed = true;
        }
        if (changed) {
            next.arcs = arcs;
        }
    }

    const normalizedAliases = normalizeCharacterAliases(next.characterAliases);
    if (next.characterAliases == null) {
        // Keep the optional alias table absent until it is actually needed.
    } else if (!Array.isArray(next.characterAliases)) {
        next.characterAliases = normalizedAliases;
        changed = true;
    } else if (JSON.stringify(normalizedAliases) !== JSON.stringify(next.characterAliases)) {
        next.characterAliases = normalizedAliases;
        changed = true;
    }

    if (!Array.isArray(next.facts)) {
        const hasOldData = next.world?.length || next.characters?.relationships?.length;
        if (hasOldData) {
            next.facts = migrateToFacts(next);
            delete next.world;
            delete next.characters.relationships;
        } else {
            next.facts = [];
        }
        changed = true;
    } else {
        const facts = next.facts.filter(isPlainObject);
        if (facts.length !== next.facts.length) {
            next.facts = facts;
            changed = true;
        }
    }

    return { value: next, changed };
}

export function normalizeSummaryStore(store) {
    if (!store || !isPlainObject(store)) {
        return false;
    }

    let changed = false;

    if (store.lastSummarizedMesId != null) {
        const lastSummarizedMesId = Number(store.lastSummarizedMesId);
        if (!Number.isFinite(lastSummarizedMesId)) {
            if (store.lastSummarizedMesId !== -1) {
                store.lastSummarizedMesId = -1;
                changed = true;
            }
        } else {
            const normalizedMesId = Math.trunc(lastSummarizedMesId);
            if (store.lastSummarizedMesId !== normalizedMesId) {
                store.lastSummarizedMesId = normalizedMesId;
                changed = true;
            }
        }
    }

    const history = normalizeSummaryHistory(store.summaryHistory);
    if (history.changed) {
        store.summaryHistory = history.value;
        changed = true;
    }

    const pendingImportBoundary = store.pendingImportBoundary;
    if (pendingImportBoundary == null || pendingImportBoundary === false) {
        if ('pendingImportBoundary' in store) {
            delete store.pendingImportBoundary;
            changed = true;
        }
    } else if (pendingImportBoundary !== true) {
        store.pendingImportBoundary = true;
        changed = true;
    }

    // Persistent integrity state: a failed rollback must remain blocked after reload
    // until a successful rollback, clear, or import establishes a new canonical base.
    if (store.summaryInvalid !== true && 'summaryInvalid' in store) {
        delete store.summaryInvalid;
        changed = true;
    }

    const json = normalizeSummaryJson(store.json);
    if (json.changed) {
        store.json = json.value;
        changed = true;
    }

    // Alias mappings are identity vocabulary, not summary-history state.
    // Old versions persisted rollback-only migration snapshots; they no
    // longer describe any live behavior and are discarded at the upgrade edge.
    if (Object.hasOwn(store, 'aliasMigrations')) {
        delete store.aliasMigrations;
        changed = true;
    }

    return changed;
}

// ═══════════════════════════════════════════════════════════════════════════
// 旧数据迁移
// ═══════════════════════════════════════════════════════════════════════════

export function migrateToFacts(json) {
    if (!json) return [];

    // 已有 facts 则跳过迁移
    if (json.facts?.length) return json.facts;

    const facts = [];
    let nextId = 1;

    // 迁移 world（worldUpdate 的持久化结果）
    for (const w of json.world || []) {
        if (!w.category || !w.topic || !w.content) continue;

        let s, p;

        // 解析 topic 格式：status/knowledge/relation 用 "::" 分隔
        if (w.topic.includes('::')) {
            [s, p] = w.topic.split('::').map(x => x.trim());
        } else {
            // inventory/rule 类
            s = w.topic.trim();
            p = w.category;
        }

        if (!s || !p) continue;

        facts.push({
            id: `f-${nextId++}`,
            s,
            p,
            o: w.content.trim(),
            since: w.floor ?? w._addedAt ?? 0,
            _addedAt: w._addedAt ?? w.floor ?? 0,
        });
    }

    // 迁移 relationships
    for (const r of json.characters?.relationships || []) {
        if (!r.from || !r.to) continue;

        facts.push({
            id: `f-${nextId++}`,
            s: r.from,
            p: `对${r.to}的看法`,
            o: r.label || '未知',
            trend: r.trend,
            since: r._addedAt ?? 0,
            _addedAt: r._addedAt ?? 0,
        });
    }

    return facts;
}
