// Story Summary - single recall runtime data plane
//
// Browser path: a module Worker owns hot L0/L1/L2 vector data and scoring.
// Emergency path: a private main-thread backend with the same API. This is
// private to the runtime so business modules do not depend on cache maps.

import { createMainBackend } from './main-backend.js';
import { xbLog } from '../../support/debug-core.js';
import { createWorkerRpc } from './rpc.js';
import { toFloat32 } from './scoring.js';
import { throwIfSignalAborted } from '../../support/abort-utils.js';
import { createSessionLeaseRegistry } from './session-lease-registry.js';

const MODULE_ID = 'recall-runtime';
const WORKER_TIMEOUT_MS = 30000;
const SESSION_TIMEOUT_MS = 120000;
const SHORT_TIMEOUT_MS = 10000;
const RUNTIME_CACHE_MODE = 'recall-session';

function safeRuntimeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        try {
            return String(value);
        } catch {
            return '[unstringifiable]';
        }
    }
}

function compactStats(stats) {
    if (!stats) return 'none';
    const item = stats.stats || stats;
    if (!item || typeof item !== 'object') return safeRuntimeStringify(item);
    const fields = [
        `chat=${item.chatId || '-'}`,
        `backend=${item.backend || backendKind || '-'}`,
        `owner=${item.owner || '-'}`,
        `status=${item.status || '-'}`,
        `ready=${item.ready ? 1 : 0}`,
        `warming=${item.warming ? 1 : 0}`,
        `meta=${item.meta ? 1 : 0}`,
        `floors=${item.chunkFloors ?? '-'}`,
        `chunks=${item.chunks ?? '-'}`,
        `l1v=${item.chunkVectors ?? '-'}`,
        `l2v=${item.eventVectors ?? '-'}`,
        `l0v=${item.stateVectors ?? '-'}`,
        `ver=${item.version ?? '-'}`,
        `err=${item.lastError || '-'}`,
    ];
    return fields.join(' ');
}

function compactStatsList(statsList) {
    if (!Array.isArray(statsList) || !statsList.length) return '[]';
    return statsList.map((item) => `[${compactStats(item)}]`).join(' ');
}

function compactMutation(mutation = {}) {
    if (!mutation || typeof mutation !== 'object') return 'unknown';
    const details = [`type=${mutation.type || 'unknown'}`];
    if (Number.isFinite(Number(mutation.floor))) details.push(`floor=${Number(mutation.floor)}`);
    if (Array.isArray(mutation.items)) details.push(`items=${mutation.items.length}`);
    if (Array.isArray(mutation.chunks)) details.push(`chunks=${mutation.chunks.length}`);
    if (Array.isArray(mutation.eventIds)) details.push(`eventIds=${mutation.eventIds.length}`);
    if (mutation.domain) details.push(`domain=${mutation.domain}`);
    if (mutation.meta && typeof mutation.meta === 'object') details.push(`metaKeys=${Object.keys(mutation.meta).length}`);
    return details.join(' ');
}

function logRuntimeInfo(message, extra = null) {
    if (extra === null || extra === undefined || extra === '') {
        xbLog.info(MODULE_ID, message);
    } else {
        xbLog.info(MODULE_ID, `${message} ${typeof extra === 'string' ? extra : safeRuntimeStringify(extra)}`);
    }
}

function logRuntimeWarn(message, extra = null) {
    if (extra === null || extra === undefined || extra === '') {
        xbLog.warn(MODULE_ID, message);
    } else {
        xbLog.warn(MODULE_ID, `${message} ${typeof extra === 'string' ? extra : safeRuntimeStringify(extra)}`);
    }
}

function createEmptyStats(overrides = {}) {
    return {
        backend: 'uninitialized',
        owner: 'none',
        ready: false,
        warming: false,
        status: 'cold',
        lastError: null,
        chunks: 0,
        chunkFloors: 0,
        chunkVectors: 0,
        eventVectors: 0,
        stateVectors: 0,
        activeSessions: 0,
        dirtyReason: null,
        timings: {},
        ...overrides,
    };
}

