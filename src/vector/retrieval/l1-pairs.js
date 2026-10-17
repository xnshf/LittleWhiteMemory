import { getContext } from '../../../../../../extensions.js';
import { scoreRecallRuntimeL1 } from '../runtime/runtime.js';
import { xbLog } from '../../support/debug-core.js';

const MODULE_ID = 'recall';

// ═══════════════════════════════════════════════════════════════════════════
// [L1] 拉取 + Cosine 打分
// ═══════════════════════════════════════════════════════════════════════════

export async function pullAndScoreL1(chatId, floors, queryVector, signal = null) {
    const T0 = performance.now();
    if (!chatId || !floors?.length || !queryVector?.length) {
        const result = new Map();
        result._cosineTime = 0;
        result._stats = {
            requestedFloors: floors?.length || 0,
            chunkCount: 0,
            vectorHits: 0,
            missingVectors: 0,
            totalTime: 0,
            cacheFallbackDbTime: 0,
            cacheWarm: false,
        };
        return result;
    }

    const result = await scoreRecallRuntimeL1(chatId, floors, queryVector, { signal });
    result._cosineTime = Math.round(performance.now() - T0);
    result._stats ||= {};
    result._stats.totalTime = result._cosineTime;
    result._stats.cacheWarm = result._stats.cacheFallbackDbTime === 0;
    result._runtimeScoreL1Ms = result._stats.runtimeScoreL1Ms ?? result._stats.scoreTime ?? result._cosineTime;

    xbLog.info(MODULE_ID,
        `L1 runtime: ${floors.length} floors → ${result._stats.chunkCount || 0} chunks → vectors=${result._stats.vectorHits || 0}/${result._stats.chunkCount || 0} `
        + `(backend=${result._stats.backend || 'unknown'} owner=${result._stats.cacheOwner || 'unknown'} `
        + `fallback_db=${result._stats.cacheFallbackDbTime || 0}ms, `
        + `deserialize=${result._stats.deserializeTime}ms, score=${result._stats.scoreTime}ms, sort=${result._stats.sortTime}ms, total=${result._cosineTime}ms)`
    );

    return result;
}

