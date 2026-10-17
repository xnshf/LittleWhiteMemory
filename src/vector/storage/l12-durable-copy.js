// L1/L2 的自动持久快照。只恢复输入仍匹配的缺失记录，不覆盖已有缓存。
import { getContext } from '../../../../../../extensions.js';
import { chat_metadata } from '../../../../../../../script.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../../../libs/fflate.mjs';
import { db, metaTable, chunksTable, chunkVectorsTable, eventVectorsTable } from '../../summary/data/db.js';
import { EXT_ID } from '../../support/constants.js';
import { xbLog } from '../../support/debug-core.js';
import { chunkMessage } from '../pipeline/chunk-builder.js';
import { buildEventVectorText } from '../pipeline/event-vector-input.js';
import { applyRecallRuntimeMutationBestEffort } from '../runtime/runtime.js';
import { captureFrozenChatIdentity, assertChatTargetUnchanged, isChatTargetCurrent } from './chat-target.js';
import { sha256Hex } from './durable-copy.js';
import { assertFiniteVector } from './vector-validation.js';

const OPTIONS = { namespace: 'LittleWhiteMemory', table: 'memory' };
const pending = new Map();
let tail = Promise.resolve();
let timer = null;

// ponytail: 一个串行队列保护快照与缓存变更；只有实测写入争用后才拆成按聊天队列。
function serialize(task) {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
}

function requireStore() {
    const store = globalThis.window?.__TAURITAVERN__?.api?.extension?.store;
    for (const method of ['setBlob', 'getBlob', 'setJson', 'tryGetJson', 'deleteBlob']) {
        if (typeof store?.[method] !== 'function') throw new Error(`Extension store ${method} is unavailable`);
    }
    return store;
}

async function identityOf(target) {
    const frozen = await target.stableId;
    if (frozen.error) throw frozen.error;
    if (typeof frozen.value !== 'string' || !frozen.value) throw new Error('L1/L2 snapshot requires a stable chat identity');
    return { refKey: target.refKey, stableId: frozen.value };
}

async function keysFor(identity) {
    const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify(identity)));
    const prefix = `mem-${digest.slice(0, 32)}-l12`;
    return { prefix, manifestKey: `${prefix}.json` };
}

function validateSnapshot(snapshot) {
    if (snapshot?.schemaVersion !== 1 || snapshot?.format !== 'lwm-l12-vectors'
        || !snapshot.identity?.refKey || !snapshot.identity?.stableId
        || !Array.isArray(snapshot.l1) || !Array.isArray(snapshot.l2)) {
        throw new Error('L1/L2 snapshot has an unsupported or damaged schema');
    }
    if (snapshot.invalidated !== undefined) {
        if (!snapshot.invalidated || typeof snapshot.invalidated !== 'object' || Array.isArray(snapshot.invalidated)) {
            throw new Error('L1/L2 snapshot invalidation metadata is damaged');
        }
        for (const domain of ['l1', 'l2']) {
            const rows = snapshot.invalidated[domain];
            if (!Array.isArray(rows) || rows.some(row => typeof row?.id !== 'string' || !row.id
                || (row.revision !== null && typeof row.revision !== 'string'))) {
                throw new Error('L1/L2 snapshot invalidation records are damaged');
            }
        }
    }
    for (const [domain, idKey] of [['l1', 'chunkId'], ['l2', 'eventId']]) {
        const ids = new Set();
        for (const row of snapshot[domain]) {
            if (typeof row?.[idKey] !== 'string' || !row[idKey] || ids.has(row[idKey])
                || typeof row.inputText !== 'string' || !row.inputText
                || typeof row.fingerprint !== 'string' || !row.fingerprint
                || !Number.isInteger(row.dims) || row.dims <= 0
                || (row.revision != null && typeof row.revision !== 'string')) {
                throw new Error(`L1/L2 snapshot has an invalid ${domain} record`);
            }
            ids.add(row[idKey]);
            assertFiniteVector(row.vector, `${domain} snapshot vector`, row.dims);
            if (domain === 'l1' && (!Number.isInteger(row.floor) || row.floor < 0
                || !Number.isInteger(row.chunkIdx) || row.chunkIdx < 0 || row.text !== row.inputText)) {
                throw new Error('L1 snapshot has invalid chunk metadata');
            }
        }
    }
    return snapshot;
}