let backend = null;
let backendKind = 'uninitialized';
let backendInitPromise = null;
let lastStats = [];
let lastError = null;
const dirtyRefreshTimers = new Map();
const dirtyChats = new Map();
const localSessionLeases = createSessionLeaseRegistry();

function hasBackendStarted() {
    return !!backend || !!backendInitPromise;
}

function canUseWorker() {
    return typeof Worker !== 'undefined' && typeof URL !== 'undefined';
}

function normalizeChatId(chatId) {
    const key = String(chatId || '');
    return key || null;
}

function rememberLocalSession(lease) {
    if (!lease?.chatId || !lease?.leaseId) return;
    localSessionLeases.add(lease.chatId, lease.leaseId, lease);
}

function forgetLocalSession(lease) {
    if (!lease?.chatId || !lease?.leaseId) return;
    localSessionLeases.release(lease.chatId, lease.leaseId);
}

function hasLocalSession(chatId) {
    return localSessionLeases.hasChat(chatId);
}

function createSessionIdleStats(chatId, overrides = {}) {
    const key = normalizeChatId(chatId);
    const dirty = key ? dirtyChats.get(key) : null;
    return createEmptyStats({
        backend: backendKind,
        owner: backendKind === 'worker' ? 'worker' : (backendKind === 'main-fallback' ? 'runtime-main' : 'none'),
        chatId: key,
        status: 'session-cache idle',
        cacheMode: RUNTIME_CACHE_MODE,
        dirtyReason: dirty?.reason || null,
        dirtyAt: dirty?.updatedAt || null,
        ...overrides,
    });
}

async function createWorkerBackend() {
    logRuntimeInfo('init worker backend start');
    const worker = new Worker(new URL('./runtime.worker.js', import.meta.url), {
        type: 'module',
        name: 'littlewhitememory-recall-runtime',
    });
    const rpc = createWorkerRpc(worker, {
        onLog(payload) {
            const level = payload?.level === 'warn' ? 'warn' : (payload?.level === 'error' ? 'error' : 'info');
            const moduleId = payload?.moduleId || MODULE_ID;
            const message = payload?.message || '';
            if (level === 'warn') xbLog.warn(moduleId, message);
            else if (level === 'error') xbLog.error(moduleId, message, null);
            else xbLog.info(moduleId, message);
        },
    });
    try {
        await rpc.call('ping', {}, { timeoutMs: 5000 });
    } catch (error) {
        rpc.rejectAll(error);
        worker.terminate();
        throw error;
    }
    logRuntimeInfo('init worker backend ready');
    let terminated = false;

    return {
        kind: 'worker',
        async call(type, payload, options = {}) {
            if (terminated) throw new Error('RecallRuntime worker terminated');
            return await rpc.call(type, payload, {
                timeoutMs: options.timeoutMs || WORKER_TIMEOUT_MS,
                signal: options.signal || null,
            });
        },
        terminate() {
            if (terminated) return;
            terminated = true;
            rpc.rejectAll(new Error('RecallRuntime worker terminated'));
            worker.terminate();
        },
    };
}

async function getBackend() {
    if (backend) return backend;
    if (backendInitPromise) return await backendInitPromise;

    backendInitPromise = (async () => {
        if (backend) return backend;

        if (canUseWorker()) {
            try {
                backend = await createWorkerBackend();
                backendKind = 'worker';
                lastError = null;
                logRuntimeInfo('backend selected', 'worker');
                return backend;
            } catch (error) {
                lastError = error?.message || String(error);
                console.warn(`[${MODULE_ID}] Worker 初始化失败，切换到 runtime 内部主线程兜底`, error);
                logRuntimeWarn('worker backend init failed', lastError);
            }
        } else {
            lastError = 'Worker unavailable in this environment';
            logRuntimeWarn('worker backend unavailable', lastError);
        }

        backend = createMainBackend({
            createEmptyStats, normalizeChatId, compactStats, compactMutation,
            logRuntimeInfo, logRuntimeWarn,
        });
        backendKind = 'main-fallback';
        logRuntimeInfo('backend selected', 'main-fallback');
        return backend;
    })();

    try {
        return await backendInitPromise;
    } finally {
        backendInitPromise = null;
    }
}

