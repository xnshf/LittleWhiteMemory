import { tokenizeForIndex } from '../utils/tokenizer.js';

export function normalize(s) {
    return String(s || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim()
        .toLowerCase();
}

export function fuseByFloor(denseRank, lexRank, cap, { RRF_K, RRF_W_DENSE, RRF_W_LEX }) {
    const buildRankMap = ranked => {
        const map = new Map();
        for (let i = 0; i < ranked.length; i++) {
            const id = ranked[i].id;
            if (!map.has(id)) map.set(id, i);
        }
        return map;
    };
    const denseMap = buildRankMap(denseRank || []);
    const lexMap = buildRankMap(lexRank || []);
    const allIds = new Set([...denseMap.keys(), ...lexMap.keys()]);
    const scored = [];
    for (const id of allIds) {
        let score = 0;
        if (denseMap.has(id)) score += RRF_W_DENSE / (RRF_K + denseMap.get(id));
        if (lexMap.has(id)) score += RRF_W_LEX / (RRF_K + lexMap.get(id));
        scored.push({ id, fusionScore: score });
    }
    scored.sort((a, b) => b.fusionScore - a.fusionScore);
    return { top: scored.slice(0, cap), all: scored, totalUnique: allIds.size };
}

export function mapChunkFloorToAiFloor(floor, chat) {
    let mapped = Number(floor);
    if (!Number.isInteger(mapped) || mapped < 0 || !chat?.[mapped]) return null;
    if (chat[mapped].is_user) {
        const aiFloor = mapped + 1;
        if (aiFloor < (chat?.length || 0) && !chat?.[aiFloor]?.is_user) {
            mapped = aiFloor;
        } else {
            return null;
        }
    }
    return mapped;
}

function isNonStopwordTerm(term) {
    const norm = normalize(term);
    if (!norm) return false;
    const tokens = tokenizeForIndex(norm).map(normalize);
    return tokens.includes(norm);
}

export function buildMustKeepFloors(lexicalResult, lexicalTerms, atomFloorSet, chat, config) {
    const out = {
        terms: [],
        floors: [],
        floorSet: new Set(),
        lexHitButNotSelected: 0,
    };
    if (!lexicalResult || !lexicalTerms?.length || !atomFloorSet?.size) return out;
    const queryTermSet = new Set((lexicalTerms || []).map(normalize).filter(Boolean));
    const topIdfTerms = (lexicalResult.topIdfTerms || [])
        .filter(x => {
            const term = normalize(x?.term);
            if (!term) return false;
            if (!queryTermSet.has(term)) return false;
            if (term.length < 2) return false;
            if (!isNonStopwordTerm(term)) return false;
            if ((x?.idf || 0) < config.MUST_KEEP_MIN_IDF) return false;
            const hits = lexicalResult.termFloorHits?.[term];
            return Array.isArray(hits) && hits.length > 0;
        })
        .sort((a, b) => (b.idf || 0) - (a.idf || 0));
    if (!topIdfTerms.length) return out;
    out.terms = topIdfTerms.map(x => ({ term: normalize(x.term), idf: x.idf || 0 }));

    const floorAgg = new Map();
    for (const { term } of out.terms) {
        const hits = lexicalResult.termFloorHits?.[term] || [];
        for (const hit of hits) {
            const aiFloor = mapChunkFloorToAiFloor(hit.floor, chat);
            if (aiFloor == null) continue;
            if (!atomFloorSet.has(aiFloor)) continue;
            const cur = floorAgg.get(aiFloor) || { lexHitScore: 0, terms: new Set() };
            cur.lexHitScore += Number(hit?.weightedScore || 0);
            cur.terms.add(term);
            floorAgg.set(aiFloor, cur);
        }
    }
    const candidates = [...floorAgg.entries()]
        .map(([floor, info]) => {
            const termCoverage = info.terms.size;
            const finalFloorScore = info.lexHitScore * (1 + 0.2 * Math.max(0, termCoverage - 1));
            return { floor, score: finalFloorScore, termCoverage, terms: [...info.terms] };
        })
        .sort((a, b) => b.score - a.score);
    out.lexHitButNotSelected = candidates.length;

    const selected = [];
    for (const c of candidates) {
        const conflict = selected.some(s => Math.abs(s.floor - c.floor) <= config.MUST_KEEP_CLUSTER_WINDOW);
        if (conflict) continue;
        selected.push(c);
        if (selected.length >= config.MUST_KEEP_MAX_FLOORS) break;
    }
    out.floors = selected;
    out.floorSet = new Set(selected.map(x => x.floor));
    return out;
}
