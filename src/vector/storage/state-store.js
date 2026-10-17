// ═══════════════════════════════════════════════════════════════════════════
// Story Summary - State Store (L0)
// StateAtom 存 chat_metadata（持久化）
// StateVector 存 IndexedDB（可重建）
// ═══════════════════════════════════════════════════════════════════════════

import { chat_metadata } from '../../../../../../../script.js';
import { stateVectorsTable } from '../../summary/data/db.js';
import { EXT_ID } from '../../support/constants.js';
import { xbLog } from '../../support/debug-core.js';
import {
    applyRecallRuntimeMutationBestEffort,
    clearRecallRuntime,
} from '../runtime/runtime.js';
import { captureChatTarget } from './chat-target.js';
import { writeL0DurableCopy, readL0DurableCopy, deleteL0DurableCopy } from './durable-copy.js';
import { assertFiniteVector } from './vector-validation.js';

const MODULE_ID = 'state-store';
const L0_METADATA_RETRY_MS = 3000;
const L0_DURABLE_DEBOUNCE_MS = 1500;
const L0_DURABLE_RETRY_MS = 5000;

let l0MetadataBatchDepth = 0;
let l0MetadataSaveInFlight = null;
let l0MetadataRetryTimer = null;
const l0MetadataPending = new Map();

let l0DurableSaveInFlight = null;
let l0DurableTimer = null;
const l0DurablePending = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════

export function float32ToBuffer(arr) {
    return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
}

export function bufferToFloat32(buffer) {
    return new Float32Array(buffer);
}

// ═══════════════════════════════════════════════════════════════════════════
// StateAtom 操作（chat_metadata）
// ═══════════════════════════════════════════════════════════════════════════

function ensureStateAtomsArray() {
    chat_metadata.extensions ||= {};
    chat_metadata.extensions[EXT_ID] ||= {};
    chat_metadata.extensions[EXT_ID].stateAtoms ||= [];
    return chat_metadata.extensions[EXT_ID].stateAtoms;
}

// L0Index: per-floor status (ok | empty | fail)
function ensureL0Index() {
    chat_metadata.extensions ||= {};
    chat_metadata.extensions[EXT_ID] ||= {};
    chat_metadata.extensions[EXT_ID].l0Index ||= { version: 1, byFloor: {} };
    chat_metadata.extensions[EXT_ID].l0Index.byFloor ||= {};
    return chat_metadata.extensions[EXT_ID].l0Index;
}