function rememberStats(stats) {
    if (Array.isArray(stats)) {
        if (stats.length && stats.every((item) => item && (item.backend || item.owner || item.status))) {
            lastStats = stats;
        }
    } else if (stats?.stats) {
        const item = stats.stats;
        lastStats = lastStats.filter((s) => s.chatId !== item.chatId).concat(item);
    } else if (stats?.chatId) {
        lastStats = lastStats.filter((s) => s.chatId !== stats.chatId).concat(stats);
    }
    return stats;
}

function retainOnlyLastStats(chatId = null) {
    const key = normalizeChatId(chatId);
    if (!key) {
        lastStats = [];
        return [];
    }
    lastStats = lastStats.filter((item) => String(item?.chatId || '') === key);
    return lastStats;
}

async function callRuntime(type, payload = {}, options = {}) {
    const current = await getBackend();
    throwIfSignalAborted(options.signal, `RecallRuntime request aborted: ${type}`);
    try {
        const result = await current.call(type, payload, options);
        throwIfSignalAborted(options.signal, `RecallRuntime request aborted: ${type}`);
        rememberStats(result);
        return result;
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        lastError = error?.message || String(error);
        rememberStats(createEmptyStats({
            backend: backendKind,
            owner: backendKind === 'worker' ? 'worker' : 'runtime-main',
            status: 'request failed',
            lastError,
        }));
        throw error;
    }
}

export async function warmRecallRuntime(chatId, options = {}) {
    if (!chatId) return null;
    logRuntimeInfo('warm request', `chat=${chatId} reason=${options.reason || 'warm'}`);
    const stats = createSessionIdleStats(chatId, {
        backend: backendKind,
        status: 'session-cache idle',
        skipped: true,
        reason: options.reason || 'warm',
    });
    rememberStats(stats);
    return { ready: false, skipped: true, stale: false, reason: options.reason || 'warm', stats };
}

export async function refreshRecallRuntime(chatId, options = {}) {
    if (!chatId) return null;
    logRuntimeInfo('refresh request', `chat=${chatId} reason=${options.reason || 'refresh'}`);
    const reason = options.reason || 'refresh';
    markRecallRuntimeDirty(chatId, reason);
    const stats = createSessionIdleStats(chatId, {
        backend: backendKind,
        status: 'session-cache idle',
        skipped: true,
        reason,
    });
    rememberStats(stats);
    return { ready: false, skipped: true, stale: false, reason, stats };
}

export async function applyRecallRuntimeMutation(chatId, mutation = {}) {
    if (!chatId) return null;
    logRuntimeInfo('mutation request', `chat=${chatId} ${compactMutation(mutation)}`);
    const reason = `mutation:${mutation?.type || 'unknown'}`;
    markRecallRuntimeDirty(chatId, reason);
    const stats = createSessionIdleStats(chatId, { skipped: true, reason });
    rememberStats(stats);
    return stats;
}

export function applyRecallRuntimeMutationBestEffort(chatId, mutation = {}) {
    if (!chatId) return;
    markRecallRuntimeDirty(chatId, `mutation:${mutation?.type || 'unknown'}`);
}

export function markRecallRuntimeDirty(chatId, reason = 'dirty') {
    const key = normalizeChatId(chatId);
    if (!key) return;
    dirtyChats.set(key, { reason, updatedAt: Date.now() });
    logRuntimeInfo('mark dirty', `chat=${key} reason=${reason}`);
    rememberStats(createSessionIdleStats(key, { dirtyReason: reason, dirtyAt: dirtyChats.get(key)?.updatedAt }));
}

export async function beginRecallRuntimeSession(chatId, options = {}) {
    const key = normalizeChatId(chatId);
    if (!key) return null;
    const reason = options.reason || 'recall';
    const requestedAt = Date.now();
    logRuntimeInfo('begin session request', `chat=${key} reason=${reason}`);
    const result = await callRuntime('beginSession', { chatId: key, reason }, {
        timeoutMs: options.timeoutMs || SESSION_TIMEOUT_MS,
    });
    if (result?.leaseId) {
        rememberLocalSession(result);
        const dirty = dirtyChats.get(key);
        if (dirty && dirty.updatedAt <= (result.startedAt || requestedAt)) {
            dirtyChats.delete(key);
        }
    }
    return result;
}