function packSnapshot(snapshot) {
    const metadata = { ...snapshot };
    const files = {};
    for (const domain of ['l1', 'l2']) {
        const vectors = new Float32Array(snapshot[domain].reduce((count, row) => count + row.dims, 0));
        let offset = 0;
        metadata[domain] = snapshot[domain].map(({ vector, ...row }) => {
            vectors.set(vector, offset);
            offset += row.dims;
            return row;
        });
        files[`${domain}.bin`] = new Uint8Array(vectors.buffer);
    }
    files['snapshot.json'] = strToU8(JSON.stringify(metadata));
    return zipSync(files, { level: 1 });
}

function unpackSnapshot(bytes) {
    const files = unzipSync(bytes);
    if (!files['snapshot.json']) throw new Error('L1/L2 durable copy is missing snapshot.json');
    const snapshot = JSON.parse(strFromU8(files['snapshot.json']));
    if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.l1) || !Array.isArray(snapshot.l2)) {
        throw new Error('L1/L2 snapshot has an unsupported or damaged schema');
    }
    for (const domain of ['l1', 'l2']) {
        const binary = files[`${domain}.bin`];
        const count = snapshot[domain].reduce((sum, row) => {
            if (!Number.isInteger(row.dims) || row.dims <= 0) throw new Error('L1/L2 snapshot dimensions are invalid');
            return sum + row.dims;
        }, 0);
        if (!binary || binary.byteLength !== count * 4) throw new Error('L1/L2 snapshot vector count mismatch');
        const vectors = new Float32Array(binary.slice().buffer);
        let offset = 0;
        snapshot[domain] = snapshot[domain].map(row => {
            const vector = Array.from(vectors.slice(offset, offset + row.dims));
            offset += row.dims;
            return { ...row, vector };
        });
    }
    return validateSnapshot(snapshot);
}

async function readManifest(identity) {
    const store = requireStore();
    const keys = await keysFor(identity);
    const options = { ...OPTIONS, key: keys.manifestKey };
    const stored = await store.tryGetJson(options);
    if (stored?.found === false) return { store, keys, options, value: null };
    const value = stored?.value;
    if (stored?.found !== true || value?.schemaVersion !== 1
        || JSON.stringify(value.identity) !== JSON.stringify(identity)
        || !Number.isInteger(value.bytes) || value.bytes <= 0
        || !/^[a-f0-9]{64}$/.test(value.sha256 || '')
        || value.key !== `${keys.prefix}-${value.sha256}.zip`) {
        throw new Error('L1/L2 durable manifest is invalid');
    }
    return { store, keys, options, value };
}

async function readCopy(identity) {
    const state = await readManifest(identity);
    if (!state.value) return { ...state, snapshot: null };
    const bytes = new Uint8Array(await (await state.store.getBlob({ ...OPTIONS, key: state.value.key })).arrayBuffer());
    if (bytes.byteLength !== state.value.bytes || await sha256Hex(bytes) !== state.value.sha256) {
        throw new Error('L1/L2 durable copy digest/size mismatch');
    }
    const snapshot = unpackSnapshot(bytes);
    if (JSON.stringify(snapshot.identity) !== JSON.stringify(identity)) throw new Error('L1/L2 snapshot identity mismatch');
    return { ...state, snapshot };
}

async function assertBoundTarget(target) {
    const identity = await identityOf(target);
    // 后台提交允许切走聊天，但始终验证最初绑定的 handle，不能重新捕获当前身份。
    if (await target.handle.stableId() !== identity.stableId) throw new Error('Chat identity changed before L1/L2 snapshot commit');
    return identity;
}