export async function buildL1PairsForSelectedFloors(l0Selected, queryVector, prefetchedL1ByFloor, metrics, signal = null) {
    const T0 = performance.now();
    const { chatId, chat } = getContext();

    const l1ByFloor = new Map();
    if (!chatId || !queryVector?.length || !l0Selected?.length) {
        if (metrics) {
            metrics.evidence.l1Pulled = 0;
            metrics.evidence.l1Attached = 0;
            metrics.evidence.l1CosineTime = 0;
            metrics.evidence.contextPairsAdded = 0;
        }
        return l1ByFloor;
    }

    const requiredFloors = new Set();
    const selectedFloors = new Set();
    for (const l0 of l0Selected) {
        const floor = Number(l0?.floor);
        if (!Number.isInteger(floor) || floor < 0) continue;
        selectedFloors.add(floor);
        requiredFloors.add(floor);
        const userFloor = floor - 1;
        if (userFloor >= 0 && chat?.[userFloor]?.is_user) {
            requiredFloors.add(userFloor);
        }
    }

    const merged = new Map();
    const prefetched = prefetchedL1ByFloor || new Map();
    let totalCosineTime = Number(prefetched._cosineTime || 0);
    const aggregateStats = {
        chunkFetchTime: Number(prefetched._stats?.chunkFetchTime || 0),
        vectorFetchTime: Number(prefetched._stats?.vectorFetchTime || 0),
        deserializeTime: Number(prefetched._stats?.deserializeTime || 0),
        scoreTime: Number(prefetched._stats?.scoreTime || 0),
        sortTime: Number(prefetched._stats?.sortTime || 0),
        vectorHits: Number(prefetched._stats?.vectorHits || 0),
        missingVectors: Number(prefetched._stats?.missingVectors || 0),
        chunkCacheHits: Number(prefetched._stats?.chunkCacheHits || 0),
        chunkCacheMisses: Number(prefetched._stats?.chunkCacheMisses || 0),
        vectorCacheHits: Number(prefetched._stats?.vectorCacheHits || 0),
        vectorCacheMisses: Number(prefetched._stats?.vectorCacheMisses || 0),
        cacheFallbackDbTime: Number(prefetched._stats?.cacheFallbackDbTime || 0),
        runtimeScoreL1Ms: Number(prefetched._runtimeScoreL1Ms || prefetched._stats?.runtimeScoreL1Ms || 0),
    };

    for (const [floor, chunks] of prefetched) {
        if (!requiredFloors.has(floor)) continue;
        merged.set(floor, chunks);
    }

    const missingFloors = [...requiredFloors].filter(f => !merged.has(f));
    if (missingFloors.length > 0) {
        const extra = await pullAndScoreL1(chatId, missingFloors, queryVector, signal);
        totalCosineTime += Number(extra._cosineTime || 0);
        aggregateStats.chunkFetchTime += Number(extra._stats?.chunkFetchTime || 0);
        aggregateStats.vectorFetchTime += Number(extra._stats?.vectorFetchTime || 0);
        aggregateStats.deserializeTime += Number(extra._stats?.deserializeTime || 0);
        aggregateStats.scoreTime += Number(extra._stats?.scoreTime || 0);
        aggregateStats.sortTime += Number(extra._stats?.sortTime || 0);
        aggregateStats.vectorHits += Number(extra._stats?.vectorHits || 0);
        aggregateStats.missingVectors += Number(extra._stats?.missingVectors || 0);
        aggregateStats.chunkCacheHits += Number(extra._stats?.chunkCacheHits || 0);
        aggregateStats.chunkCacheMisses += Number(extra._stats?.chunkCacheMisses || 0);
        aggregateStats.vectorCacheHits += Number(extra._stats?.vectorCacheHits || 0);
        aggregateStats.vectorCacheMisses += Number(extra._stats?.vectorCacheMisses || 0);
        aggregateStats.cacheFallbackDbTime += Number(extra._stats?.cacheFallbackDbTime || 0);
        aggregateStats.runtimeScoreL1Ms += Number(extra._runtimeScoreL1Ms || extra._stats?.runtimeScoreL1Ms || 0);
        for (const [floor, chunks] of extra) {
            if (floor === '_cosineTime') continue;
            if (!requiredFloors.has(floor)) continue;
            merged.set(floor, chunks);
        }
    }

    let contextPairsAdded = 0;
    let totalAttached = 0;
    for (const floor of selectedFloors) {
        const aiChunks = merged.get(floor) || [];
        const userFloor = floor - 1;
        const userChunks = (userFloor >= 0 && chat?.[userFloor]?.is_user)
            ? (merged.get(userFloor) || [])
            : [];

        const aiTop1 = aiChunks.length > 0
            ? aiChunks.reduce((best, c) => (c._cosineScore > best._cosineScore ? c : best))
            : null;
        const userTop1 = userChunks.length > 0
            ? userChunks.reduce((best, c) => (c._cosineScore > best._cosineScore ? c : best))
            : null;

        if (aiTop1) totalAttached++;
        if (userTop1) {
            totalAttached++;
            contextPairsAdded++;
        }
        l1ByFloor.set(floor, { aiTop1, userTop1 });
    }

    if (metrics) {
        let totalPulled = 0;
        for (const [, chunks] of merged) {
            totalPulled += chunks.length;
        }
        metrics.evidence.l1Pulled = totalPulled;
        metrics.evidence.l1Attached = totalAttached;
        metrics.evidence.l1CosineTime = totalCosineTime;
        metrics.evidence.l1ChunkFetchTime = aggregateStats.chunkFetchTime;
        metrics.evidence.l1VectorFetchTime = aggregateStats.vectorFetchTime;
        metrics.evidence.l1DeserializeTime = aggregateStats.deserializeTime;
        metrics.evidence.l1ScoreTime = aggregateStats.scoreTime;
        metrics.evidence.l1SortTime = aggregateStats.sortTime;
        metrics.evidence.l1VectorHits = aggregateStats.vectorHits;
        metrics.evidence.l1MissingVectors = aggregateStats.missingVectors;
        metrics.evidence.l1ChunkCacheHits = aggregateStats.chunkCacheHits;
        metrics.evidence.l1ChunkCacheMisses = aggregateStats.chunkCacheMisses;
        metrics.evidence.l1VectorCacheHits = aggregateStats.vectorCacheHits;
        metrics.evidence.l1VectorCacheMisses = aggregateStats.vectorCacheMisses;
        metrics.evidence.l1CacheFallbackDbTime = aggregateStats.cacheFallbackDbTime;
        metrics.evidence.l1CacheWarm = aggregateStats.chunkCacheMisses === 0 && aggregateStats.vectorCacheMisses === 0;
        metrics.timing.runtimeScoreL1 = aggregateStats.runtimeScoreL1Ms;
        metrics.evidence.contextPairsAdded = contextPairsAdded;
        metrics.timing.evidenceRetrieval += Math.round(performance.now() - T0);
    }

    return l1ByFloor;
}