export async function endRecallRuntimeSession(lease, options = {}) {
    if (!lease?.chatId || !lease?.leaseId) return null;
    if (!localSessionLeases.hasLease(lease.chatId, lease.leaseId)) {
        return createSessionIdleStats(lease.chatId, { endSessionClearMs: 0 });
    }
    logRuntimeInfo('end session request', `chat=${lease.chatId} lease=${lease.leaseId}`);
    try {
        const result = await callRuntime('endSession', { lease }, { timeoutMs: options.timeoutMs || SHORT_TIMEOUT_MS });
        const dirty = dirtyChats.get(String(lease.chatId));
        if (dirty) {
            const merged = {
                ...(result || createSessionIdleStats(lease.chatId)),
                dirtyReason: dirty.reason,
                dirtyAt: dirty.updatedAt,
            };
            rememberStats(merged);
            return merged;
        }
        return result;
    } finally {
        forgetLocalSession(lease);
    }
}

export async function withRecallRuntimeSession(chatId, fn, options = {}) {
    const lease = await beginRecallRuntimeSession(chatId, options);
    try {
        return await fn(lease);
    } finally {
        if (lease) await endRecallRuntimeSession(lease);
    }
}

async function callRuntimePrimitive(chatId, type, payload = {}, options = {}) {
    if (!chatId || hasLocalSession(chatId)) {
        return await callRuntime(type, payload, options);
    }
    const lease = await beginRecallRuntimeSession(chatId, {
        reason: `single-call:${type}`,
    });
    try {
        throwIfSignalAborted(options.signal, `RecallRuntime request aborted: ${type}`);
        return await callRuntime(type, payload, options);
    } finally {
        if (lease) await endRecallRuntimeSession(lease);
    }
}

export async function clearRecallRuntime(chatId = null, domain = 'all') {
    logRuntimeInfo('clear request', `chat=${chatId || '*'} domain=${domain}`);
    if (chatId) {
        const timer = dirtyRefreshTimers.get(chatId);
        if (timer) clearTimeout(timer);
        dirtyRefreshTimers.delete(chatId);
        dirtyChats.delete(String(chatId));
    } else {
        for (const timer of dirtyRefreshTimers.values()) clearTimeout(timer);
        dirtyRefreshTimers.clear();
        dirtyChats.clear();
    }
    if (!hasBackendStarted()) {
        if (chatId) {
            const stats = createSessionIdleStats(chatId, { dirtyReason: null, dirtyAt: null });
            rememberStats(stats);
            logRuntimeInfo('clear skipped (backend idle)', compactStats(stats));
            return [stats];
        }
        lastStats = [];
        logRuntimeInfo('clear skipped (backend idle)', 'all');
        return [];
    }
    const result = await callRuntime('clear', { chatId, domain }, { timeoutMs: SHORT_TIMEOUT_MS });
    logRuntimeInfo('clear result', compactStatsList(Array.isArray(result) ? result : lastStats));
    return result;
}

export async function retainRecallRuntimeOnly(chatId) {
    logRuntimeInfo('retainOnly request', `keep=${chatId || '*'}`);
    if (!hasBackendStarted()) {
        const result = retainOnlyLastStats(chatId || null);
        logRuntimeInfo('retainOnly skipped (backend idle)', compactStatsList(result));
        return result;
    }
    const result = await callRuntime('retainOnly', { chatId: chatId || null }, { timeoutMs: SHORT_TIMEOUT_MS });
    logRuntimeInfo('retainOnly result', compactStatsList(Array.isArray(result) ? result : lastStats));
    return result;
}

export async function shutdownRecallRuntime() {
    logRuntimeInfo('shutdown request');
    for (const timer of dirtyRefreshTimers.values()) clearTimeout(timer);
    dirtyRefreshTimers.clear();
    dirtyChats.clear();
    localSessionLeases.clear();

    const pendingInit = backendInitPromise;
    let current = backend;
    if (!current && pendingInit) {
        try {
            current = await pendingInit;
        } catch {
            current = null;
        }
    }

    try {
        current?.terminate?.();
    } finally {
        if (backend === current) backend = null;
        if (backendInitPromise === pendingInit) backendInitPromise = null;
        backendKind = 'uninitialized';
        lastStats = [];
        lastError = null;
    }
    logRuntimeInfo('shutdown complete');
}

