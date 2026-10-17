// Story Summary - Data-only L2/L3 merging

import { applyCharacterAliasUpdates, canonicalizeIncrementalSummaryData } from './character-aliases.js';
import { buildSummaryUndo } from './summary-undo.js';
import { isRelationFact } from './fact-predicates.js';
import { projectSummaryEvent } from './events.js';

const FACTS_LIMIT_PER_SUBJECT = 10;

/**
 * 生成 fact 的唯一键（s + p）
 */
function factKey(f) {
    return `${f.s}::${f.p}`;
}

/**
 * 生成下一个 fact ID
 */
function getNextFactId(existingFacts) {
    let maxId = 0;
    for (const f of existingFacts || []) {
        const match = f.id?.match(/^f-(\d+)$/);
        if (match) {
            maxId = Math.max(maxId, parseInt(match[1], 10));
        }
    }
    return maxId + 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// Facts 合并（KV 覆盖模型）
// ═══════════════════════════════════════════════════════════════════════════

export function mergeFacts(existingFacts, updates, floor) {
    const map = new Map();

    for (const f of existingFacts || []) {
        if (!f.retracted) {
            map.set(factKey(f), f);
        }
    }

    let nextId = getNextFactId(existingFacts);

    for (const u of updates || []) {
        if (!u.s || !u.p) continue;

        const key = factKey(u);

        if (u.retracted === true) {
            map.delete(key);
            continue;
        }

        if (!u.o || !String(u.o).trim()) continue;

        const existing = map.get(key);
        const newFact = {
            id: existing?.id || `f-${nextId++}`,
            s: u.s.trim(),
            p: u.p.trim(),
            o: String(u.o).trim(),
            since: floor,
            _isState: existing?._isState ?? !!u.isState,
        };

        if (isRelationFact(newFact) && u.trend) {
            newFact.trend = u.trend;
        }

        if (existing?._addedAt != null) {
            newFact._addedAt = existing._addedAt;
        } else {
            newFact._addedAt = floor;
        }

        map.set(key, newFact);
    }

    const factsBySubject = new Map();
    for (const f of map.values()) {
        if (f._isState) continue;
        const arr = factsBySubject.get(f.s) || [];
        arr.push(f);
        factsBySubject.set(f.s, arr);
    }

    const toRemove = new Set();
    for (const arr of factsBySubject.values()) {
        if (arr.length > FACTS_LIMIT_PER_SUBJECT) {
            arr.sort((a, b) => (a._addedAt || 0) - (b._addedAt || 0));
            for (let i = 0; i < arr.length - FACTS_LIMIT_PER_SUBJECT; i++) {
                toRemove.add(factKey(arr[i]));
            }
        }
    }

    return Array.from(map.values()).filter(f => !toRemove.has(factKey(f)));
}

function normalizeCharacterNameKey(name) {
    return String(name || '').trim().toLowerCase();
}

function normalizeArcProgress(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

// ═══════════════════════════════════════════════════════════════════════════
// 数据合并（L2 + L3）
// ═══════════════════════════════════════════════════════════════════════════

export function mergeNewData(oldJson, parsed, endMesId, options = {}) {
    const beforeJson = structuredClone(oldJson || {});
    const merged = structuredClone(oldJson || {});
    const incoming = canonicalizeIncrementalSummaryData(parsed || {}, merged.characterAliases || []);

    // L2 初始化
    merged.keywords ||= [];
    merged.events ||= [];
    merged.characters ||= {};
    merged.characters.main ||= [];
    merged.arcs ||= [];

    // L3 初始化（不再迁移，getSummaryStore 已处理）
    merged.facts ||= [];

    // L2 数据合并
    if (incoming.keywords?.length) {
        merged.keywords = incoming.keywords.map(k => ({ ...k, _addedAt: endMesId }));
    }

    (incoming.events || []).forEach(e => {
        merged.events.push(projectSummaryEvent({ ...e, _addedAt: endMesId }));
    });

    // newCharacters
    const existingMain = new Set(
        (merged.characters.main || [])
            .map(m => normalizeCharacterNameKey(typeof m === 'string' ? m : m.name))
            .filter(Boolean)
    );
    (incoming.newCharacters || []).forEach(rawName => {
        const name = String(typeof rawName === 'string' ? rawName : rawName?.name || '').trim();
        const key = normalizeCharacterNameKey(name);
        if (!key) return;
        if (!existingMain.has(key)) {
            merged.characters.main.push({ name, _addedAt: endMesId });
            existingMain.add(key);
        }
    });

    // arcUpdates
    const arcMap = new Map(
        (merged.arcs || [])
            .map(a => [normalizeCharacterNameKey(a.name), a])
            .filter(([key]) => key)
    );
    (incoming.arcUpdates || []).forEach(update => {
        const name = String(update?.name || '').trim();
        if (!name) return;
        const key = normalizeCharacterNameKey(name);
        const existing = arcMap.get(key);
        const progress = normalizeArcProgress(update.progress);
        if (existing) {
            existing.trajectory = update.trajectory;
            existing.progress = progress;
            if (update.newMoment) {
                existing.moments = existing.moments || [];
                existing.moments.push({ text: update.newMoment, _addedAt: endMesId });
            }
        } else {
            arcMap.set(key, {
                name,
                trajectory: update.trajectory,
                progress,
                moments: update.newMoment ? [{ text: update.newMoment, _addedAt: endMesId }] : [],
                _addedAt: endMesId,
            });
        }
    });
    merged.arcs = Array.from(arcMap.values());

    // L3 factUpdates 合并
    merged.facts = mergeFacts(merged.facts, incoming.factUpdates || [], endMesId);

    const aliasResult = applyCharacterAliasUpdates(merged, incoming.characterAliasUpdates || [], endMesId);
    const undo = buildSummaryUndo(beforeJson, aliasResult.json, {
        aliasChanged: aliasResult.aliasChanged,
    });

    if (options?.returnMeta) {
        return {
            json: aliasResult.json,
            aliasChanged: aliasResult.aliasChanged,
            undo,
        };
    }

    return aliasResult.json;
}
