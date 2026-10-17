// Private main-thread recall backend; cache entries and leases stay backend-owned.

import {
    metaTable,
    chunksTable,
    chunkVectorsTable,
    eventVectorsTable,
    stateVectorsTable,
} from '../../summary/data/db.js';
import {
    scoreAnchorsFromStateVectors,
    scoreEventsFromEventVectors,
    scoreL1FromRecords,
    toArrayBuffer,
    toFloat32,
} from './scoring.js';
import { diffuseFromSeeds } from '../retrieval/diffusion.js';
import { selectL1Evidence } from '../retrieval/l1-evidence-selection.js';
import {
    createSessionLeaseRegistry,
    DEFAULT_SESSION_LEASE_TTL_MS,
} from './session-lease-registry.js';

function createEntry(chatId) {
    return {
        chatId,
        meta: null,
        chunksByFloor: new Map(),
        chunkVectorsById: new Map(),
        eventVectorsById: new Map(),
        stateVectorsById: new Map(),
        ready: false,
        warming: null,
        status: 'cold',
        lastError: null,
        version: 0,
        refreshedAt: 0,
        timings: {},
    };
}

// Keep the entry point's diagnostics (including its backendKind closure) intact.
export function createMainBackend({
    createEmptyStats,
    normalizeChatId,
    compactStats,
    compactMutation,
    logRuntimeInfo,
    logRuntimeWarn,
}) {
    const entries = new Map();
    let terminated = false;
    const sessionLeases = createSessionLeaseRegistry({
        ttlMs: DEFAULT_SESSION_LEASE_TTL_MS,
        onExpire({ chatId, leaseId, activeSessions }) {
            if (!activeSessions) entries.delete(chatId);
            logRuntimeWarn('main backend session expired', `chat=${chatId} lease=${leaseId} active=${activeSessions}`);
        },
    });

    function createIdleStats(chatId, overrides = {}) {
        return createEmptyStats({
            backend: 'main-fallback',
            owner: 'runtime-main',
            chatId: String(chatId || ''),
            status: 'session-cache idle',
            ...overrides,
        });
    }

    function getEntry(chatId) {
        const key = String(chatId || '');
        if (!key) return null;
        let entry = entries.get(key);
        if (!entry) {
            entry = createEntry(key);
            entries.set(key, entry);
            logRuntimeInfo('main backend entry created', `chat=${key}`);
        }
        return entry;
    }

    function upsertChunks(entry, chunks = []) {
        for (const chunk of chunks || []) {
            const floor = Number(chunk?.floor);
            if (!Number.isInteger(floor) || !chunk?.chunkId) continue;
            const record = { ...chunk, chatId: entry.chatId, floor };
            const list = entry.chunksByFloor.get(floor) || [];
            const next = list.filter((item) => item.chunkId !== record.chunkId);
            next.push(record);
            next.sort((a, b) => (a.chunkIdx || 0) - (b.chunkIdx || 0));
            entry.chunksByFloor.set(floor, next);
        }
    }

    function upsertChunkVectors(entry, items = []) {
        for (const item of items || []) {
            const vector = toFloat32(item?.vector);
            if (!item?.chunkId || !vector?.length) continue;
            entry.chunkVectorsById.set(item.chunkId, {
                chunkId: item.chunkId,
                vector,
                fingerprint: item.fingerprint,
            });
        }
    }

    function upsertEventVectors(entry, items = []) {
        for (const item of items || []) {
            const vector = toFloat32(item?.vector);
            if (!item?.eventId || !vector?.length) continue;
            entry.eventVectorsById.set(item.eventId, {
                eventId: item.eventId,
                vector,
                fingerprint: item.fingerprint,
            });
        }
    }

    function upsertStateVectors(entry, items = []) {
        for (const item of items || []) {
            const vector = toFloat32(item?.vector);
            if (!item?.atomId || !vector?.length) continue;
            entry.stateVectorsById.set(item.atomId, {
                atomId: item.atomId,
                floor: item.floor,
                vector,
                rVector: item.rVector ? toFloat32(item.rVector) : null,
                fingerprint: item.fingerprint,
            });
        }
    }

    function exportEventVectorsByIds(entry, eventIds = []) {
        const out = [];
        for (const eventId of eventIds || []) {
            const item = entry?.eventVectorsById.get(eventId);
            if (!item) continue;
            out.push({
                ...item,
                vector: toArrayBuffer(item.vector),
            });
        }
        return out;
    }

    function clearDomain(entry, domain = 'all') {
        if (domain === 'all' || domain === 'chunks') {
            entry.chunksByFloor.clear();
            entry.chunkVectorsById.clear();
        }
        if (domain === 'all' || domain === 'events') entry.eventVectorsById.clear();
        if (domain === 'all' || domain === 'state') entry.stateVectorsById.clear();
        if (domain === 'all') {
            entry.meta = null;
            entry.ready = false;
            entry.status = 'cold';
        }
    }

    function deleteChunksFromFloor(entry, floor) {
        for (const [candidateFloor, chunks] of [...entry.chunksByFloor.entries()]) {
            if (candidateFloor < floor) continue;
            chunks.forEach((chunk) => entry.chunkVectorsById.delete(chunk.chunkId));
            entry.chunksByFloor.delete(candidateFloor);
        }
    }

    function deleteChunksAtFloor(entry, floor) {
        const chunks = entry.chunksByFloor.get(floor) || [];
        chunks.forEach((chunk) => entry.chunkVectorsById.delete(chunk.chunkId));
        entry.chunksByFloor.delete(floor);
    }

    function deleteStateVectorsFromFloor(entry, floor) {
        for (const [atomId, record] of [...entry.stateVectorsById.entries()]) {
            if (Number(record.floor) >= floor) entry.stateVectorsById.delete(atomId);
        }
    }

    function stats(entry) {
        if (!entry) return null;
        let chunks = 0;
        for (const list of entry.chunksByFloor.values()) chunks += list.length;
        return createEmptyStats({
            backend: 'main-fallback',
            owner: 'runtime-main',
            chatId: entry.chatId,
            ready: entry.ready,
            warming: !!entry.warming,
            status: entry.status,
            lastError: entry.lastError,
            chunks,
            chunkFloors: entry.chunksByFloor.size,
            chunkVectors: entry.chunkVectorsById.size,
            eventVectors: entry.eventVectorsById.size,
            stateVectors: entry.stateVectorsById.size,
            refreshedAt: entry.refreshedAt,
            version: entry.version,
            activeSessions: sessionLeases.count(entry.chatId),
            timings: entry.timings || {},
        });
    }

    async function refresh(chatId, reason = 'manual') {
        const entry = getEntry(chatId);
        if (!entry) return null;
        if (entry.warming) {
            logRuntimeInfo('main backend refresh join in-flight', `chat=${entry.chatId} reason=${reason} before=${compactStats(stats(entry))}`);
            return entry.warming;
        }

        const startedVersion = entry.version;
        const before = stats(entry);
        entry.status = 'warming';
        entry.lastError = null;
        logRuntimeInfo('main backend refresh start', `chat=${entry.chatId} reason=${reason} before=${compactStats(before)}`);

        entry.warming = (async () => {
            const loadStarted = performance.now();
            const [
                meta,
                chunks,
                chunkVectors,
                eventVectors,
                stateVectors,
            ] = await Promise.all([
                metaTable.get(entry.chatId),
                chunksTable.where('chatId').equals(entry.chatId).toArray(),
                chunkVectorsTable.where('chatId').equals(entry.chatId).toArray(),
                eventVectorsTable.where('chatId').equals(entry.chatId).toArray(),
                stateVectorsTable.where('chatId').equals(entry.chatId).toArray(),
            ]);
            const loadFromDBMs = Math.round(performance.now() - loadStarted);

            if (entry.version !== startedVersion) {
                entry.status = entry.ready ? 'ready' : 'stale-refresh-skipped';
                const staleResult = { ready: false, stale: true, reason, stats: stats(entry) };
                logRuntimeWarn('main backend refresh stale', `chat=${entry.chatId} reason=${reason} startedVersion=${startedVersion} currentVersion=${entry.version} after=${compactStats(staleResult)}`);
                return staleResult;
            }

            const next = createEntry(entry.chatId);
            next.version = entry.version;
            const buildStarted = performance.now();
            next.meta = meta || null;
            upsertChunks(next, chunks);
            upsertChunkVectors(next, chunkVectors);
            upsertEventVectors(next, eventVectors);
            upsertStateVectors(next, stateVectors);
            const buildEntryMs = Math.round(performance.now() - buildStarted);
            next.ready = true;
            next.status = 'ready';
            next.refreshedAt = Date.now();
            next.timings = {
                ...(next.timings || {}),
                loadFromDBMs,
                buildEntryMs,
            };
            if (!sessionLeases.hasChat(entry.chatId)) {
                const expiredResult = { ready: false, stale: true, expired: true, reason, stats: createIdleStats(entry.chatId) };
                logRuntimeWarn('main backend refresh discarded without active session', `chat=${entry.chatId} reason=${reason}`);
                return expiredResult;
            }
            entries.set(entry.chatId, next);
            const success = { ready: true, stale: false, reason, stats: stats(next) };
            logRuntimeInfo('main backend refresh success', `chat=${entry.chatId} reason=${reason} after=${compactStats(success)}`);
            return success;
        })()
            .catch((error) => {
                entry.status = 'refresh failed';
                entry.lastError = error?.message || String(error);
                logRuntimeWarn('main backend refresh failed', `chat=${entry.chatId} reason=${reason} after=${compactStats(stats(entry))}`);
                throw error;
            })
            .finally(() => {
                const current = entries.get(entry.chatId);
                if (current === entry) entry.warming = null;
            });

        return entry.warming;
    }

    async function ensureReady(chatId) {
        const entry = getEntry(chatId);
        if (!entry) return null;
        if (entry.ready) return entry;
        logRuntimeInfo('main backend ensureReady trigger refresh', `chat=${entry.chatId} status=${entry.status} ready=${entry.ready ? 1 : 0}`);
        const result = await refresh(chatId, 'ensure-ready');
        if (result?.expired) return null;
        if (!result?.ready) {
            logRuntimeWarn('main backend ensureReady retry', `chat=${entry.chatId} first=${compactStats(result)}`);
            await refresh(chatId, 'ensure-ready-retry');
        }
        return getEntry(chatId);
    }

    async function beginSession(chatId, reason = 'recall') {
        const key = normalizeChatId(chatId);
        if (!key) return null;
        const startedAt = performance.now();
        const leaseId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const lease = sessionLeases.add(key, leaseId);
        try {
            const entry = await ensureReady(key);
            if (!sessionLeases.hasLease(key, leaseId)) {
                throw new Error(`RecallRuntime session expired while loading: ${key}`);
            }
            if (entry) {
                entry.timings = {
                    ...(entry.timings || {}),
                    beginSessionTotalMs: Math.round(performance.now() - startedAt),
                };
            }
            logRuntimeInfo('main backend begin session', `chat=${key} lease=${leaseId} reason=${reason} active=${sessionLeases.count(key)}`);
            return { ...lease, ready: !!entry?.ready, stats: stats(entry) };
        } catch (error) {
            const released = sessionLeases.release(key, leaseId);
            if (!released.activeSessions) entries.delete(key);
            throw error;
        }
    }

    function endSession(lease = {}) {
        const key = normalizeChatId(lease.chatId);
        const leaseId = lease.leaseId;
        if (!key || !leaseId) return createIdleStats(key, { endSessionClearMs: 0 });
        const startedAt = performance.now();
        const released = sessionLeases.release(key, leaseId);
        if (!released.released) {
            logRuntimeWarn('main backend end session ignored', `chat=${key} lease=${leaseId}`);
            return entries.has(key) ? stats(entries.get(key)) : createIdleStats(key, { endSessionClearMs: 0 });
        }
        if (!released.activeSessions) {
            entries.delete(key);
            const endSessionClearMs = Math.round(performance.now() - startedAt);
            logRuntimeInfo('main backend end session cleared', `chat=${key} lease=${leaseId} clear=${endSessionClearMs}ms`);
            return createIdleStats(key, { endSessionClearMs });
        }
        const entry = entries.get(key);
        if (entry) {
            entry.timings = {
                ...(entry.timings || {}),
                endSessionClearMs: Math.round(performance.now() - startedAt),
            };
        }
        logRuntimeInfo('main backend end session retained', `chat=${key} lease=${leaseId} active=${released.activeSessions}`);
        return entry ? stats(entry) : createIdleStats(key);
    }

    function applyMutation(chatId, mutation = {}) {
        const entry = entries.get(String(chatId || ''));
        if (!entry) return createIdleStats(chatId);
        const before = stats(entry);
        entry.version++;

        switch (mutation.type) {
            case 'meta':
                entry.meta = { ...(entry.meta || { chatId: entry.chatId }), ...(mutation.meta || {}) };
                break;
            case 'upsertChunks':
                upsertChunks(entry, mutation.chunks || []);
                break;
            case 'upsertChunkVectors':
                upsertChunkVectors(entry, mutation.items || []);
                break;
            case 'upsertEventVectors':
                upsertEventVectors(entry, mutation.items || []);
                break;
            case 'upsertStateVectors':
                upsertStateVectors(entry, mutation.items || []);
                break;
            case 'deleteChunksFromFloor':
                deleteChunksFromFloor(entry, Number(mutation.floor || 0));
                break;
            case 'deleteChunksAtFloor':
                deleteChunksAtFloor(entry, Number(mutation.floor || 0));
                break;
            case 'deleteStateVectorsFromFloor':
                deleteStateVectorsFromFloor(entry, Number(mutation.floor || 0));
                break;
            case 'deleteEventVectorsByIds':
                for (const eventId of mutation.eventIds || []) entry.eventVectorsById.delete(eventId);
                break;
            case 'clear':
                clearDomain(entry, mutation.domain || 'all');
                break;
        default:
            break;
        }
        if (entry.ready && entry.status !== 'warming') entry.status = 'ready';
        const after = stats(entry);
        logRuntimeInfo('main backend mutation applied', `chat=${entry.chatId} ${compactMutation(mutation)} before=${compactStats(before)} after=${compactStats(after)}`);
        return after;
    }

    return {
        kind: 'main-fallback',
        async call(type, payload = {}, options = {}) {
            if (terminated) throw new Error('RecallRuntime main backend terminated');
            switch (type) {
                case 'ping':
                    return { pong: true, backend: 'main-fallback' };
                case 'beginSession':
                    return await beginSession(payload.chatId, payload.reason);
                case 'endSession':
                    return endSession(payload.lease);
                case 'refresh':
                    return await refresh(payload.chatId, payload.reason);
                case 'applyMutation':
                    return applyMutation(payload.chatId, payload.mutation);
                case 'retainOnly': {
                    const keep = payload.chatId ? String(payload.chatId) : null;
                    for (const key of [...entries.keys()]) {
                        if (keep && key === keep) continue;
                        if (sessionLeases.hasChat(key)) continue;
                        entries.delete(key);
                    }
                    return [...entries.values()].map(stats);
                }
                case 'clear': {
                    if (payload.chatId) {
                        const key = String(payload.chatId || '');
                        if (!sessionLeases.hasChat(key)) clearDomain(getEntry(payload.chatId), payload.domain || 'all');
                    } else {
                        for (const key of [...entries.keys()]) {
                            if (sessionLeases.hasChat(key)) continue;
                            entries.delete(key);
                        }
                    }
                    return [...entries.values()].map(stats);
                }
                case 'getMeta': {
                    const entry = await ensureReady(payload.chatId);
                    return entry?.meta || null;
                }
                case 'getEventVectorsByIds': {
                    const entry = await ensureReady(payload.chatId);
                    const startedAt = performance.now();
                    const records = exportEventVectorsByIds(entry, payload.eventIds || []);
                    const getEventVectorsByIdsMs = Math.round(performance.now() - startedAt);
                    if (entry) entry.timings = { ...(entry.timings || {}), getEventVectorsByIdsMs };
                    return { records, stats: stats(entry) };
                }
                case 'scoreAnchors': {
                    const entry = await ensureReady(payload.chatId);
                    const startedAt = performance.now();
                    const scores = scoreAnchorsFromStateVectors([...(entry?.stateVectorsById.values() || [])], payload.queryVector);
                    if (entry) entry.timings = { ...(entry.timings || {}), scoreAnchorsMs: Math.round(performance.now() - startedAt) };
                    return {
                        scores,
                        stats: stats(entry),
                    };
                }
                case 'scoreEvents': {
                    const entry = await ensureReady(payload.chatId);
                    const startedAt = performance.now();
                    const scores = scoreEventsFromEventVectors([...(entry?.eventVectorsById.values() || [])], payload.queryVector);
                    if (entry) entry.timings = { ...(entry.timings || {}), scoreEventsMs: Math.round(performance.now() - startedAt) };
                    return {
                        scores,
                        stats: stats(entry),
                    };
                }
                case 'selectL1Evidence': {
                    const entry = await ensureReady(payload.chatId);
                    const selection = await selectL1Evidence(payload.parents, entry, {
                        ...payload.options, signal: options.signal,
                        isCurrent: () => entries.get(payload.chatId) === entry,
                    });
                    return { selection, stats: stats(entry) };
                }
                case 'scoreL1': {
                    const entry = await ensureReady(payload.chatId);
                    const startedAt = performance.now();
                    const floors = (payload.floors || []).map(Number).filter(Number.isInteger);
                    const chunks = [];
                    const vectors = [];
                    for (const floor of floors) chunks.push(...(entry?.chunksByFloor.get(floor) || []));
                    for (const chunk of chunks) {
                        const vector = entry?.chunkVectorsById.get(chunk.chunkId);
                        if (vector) vectors.push(vector);
                    }
                    const scored = scoreL1FromRecords(chunks, vectors, payload.queryVector);
                    scored.stats.requestedFloors = floors.length;
                    scored.stats.chunkCacheHits = floors.length;
                    scored.stats.vectorCacheHits = scored.stats.vectorHits;
                    scored.stats.vectorCacheMisses = scored.stats.missingVectors;
                    scored.stats.backend = 'main-fallback';
                    scored.stats.cacheOwner = 'runtime-main';
                    scored.stats.requestedL1Floors = floors.length;
                    const scoreL1Ms = Math.round(performance.now() - startedAt);
                    scored.stats.runtimeScoreL1Ms = scoreL1Ms;
                    if (entry) entry.timings = { ...(entry.timings || {}), scoreL1Ms };
                    return scored;
                }
                case 'diffuseL0': {
                    const entry = await ensureReady(payload.chatId);
                    const startedAt = performance.now();
                    const metrics = { diffusion: {} };
                    const diffused = diffuseFromSeeds(
                        payload.seeds || [],
                        payload.allAtoms || [],
                        [...(entry?.stateVectorsById.values() || [])],
                        payload.queryVector,
                        metrics,
                        { name1: payload.name1 || '' }
                    );
                    if (entry) entry.timings = { ...(entry.timings || {}), diffuseL0Ms: Math.round(performance.now() - startedAt) };
                    return { diffused, metrics: metrics.diffusion || {} };
                }
                case 'stats':
                    return [...entries.values()].map(stats);
                default:
                    throw new Error(`Unknown RecallRuntime request: ${type}`);
            }
        },
        terminate() {
            if (terminated) return;
            terminated = true;
            sessionLeases.clear();
            entries.clear();
        },
    };
}