export async function getRecallRuntimeMeta(chatId, options = {}) {
    return await callRuntimePrimitive(chatId, 'getMeta', { chatId }, {
        timeoutMs: WORKER_TIMEOUT_MS,
        signal: options.signal || null,
    });
}

export async function getRecallRuntimeEventVectorsByIds(chatId, eventIds = [], options = {}) {
    const response = await callRuntimePrimitive(chatId, 'getEventVectorsByIds', { chatId, eventIds }, {
        timeoutMs: WORKER_TIMEOUT_MS,
        signal: options.signal || null,
    });
    const records = (response?.records || []).map((record) => ({
        ...record,
        vector: toFloat32(record.vector),
    }));
    records._stats = response?.stats || null;
    return records;
}

export async function scoreRecallRuntimeAnchors(chatId, queryVector, options = {}) {
    return await callRuntimePrimitive(chatId, 'scoreAnchors', { chatId, queryVector }, {
        timeoutMs: WORKER_TIMEOUT_MS,
        signal: options.signal || null,
    });
}

export async function scoreRecallRuntimeEvents(chatId, queryVector, options = {}) {
    return await callRuntimePrimitive(chatId, 'scoreEvents', { chatId, queryVector }, {
        timeoutMs: WORKER_TIMEOUT_MS,
        signal: options.signal || null,
    });
}

export async function selectRecallRuntimeL1Evidence(chatId, parents, options = {}) {
    const response = await callRuntimePrimitive(chatId, 'selectL1Evidence', {
        chatId,
        parents: parents.map(({ event }) => ({ event: { id: event.id, summary: event.summary } })),
        options: {
            queryVector: options.queryVector,
            lexicalScores: options.lexicalScores,
            temporalCarrier: options.temporalCarrier,
        },
    }, { timeoutMs: WORKER_TIMEOUT_MS, signal: options.signal || null });
    return response.selection;
}

export async function scoreRecallRuntimeL1(chatId, floors, queryVector, options = {}) {
    const response = await callRuntimePrimitive(chatId, 'scoreL1', { chatId, floors, queryVector }, {
        timeoutMs: WORKER_TIMEOUT_MS,
        signal: options.signal || null,
    });
    const result = new Map();
    for (const chunk of response?.result || []) {
        if (!result.has(chunk.floor)) result.set(chunk.floor, []);
        result.get(chunk.floor).push(chunk);
    }
    for (const [, chunks] of result) {
        chunks.sort((a, b) => b._cosineScore - a._cosineScore);
    }
    result._cosineTime = response?.stats?.totalTime || 0;
    result._stats = response?.stats || {};
    return result;
}

export async function diffuseRecallRuntimeL0(chatId, seeds, allAtoms, queryVector, options = {}) {
    return await callRuntimePrimitive(chatId, 'diffuseL0', {
        chatId,
        seeds,
        allAtoms,
        queryVector,
        name1: options.name1 || '',
    }, {
        timeoutMs: WORKER_TIMEOUT_MS,
        signal: options.signal || null,
    });
}

export function getRecallRuntimeStats() {
    if (!lastStats.length) {
        return [createEmptyStats({
            backend: backendKind,
            owner: backendKind === 'worker' ? 'worker' : (backendKind === 'main-fallback' ? 'runtime-main' : 'none'),
            lastError,
        })];
    }
    return lastStats.map((item) => ({
        ...item,
        backend: item.backend || backendKind,
        lastError: item.lastError || lastError,
    }));
}

export async function refreshRecallRuntimeStats() {
    if (!hasBackendStarted()) return getRecallRuntimeStats();
    const stats = await callRuntime('stats', {}, { timeoutMs: SHORT_TIMEOUT_MS });
    return Array.isArray(stats) ? stats : getRecallRuntimeStats();
}