async function writeCopy(state, snapshot, target, verifyCache = async () => {}) {
    validateSnapshot(snapshot);
    const bytes = packSnapshot(snapshot);
    const digest = await sha256Hex(bytes);
    const key = `${state.keys.prefix}-${digest}.zip`;
    await assertBoundTarget(target);
    await verifyCache();
    // 新 Blob 使用内容地址：清单提交失败不会破坏上一次已提交的副本。
    await state.store.setBlob({ ...OPTIONS, key, data: bytes });
    const confirmed = new Uint8Array(await (await state.store.getBlob({ ...OPTIONS, key })).arrayBuffer());
    if (confirmed.byteLength !== bytes.byteLength || await sha256Hex(confirmed) !== digest) {
        throw new Error('L1/L2 durable blob read-back verification failed');
    }
    await assertBoundTarget(target);
    await verifyCache();
    const previous = await state.store.tryGetJson(state.options);
    if (![true, false].includes(previous?.found)
        || JSON.stringify(previous.found ? previous.value : null) !== JSON.stringify(state.value)) {
        throw new Error('L1/L2 durable manifest changed before commit');
    }
    const manifest = { schemaVersion: 1, identity: snapshot.identity, key, bytes: bytes.byteLength, sha256: digest };
    await state.store.setJson({ ...state.options, value: manifest });
    const stored = await state.store.tryGetJson(state.options);
    if (!stored?.found || JSON.stringify(stored.value) !== JSON.stringify(manifest)) {
        throw new Error('L1/L2 durable manifest read-back verification failed');
    }
    if (state.value && state.value.key !== key) {
        try {
            await state.store.deleteBlob({ ...OPTIONS, key: state.value.key });
        } catch (error) {
            if (!/not found/i.test(String(error?.message || ''))) throw error;
        }
    }
}

function scheduleFlush(delay = 1500) {
    clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        void flushL12DurableCopy().catch(() => {
            xbLog.error('l12-durable', 'event=l12_snapshot_commit operation=scheduled outcome=failed next=retry_pending');
        });
    }, delay);
}

/** 缓存写入与快照提交串行；删除先持久失效，避免缓存清空后旧副本复活。 */
export function runL12Mutation(chatId, mutation, invalidate = null) {
    const target = captureFrozenChatIdentity(chatId);
    return serialize(async () => {
        await assertChatTargetUnchanged(target, 'L1/L2 cache mutation');
        if (!isChatTargetCurrent(target)) throw new Error('Chat changed before L1/L2 cache mutation');
        const identity = await identityOf(target);
        const meta = await metaTable.get(chatId);
        if (meta?.l12Identity && JSON.stringify(meta.l12Identity) !== JSON.stringify(identity)) {
            throw new Error('L1/L2 cache chatId collision: refusing to write another chat identity');
        }
        if (invalidate) {
            // 先确认既有待写资产，再失效；失败时不能丢掉此前成功的缓存更新。
            const previous = pending.get(target.refKey);
            if (previous) await submitEntry(target.refKey, previous);
            const state = await readCopy(identity);
            const snapshot = structuredClone(state.snapshot || { schemaVersion: 1, format: 'lwm-l12-vectors', identity, l1: [], l2: [] });
            snapshot.invalidated ||= { l1: [], l2: [] };
            const domain = invalidate.domain;
            const idKey = domain === 'l1' ? 'chunkId' : 'eventId';
            const cacheRows = domain === 'l1'
                ? await chunksTable.where('chatId').equals(chatId).toArray()
                : await eventVectorsTable.where('chatId').equals(chatId).toArray();
            const removed = row => domain === 'l1'
                ? (invalidate.floor == null || (invalidate.exact ? row.floor === invalidate.floor : row.floor >= invalidate.floor))
                : (!invalidate.ids || invalidate.ids.includes(row.eventId));
            const cacheIds = new Set(cacheRows.filter(removed).map(row => row[idKey]));
            const vectors = domain === 'l1' ? await chunkVectorsTable.where('chatId').equals(chatId).toArray() : cacheRows;
            const revisions = new Map(snapshot.invalidated[domain].map(row => [JSON.stringify([row.id, row.revision]), row]));
            for (const row of [...snapshot[domain].filter(removed), ...vectors.filter(row => cacheIds.has(row[idKey]))]) {
                const revision = { id: row[idKey], revision: row.revision ?? null };
                revisions.set(JSON.stringify([revision.id, revision.revision]), revision);
            }
            snapshot.invalidated[domain] = [...revisions.values()];
            snapshot[domain] = snapshot[domain].filter(row => !removed(row));
            await writeCopy(state, snapshot, target);
            await assertChatTargetUnchanged(target, 'L1/L2 cache deletion');
            if (!isChatTargetCurrent(target)) throw new Error('Chat changed before L1/L2 cache deletion');
        }
        await assertChatTargetUnchanged(target, 'L1/L2 cache write');
        if (!isChatTargetCurrent(target)) throw new Error('Chat changed before L1/L2 cache write');
        const result = await db.transaction('rw', metaTable, chunksTable, chunkVectorsTable, eventVectorsTable, async () => {
            if (JSON.stringify(await metaTable.get(chatId)) !== JSON.stringify(meta)) {
                throw new Error('L1/L2 cache metadata changed before mutation');
            }
            const result = await mutation();
            const updatedMeta = await metaTable.get(chatId);
            await metaTable.put({ ...(updatedMeta || { fingerprint: null, lastChunkFloor: -1, updatedAt: Date.now() }),
                chatId, l12Identity: identity });
            if (!isChatTargetCurrent(target)) throw new Error('Chat changed during L1/L2 cache write');
            return result;
        });
        if (!invalidate) {
            pending.set(target.refKey, { chatId, target });
            scheduleFlush();
        }
        return result;
    });
}