function cloneL0Metadata() {
    const extension = chat_metadata.extensions?.[EXT_ID] || {};
    return JSON.parse(JSON.stringify({
        stateAtoms: extension.stateAtoms || [],
        l0Index: extension.l0Index || { version: 1, byFloor: {} },
    }));
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function clearL0MetadataRetryTimer() {
    if (l0MetadataRetryTimer) {
        clearTimeout(l0MetadataRetryTimer);
        l0MetadataRetryTimer = null;
    }
}

function scheduleL0MetadataFlush(delayMs = 0) {
    clearL0MetadataRetryTimer();
    l0MetadataRetryTimer = setTimeout(() => {
        l0MetadataRetryTimer = null;
        void flushL0MetadataSave('scheduled').catch(error => {
            xbLog.error(MODULE_ID, 'L0 metadata 保存失败，将保留待写数据并重试', error);
        });
    }, Math.max(0, delayMs));
}

function markL0MetadataDirty(source = 'unknown') {
    const target = captureChatTarget();
    if (typeof target.handle?.metadata?.get !== 'function'
        || typeof target.handle?.metadata?.setExtension !== 'function') {
        throw new Error('TauriTavern ChatHandle metadata contract is unavailable');
    }
    const pending = l0MetadataPending.get(target.refKey) || {
        handle: target.handle,
        // 提交时复验；读取失败保留为错误值，由 commitL0MetadataEntry 原样抛出。
        stableId: Promise.resolve()
            .then(() => target.readStableId())
            .then(value => ({ value }), error => ({ error })),
        sources: new Set(),
        version: 0,
    };
    pending.snapshot = cloneL0Metadata();
    pending.sources.add(source);
    pending.version++;
    l0MetadataPending.set(target.refKey, pending);

    if (l0MetadataBatchDepth <= 0 && !l0MetadataSaveInFlight) {
        scheduleL0MetadataFlush(0);
    }
}

export function beginL0MetadataBatch() {
    l0MetadataBatchDepth++;
}

export function endL0MetadataBatch() {
    l0MetadataBatchDepth = Math.max(0, l0MetadataBatchDepth - 1);
    if (l0MetadataBatchDepth === 0 && l0MetadataPending.size > 0) {
        scheduleL0MetadataFlush(0);
    }
}

async function commitL0MetadataEntry(key, pending, reason) {
    const { handle, snapshot, version } = pending;
    const sources = [...pending.sources].join(',');
    const initialStableId = await pending.stableId;
    if (initialStableId.error) throw initialStableId.error;
    if (await handle.stableId() !== initialStableId.value) {
        throw new Error('Chat identity changed before L0 metadata commit');
    }

    const metadata = await handle.metadata.get();
    const storedExtension = metadata?.extensions?.[EXT_ID] ?? {};
    if (!storedExtension || typeof storedExtension !== 'object' || Array.isArray(storedExtension)) {
        throw new Error(`chat_metadata.extensions.${EXT_ID} is not an object`);
    }

    await handle.metadata.setExtension({
        namespace: EXT_ID,
        value: { ...storedExtension, ...snapshot },
    });

    const confirmed = (await handle.metadata.get())?.extensions?.[EXT_ID];
    if (canonicalJson(confirmed?.stateAtoms) !== canonicalJson(snapshot.stateAtoms)
        || canonicalJson(confirmed?.l0Index) !== canonicalJson(snapshot.l0Index)) {
        throw new Error('L0 metadata read-back verification failed');
    }

    if (l0MetadataPending.get(key) === pending && pending.version === version) {
        l0MetadataPending.delete(key);
    }
    xbLog.info(MODULE_ID, `L0 metadata 已持久化 reason=${reason} sources=${sources || '-'}`);
    return true;
}

export async function flushL0MetadataSave(reason = 'manual') {
    if (l0MetadataPending.size === 0 || l0MetadataBatchDepth > 0) return false;
    if (l0MetadataSaveInFlight) {
        await l0MetadataSaveInFlight;
        return l0MetadataPending.size > 0 ? flushL0MetadataSave(reason) : false;
    }

    clearL0MetadataRetryTimer();
    const [key, pending] = l0MetadataPending.entries().next().value;
    let retry = false;
    l0MetadataSaveInFlight = commitL0MetadataEntry(key, pending, reason);
    try {
        return await l0MetadataSaveInFlight;
    } catch (error) {
        retry = true;
        throw error;
    } finally {
        l0MetadataSaveInFlight = null;
        if (l0MetadataPending.size > 0) {
            scheduleL0MetadataFlush(retry ? L0_METADATA_RETRY_MS : 0);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// L0 durable 副本（extension store Blob）
// 向量写入先落 IndexedDB 缓存，再由这里统一提交 durable 副本；失败保留待写并重试。
// ═══════════════════════════════════════════════════════════════════════════

function scheduleL0DurableFlush(delayMs) {
    if (l0DurableTimer) clearTimeout(l0DurableTimer);
    l0DurableTimer = setTimeout(() => {
        l0DurableTimer = null;
        void flushL0DurableCopy('scheduled').catch(error => {
            xbLog.error(MODULE_ID, 'L0 durable 副本保存失败，将保留待写数据并重试', error);
        });
    }, Math.max(0, delayMs));
}

function markL0DurableDirty(chatId, fingerprint = '') {
    if (!chatId) return;
    const entry = l0DurablePending.get(chatId) || { fingerprint: '' };
    if (fingerprint) entry.fingerprint = fingerprint;
    l0DurablePending.set(chatId, entry);
    if (!l0DurableSaveInFlight) scheduleL0DurableFlush(L0_DURABLE_DEBOUNCE_MS);
}

async function submitL0DurableEntry(chatId, entry) {
    const rows = await getAllStateVectors(chatId);
    if (!rows.length) {
        await deleteL0DurableCopy(chatId);
        return false;
    }
    const fingerprint = entry.fingerprint || rows.find(row => row.fingerprint)?.fingerprint || '';
    await writeL0DurableCopy(chatId, rows, { fingerprint });
    return true;
}

/** 提交待写的 L0 durable 副本；失败抛错并保留待写数据，由重试定时器再次尝试。 */
export async function flushL0DurableCopy(reason = 'manual') {
    if (l0DurablePending.size === 0) return false;
    if (l0DurableSaveInFlight) {
        await l0DurableSaveInFlight.catch(() => {});
        return l0DurablePending.size > 0 ? flushL0DurableCopy(reason) : false;
    }

    if (l0DurableTimer) {
        clearTimeout(l0DurableTimer);
        l0DurableTimer = null;
    }
    const [chatId, entry] = l0DurablePending.entries().next().value;
    let retry = false;
    const run = submitL0DurableEntry(chatId, entry);
    l0DurableSaveInFlight = run;
    try {
        const wrote = await run;
        if (l0DurablePending.get(chatId) === entry) l0DurablePending.delete(chatId);
        xbLog.info(MODULE_ID, `L0 durable 副本已持久化 reason=${reason} chat=${chatId} wrote=${wrote}`);
        return wrote;
    } catch (error) {
        retry = true;
        throw error;
    } finally {
        if (l0DurableSaveInFlight === run) l0DurableSaveInFlight = null;
        if (l0DurablePending.size > 0) scheduleL0DurableFlush(retry ? L0_DURABLE_RETRY_MS : 0);
    }
}

/**
 * 用 durable 副本重建 IndexedDB 缓存。仅恢复当前 stateAtoms 仍存在的向量，
 * 不复活已删除锚点；fingerprint 不一致时不恢复，交给正常重算路径。
 */
export async function restoreStateVectorsFromCopy(chatId, fingerprint) {
    if (!chatId) return { restored: 0, total: 0 };
    const copy = await readL0DurableCopy(chatId);
    if (!copy) return { restored: 0, total: 0, missing: true };
    if (String(copy.manifest?.l0?.fingerprint || '') !== String(fingerprint || '')) {
        return { restored: 0, total: copy.rows.length, fingerprintMismatch: true };
    }

    const atoms = new Set(getStateAtoms().map(atom => atom?.atomId).filter(Boolean));
    const rows = copy.rows.filter(row => row?.atomId && atoms.has(row.atomId));
    if (!rows.length) return { restored: 0, total: copy.rows.length };

    const records = rows.map(row => ({
        chatId,
        atomId: row.atomId,
        floor: row.floor,
        vector: float32ToBuffer(new Float32Array(row.vector)),
        dims: row.dims,
        rVector: row.rDims ? float32ToBuffer(new Float32Array(row.rVector)) : null,
        rDims: row.rDims,
        fingerprint,
    }));
    await stateVectorsTable.bulkPut(records);
    applyRecallRuntimeMutationBestEffort(chatId, { type: 'upsertStateVectors', items: records });
    xbLog.info(MODULE_ID, `L0 durable 副本已恢复 ${records.length} 条到缓存`);
    return { restored: records.length, total: copy.rows.length };
}

export function getL0Index() {
    return ensureL0Index();
}

export function getL0FloorStatus(floor) {
    const idx = ensureL0Index();
    return idx.byFloor?.[String(floor)] || null;
}

export function setL0FloorStatus(floor, record) {
    const idx = ensureL0Index();
    idx.byFloor[String(floor)] = {
        ...record,
        floor,
        updatedAt: Date.now(),
    };
    markL0MetadataDirty('setL0FloorStatus');
}

export function clearL0Index() {
    const idx = ensureL0Index();
    idx.byFloor = {};
    markL0MetadataDirty('clearL0Index');
}

export function deleteL0IndexFromFloor(fromFloor) {
    const idx = ensureL0Index();
    const keys = Object.keys(idx.byFloor || {});
    let deleted = 0;
    for (const k of keys) {
        const f = Number(k);
        if (Number.isFinite(f) && f >= fromFloor) {
            delete idx.byFloor[k];
            deleted++;
        }
    }
    if (deleted > 0) {
        markL0MetadataDirty('deleteL0IndexFromFloor');
        xbLog.info(MODULE_ID, `删除 ${deleted} 条 L0Index (floor >= ${fromFloor})`);
    }
    return deleted;
}

/**
 * 获取当前聊天的所有 StateAtoms
 */
export function getStateAtoms() {
    return ensureStateAtomsArray();
}

/**
 * 保存新的 StateAtoms（追加，去重）
 */
export function saveStateAtoms(atoms) {
    if (!atoms?.length) return;

    const arr = ensureStateAtomsArray();
    const existing = new Set(arr.map(a => a.atomId));

    let added = 0;
    for (const atom of atoms) {
        // 有效性检查
        if (!atom?.atomId || typeof atom.floor !== 'number' || atom.floor < 0 || !atom.semantic) {
            xbLog.warn(MODULE_ID, `跳过无效 atom: ${atom?.atomId}`);
            continue;
        }

        if (!existing.has(atom.atomId)) {
            arr.push(atom);
            existing.add(atom.atomId);
            added++;
        }
    }

    if (added > 0) {
        markL0MetadataDirty('saveStateAtoms');
        xbLog.info(MODULE_ID, `存储 ${added} 个 StateAtom`);
    }
}

/**
 * 删除指定楼层及之后的 StateAtoms
 */
export function deleteStateAtomsFromFloor(floor) {
    const arr = ensureStateAtomsArray();
    const before = arr.length;

    const filtered = arr.filter(a => a.floor < floor);
    chat_metadata.extensions[EXT_ID].stateAtoms = filtered;

    const deleted = before - filtered.length;
    if (deleted > 0) {
        markL0MetadataDirty('deleteStateAtomsFromFloor');
        xbLog.info(MODULE_ID, `删除 ${deleted} 个 StateAtom (floor >= ${floor})`);
    }

    return deleted;
}

/**
 * 清空所有 StateAtoms
 */
export function clearStateAtoms() {
    const arr = ensureStateAtomsArray();
    const count = arr.length;

    chat_metadata.extensions[EXT_ID].stateAtoms = [];

    if (count > 0) {
        markL0MetadataDirty('clearStateAtoms');
        xbLog.info(MODULE_ID, `清空 ${count} 个 StateAtom`);
    }
}

/**
 * 获取 StateAtoms 数量
 */
export function getStateAtomsCount() {
    return ensureStateAtomsArray().length;
}

/**
 * Return floors that already have extracted atoms.
 */
export function getExtractedFloors() {
    const floors = new Set();
    const arr = ensureStateAtomsArray();
    for (const atom of arr) {
        if (typeof atom?.floor === 'number' && atom.floor >= 0) {
            floors.add(atom.floor);
        }
    }
    return floors;
}

/**
 * Replace all stored StateAtoms.
 */
export function replaceStateAtoms(atoms) {
    const next = Array.isArray(atoms) ? atoms : [];
    chat_metadata.extensions[EXT_ID].stateAtoms = next;
    markL0MetadataDirty('replaceStateAtoms');
    xbLog.info(MODULE_ID, `替换 StateAtoms: ${next.length} 条`);
}

// ═══════════════════════════════════════════════════════════════════════════
// StateVector 操作（IndexedDB）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 保存 StateVectors
 */
export async function saveStateVectors(chatId, items, fingerprint) {
    if (!chatId || !items?.length) return;

    let expectedDimensions = null;
    const records = items.map((item, index) => {
        const dims = assertFiniteVector(item.vector, `state vector ${index}`, expectedDimensions);
        expectedDimensions ??= dims;
        const rDims = item.rVector?.length
            ? assertFiniteVector(item.rVector, `state relation vector ${index}`, dims)
            : 0;
        return {
            chatId,
            atomId: item.atomId,
            floor: item.floor,
            vector: float32ToBuffer(new Float32Array(item.vector)),
            dims,
            rVector: rDims ? float32ToBuffer(new Float32Array(item.rVector)) : null,
            rDims,
            fingerprint,
        };
    });

    await stateVectorsTable.bulkPut(records);
    applyRecallRuntimeMutationBestEffort(chatId, {
        type: 'upsertStateVectors',
        items: records,
    });
    markL0DurableDirty(chatId, fingerprint);
    xbLog.info(MODULE_ID, `存储 ${records.length} 个 StateVector`);
}

/**
 * 获取所有 StateVectors
 */
export async function getAllStateVectors(chatId) {
    if (!chatId) return [];

    const records = await stateVectorsTable.where('chatId').equals(chatId).toArray();
    return records.map(r => ({
        ...r,
        vector: bufferToFloat32(r.vector),
        rVector: r.rVector ? bufferToFloat32(r.rVector) : null,
    }));
}

/**
 * 获取完整性检查所需的轻量描述，不把整张 L0 向量表解码成 Float32Array。
 */
export async function getStateVectorDescriptors(chatId) {
    if (!chatId) return [];

    const descriptors = [];
    await stateVectorsTable.where('chatId').equals(chatId).each(record => {
        const dims = Number(record?.dims);
        const rDims = Number(record?.rDims);
        const dimensionsValid = Number.isInteger(dims) && dims > 0;
        const relationDimensionsValid = Number.isInteger(rDims) && rDims === dims;
        descriptors.push({
            atomId: record?.atomId,
            fingerprint: record?.fingerprint,
            vectorValid: dimensionsValid
                && Number(record?.vector?.byteLength || 0) === dims * Float32Array.BYTES_PER_ELEMENT,
            rVectorValid: relationDimensionsValid
                && Number(record?.rVector?.byteLength || 0) === rDims * Float32Array.BYTES_PER_ELEMENT,
        });
    });
    return descriptors;
}

/**
 * 删除指定楼层及之后的 StateVectors
 */
export async function deleteStateVectorsFromFloor(chatId, floor) {
    if (!chatId) return;

    const deleted = await stateVectorsTable
        .where('chatId')
        .equals(chatId)
        .filter(v => v.floor >= floor)
        .delete();

    applyRecallRuntimeMutationBestEffort(chatId, {
        type: 'deleteStateVectorsFromFloor',
        floor,
    });
    if (deleted > 0) {
        markL0DurableDirty(chatId);
        xbLog.info(MODULE_ID, `删除 ${deleted} 个 StateVector (floor >= ${floor})`);
    }
}

/**
 * 清空所有 StateVectors
 */
export async function clearStateVectors(chatId) {
    if (!chatId) return;

    const deleted = await stateVectorsTable.where('chatId').equals(chatId).delete();
    await clearRecallRuntime(chatId, 'state');
    // 显式清空必须同时移除 durable 副本，避免恢复路径复活已清除的数据。
    l0DurablePending.delete(chatId);
    await deleteL0DurableCopy(chatId);
    if (deleted > 0) {
        xbLog.info(MODULE_ID, `清空 ${deleted} 个 StateVector`);
    }
}

/**
 * 获取 StateVectors 数量
 */
export async function getStateVectorsCount(chatId) {
    if (!chatId) return 0;
    return await stateVectorsTable.where('chatId').equals(chatId).count();
}