function sameCache(original, current) {
    if (JSON.stringify(original[0]) !== JSON.stringify(current[0])
        || JSON.stringify(original[3]) !== JSON.stringify(current[3])) return false;
    return [1, 2].every(index => original[index].length === current[index].length && original[index].every((row, i) => {
        const next = current[index][i];
        if (JSON.stringify({ ...row, vector: null }) !== JSON.stringify({ ...next, vector: null })) return false;
        const bytes = new Uint8Array(row.vector);
        const nextBytes = new Uint8Array(next.vector);
        return bytes.length === nextBytes.length && bytes.every((value, offset) => value === nextBytes[offset]);
    }));
}

function invalidatedKeys(snapshot, domain) {
    return new Set((snapshot?.invalidated?.[domain] || []).map(row => JSON.stringify([row.id, row.revision])));
}

function revisionKey(row, idKey) {
    return JSON.stringify([row[idKey], row.revision ?? null]);
}

function mergeRows(previous, updates, idKey) {
    const rows = new Map((previous || []).map(row => [row[idKey], row]));
    for (const row of updates) rows.set(row[idKey], row);
    return [...rows.values()];
}

async function submitEntry(key, entry) {
    const identity = await assertBoundTarget(entry.target);
    const state = await readCopy(identity); // 未知 schema/损坏绝不覆盖。
    const readCache = () => db.transaction('r', metaTable, chunksTable, chunkVectorsTable, eventVectorsTable, () => Promise.all([
        chunksTable.where('chatId').equals(entry.chatId).toArray(),
        chunkVectorsTable.where('chatId').equals(entry.chatId).toArray(),
        eventVectorsTable.where('chatId').equals(entry.chatId).toArray(),
        metaTable.get(entry.chatId),
    ]));
    const original = await readCache();
    const [chunks, chunkVectors, events, meta] = original;
    if (meta?.l12Identity && JSON.stringify(meta.l12Identity) !== JSON.stringify(identity)) {
        throw new Error('L1/L2 snapshot cache ownership changed');
    }
    const verifyCache = async () => {
        const current = await readCache();
        if (!sameCache(original, current)) throw new Error('L1/L2 cache changed before snapshot commit');
    };
    const chunkMap = new Map(chunks.map(row => [row.chunkId, row]));
    const invalidL1 = invalidatedKeys(state.snapshot, 'l1');
    const invalidL2 = invalidatedKeys(state.snapshot, 'l2');
    const l1Updates = chunkVectors.flatMap(row => {
        if (invalidL1.has(revisionKey(row, 'chunkId'))) return [];
        const chunk = chunkMap.get(row.chunkId);
        if (!chunk?.text || !row.fingerprint || (row.inputText && row.inputText !== chunk.text)) return [];
        return [{ ...chunk, dims: row.dims, fingerprint: row.fingerprint, revision: row.revision ?? null,
            inputText: chunk.text, vector: Array.from(new Float32Array(row.vector)) }];
    });
    // 旧 L2 无输入文本的记录保留在缓存，但不能冒充可验证的持久资产。
    const l2Updates = events.filter(row => row.inputText && row.fingerprint
        && !invalidL2.has(revisionKey(row, 'eventId'))).map(row => ({
        eventId: row.eventId, inputText: row.inputText, fingerprint: row.fingerprint, revision: row.revision ?? null,
        dims: row.dims, vector: Array.from(new Float32Array(row.vector)),
    }));
    // 缓存可能只恢复了一部分；不能把“缓存缺失”当作“用户删除”。
    const l1 = mergeRows(state.snapshot?.l1, l1Updates, 'chunkId');
    const l2 = mergeRows(state.snapshot?.l2, l2Updates, 'eventId');
    const invalidated = { l1: [], l2: [] };
    for (const [domain, rows, idKey] of [['l1', l1Updates, 'chunkId'], ['l2', l2Updates, 'eventId']]) {
        const newIds = new Set(rows.map(row => row[idKey]));
        invalidated[domain] = (state.snapshot?.invalidated?.[domain] || []).filter(row => !newIds.has(row.id));
    }
    await writeCopy(state, { schemaVersion: 1, format: 'lwm-l12-vectors', identity, l1, l2, invalidated }, entry.target, verifyCache);
    pending.delete(key);
    if (!pending.size) {
        clearTimeout(timer);
        timer = null;
    }
}

export function flushL12DurableCopy(chatId = null) {
    clearTimeout(timer);
    timer = null;
    return serialize(async () => {
        const errors = [];
        try {
            for (const [key, entry] of pending) {
                if (chatId && entry.chatId !== chatId) continue;
                try { await submitEntry(key, entry); }
                catch (error) { errors.push(error); }
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, 'L1/L2 snapshots failed to commit');
        } finally {
            if (pending.size) scheduleFlush(5000);
        }
    });
}

/** 恢复与常规写入共用串行队列；来源复验和 bulkAdd 保证不覆盖原缓存。 */
export function restoreL12DurableCopy(chatId, fingerprint) {
    const target = captureFrozenChatIdentity(chatId);
    return serialize(async () => {
        const identity = await identityOf(target);
        const { snapshot } = await readCopy(identity);
        const initialMeta = await metaTable.get(chatId);
        if (initialMeta?.l12Identity && JSON.stringify(initialMeta.l12Identity) !== JSON.stringify(identity)) {
            throw new Error('L1/L2 restore cache chatId collision');
        }
        if (initialMeta?.fingerprint && initialMeta.fingerprint !== fingerprint) return { restored: 0, fingerprintMismatch: true };
        if (!snapshot) {
            await assertChatTargetUnchanged(target, 'L1/L2 initial snapshot');
            if (!isChatTargetCurrent(target)) throw new Error('Chat changed before L1/L2 initial snapshot');
            pending.set(target.refKey, { chatId, target });
            scheduleFlush();
            return { restored: 0, missing: true };
        }
        await assertChatTargetUnchanged(target, 'L1/L2 snapshot restore');
        if (!isChatTargetCurrent(target) || getContext()?.chatId !== chatId) throw new Error('Chat changed before L1/L2 snapshot restore');
        const chat = getContext().chat || [];
        const expected = chat.flatMap((message, floor) => chunkMessage(floor, message));
        const chunkMap = new Map(expected.map(row => [row.chunkId, row]));
        const eventMap = new Map((chat_metadata.extensions?.[EXT_ID]?.storySummary?.json?.events || [])
            .map(event => [event.id, buildEventVectorText(event)]));
        const sourceSignature = () => JSON.stringify({
            chunks: (getContext().chat || []).flatMap((message, floor) => chunkMessage(floor, message)),
            events: (chat_metadata.extensions?.[EXT_ID]?.storySummary?.json?.events || [])
                .map(event => [event.id, buildEventVectorText(event)]),
        });
        const source = sourceSignature();
        const l1 = snapshot.l1.filter(row => row.fingerprint === fingerprint
            && chunkMap.get(row.chunkId)?.text === row.inputText
            && chunkMap.get(row.chunkId)?.floor === row.floor && chunkMap.get(row.chunkId)?.chunkIdx === row.chunkIdx);
        const l2 = snapshot.l2.filter(row => row.fingerprint === fingerprint && eventMap.get(row.eventId) === row.inputText);
        await assertChatTargetUnchanged(target, 'L1/L2 snapshot cache write');
        if (!isChatTargetCurrent(target) || sourceSignature() !== source) throw new Error('L1/L2 source changed before restore');
        const addedChunks = [];
        const addedVectors = [];
        const addedEvents = [];
        let metaChanged = false;
        await db.transaction('rw', metaTable, chunksTable, chunkVectorsTable, eventVectorsTable, async () => {
            const [storedChunks, storedVectors, storedEvents] = await Promise.all([
                chunksTable.where('chatId').equals(chatId).toArray(),
                chunkVectorsTable.where('chatId').equals(chatId).toArray(),
                eventVectorsTable.where('chatId').equals(chatId).toArray(),
            ]);
            const chunks = new Map(storedChunks.map(row => [row.chunkId, row]));
            const vectors = new Map(storedVectors.map(row => [row.chunkId, row]));
            const eventIds = new Set(storedEvents.map(row => row.eventId));
            for (const row of l1) {
                const stored = chunks.get(row.chunkId);
                const vector = vectors.get(row.chunkId);
                if (vector || (stored && stored.text !== row.inputText)) continue;
                if (!stored) {
                    const chunk = { ...chunkMap.get(row.chunkId), chatId, createdAt: Date.now() };
                    chunks.set(chunk.chunkId, chunk);
                    addedChunks.push(chunk);
                }
                const record = { chatId, chunkId: row.chunkId, fingerprint, inputText: row.inputText, revision: row.revision ?? null,
                    dims: row.dims, vector: new Float32Array(row.vector).buffer };
                vectors.set(record.chunkId, record);
                addedVectors.push(record);
            }
            for (const row of l2) {
                if (eventIds.has(row.eventId)) continue;
                const record = { chatId, eventId: row.eventId, fingerprint, inputText: row.inputText, revision: row.revision ?? null,
                    dims: row.dims, vector: new Float32Array(row.vector).buffer };
                addedEvents.push(record);
            }
            if (addedChunks.length) await chunksTable.bulkAdd(addedChunks);
            if (addedVectors.length) await chunkVectorsTable.bulkAdd(addedVectors);
            if (addedEvents.length) await eventVectorsTable.bulkAdd(addedEvents);
            // 不相信旧快照的水位：按当前正文与缓存逐层确认完整前缀。
            const invalidL1 = invalidatedKeys(snapshot, 'l1');
            let floor = 0;
            for (; floor < chat.length; floor++) {
                const complete = chunkMessage(floor, chat[floor]).every(chunk => {
                    const vector = vectors.get(chunk.chunkId);
                    if (chunks.get(chunk.chunkId)?.text !== chunk.text || vector?.fingerprint !== fingerprint
                        || invalidL1.has(revisionKey(vector, 'chunkId'))) return false;
                    try { assertFiniteVector(new Float32Array(vector.vector), 'restored L1 coverage', vector.dims); }
                    catch { return false; }
                    return !vector.inputText || vector.inputText === chunk.text;
                });
                if (!complete) break;
            }
            const meta = await metaTable.get(chatId);
            if (JSON.stringify(meta) !== JSON.stringify(initialMeta)) throw new Error('L1/L2 cache metadata changed before restore');
            const added = addedVectors.length + addedEvents.length;
            metaChanged = Boolean(added || (meta && meta.lastChunkFloor !== floor - 1));
            if (metaChanged) {
                await metaTable.put({ ...(meta || {}), chatId, fingerprint: added ? fingerprint : (meta?.fingerprint ?? null), l12Identity: identity,
                    lastChunkFloor: floor - 1, updatedAt: Date.now() });
            }
            if (!isChatTargetCurrent(target) || sourceSignature() !== source) throw new Error('L1/L2 source changed during restore');
        });
        if (addedChunks.length) applyRecallRuntimeMutationBestEffort(chatId, { type: 'upsertChunks', chunks: addedChunks });
        if (addedVectors.length) applyRecallRuntimeMutationBestEffort(chatId, { type: 'upsertChunkVectors', items: addedVectors });
        if (metaChanged) applyRecallRuntimeMutationBestEffort(chatId, { type: 'meta', meta: await metaTable.get(chatId) });
        if (addedEvents.length) applyRecallRuntimeMutationBestEffort(chatId, { type: 'upsertEventVectors', items: addedEvents });
        return { restored: addedVectors.length + addedEvents.length };
    });
}
