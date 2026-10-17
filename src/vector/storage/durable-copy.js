// ═══════════════════════════════════════════════════════════════════════════
// L0 StateVector Durable Copy
// IndexedDB 是可重建的读取缓存；本模块把完整 L0 向量集落到宿主 extension store。
// 布局已冻结；改动持久格式前先核对项目存储契约文档的「已冻结布局」一节。
// ═══════════════════════════════════════════════════════════════════════════

import { zipSync, unzipSync, strToU8, strFromU8 } from '../../../libs/fflate.mjs';
import { xbLog } from '../../support/debug-core.js';

const MODULE_ID = 'l0-durable';
const NAMESPACE = 'LittleWhiteMemory';
const TABLE = 'memory';
const MANIFEST_SCHEMA_VERSION = 1;
const PACKAGE_FORMAT = 'lwb-state-vectors';
const PACKAGE_VERSION = 1;

function requireStore() {
    const store = globalThis.window?.__TAURITAVERN__?.api?.extension?.store;
    if (typeof store?.setBlob !== 'function' || typeof store?.getBlob !== 'function'
        || typeof store?.setJson !== 'function' || typeof store?.tryGetJson !== 'function') {
        throw new Error('TauriTavern api.extension.store JSON/Blob contract is unavailable');
    }
    return store;
}

function requireSubtle() {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error('WebCrypto subtle is unavailable');
    return subtle;
}

export async function sha256Hex(bytes) {
    const digest = await requireSubtle().digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** chatId → 稳定键前缀；只由前缀加摘要派生，不写入原始聊天标识。 */
export async function getDurableKeys(chatId) {
    const raw = String(chatId || '');
    if (!raw) throw new Error('Durable copy requires a chat id');
    const hash = await sha256Hex(new TextEncoder().encode(raw));
    const prefix = `mem-${hash.slice(0, 32)}`;
    return { prefix, manifestKey: `${prefix}.json`, l0Key: `${prefix}-l0.zip` };
}

function isNotFoundError(error) {
    return /not found/i.test(String(error?.message || ''));
}

function float32ToBytes(vectors, dims) {
    const buffer = new ArrayBuffer(vectors.length * dims * Float32Array.BYTES_PER_ELEMENT);
    const view = new Float32Array(buffer);
    let offset = 0;
    for (const vector of vectors) {
        for (let i = 0; i < dims; i++) view[offset++] = Number(vector?.[i]) || 0;
    }
    return new Uint8Array(buffer);
}

function bytesToFloat32(bytes, dims) {
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT));
    const vectors = [];
    for (let i = 0; i + dims <= view.length; i += dims) vectors.push(view.slice(i, i + dims));
    return vectors;
}

/** rows: [{ atomId, floor, dims, rDims, vector: Float32Array, rVector: Float32Array|null }] */
export function packL0Package(rows, { fingerprint = '' } = {}) {
    const sorted = [...(rows || [])].sort((a, b) => String(a.atomId).localeCompare(String(b.atomId)));
    if (!sorted.length) throw new Error('L0 durable copy requires at least one vector');
    const dims = Number(sorted[0]?.dims) || Number(sorted[0]?.vector?.length) || 0;
    if (!dims) throw new Error('L0 durable copy requires vector dimensions');
    const rDims = sorted.reduce((max, row) => Math.max(max, Number(row?.rDims) || 0), 0);

    const bytes = zipSync({
        'manifest.json': strToU8(JSON.stringify({
            format: PACKAGE_FORMAT,
            version: PACKAGE_VERSION,
            dims,
            rDims,
            count: sorted.length,
            fingerprint: String(fingerprint || ''),
        })),
        'state_vectors.jsonl': strToU8(sorted.map(row => JSON.stringify({
            atomId: row.atomId,
            floor: row.floor,
            hasRVector: (Number(row.rDims) || 0) > 0,
            rDims: Number(row.rDims) || 0,
        })).join('\n')),
        'state_vectors.bin': float32ToBytes(sorted.map(row => row.vector), dims),
        'state_r_vectors.bin': rDims ? float32ToBytes(sorted.map(row => row.rVector), rDims) : new Uint8Array(0),
    }, { level: 1 });

    return { bytes, dims, rDims, count: sorted.length };
}

export function unpackL0Package(bytes) {
    const unzipped = unzipSync(bytes);
    for (const name of ['manifest.json', 'state_vectors.jsonl', 'state_vectors.bin']) {
        if (!unzipped[name]) throw new Error(`L0 durable copy is missing ${name}`);
    }
    const meta = JSON.parse(strFromU8(unzipped['manifest.json']));
    if (meta?.format !== PACKAGE_FORMAT || Number(meta?.version) !== PACKAGE_VERSION) {
        throw new Error('L0 durable copy has an unsupported format');
    }
    const dims = Number(meta.dims);
    const rDims = Number(meta.rDims) || 0;
    if (!Number.isInteger(dims) || dims <= 0) throw new Error('L0 durable copy has invalid dimensions');

    const lines = strFromU8(unzipped['state_vectors.jsonl']).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const vectors = bytesToFloat32(unzipped['state_vectors.bin'], dims);
    const rVectors = (rDims && unzipped['state_r_vectors.bin']?.byteLength)
        ? bytesToFloat32(unzipped['state_r_vectors.bin'], rDims)
        : [];
    if (lines.length !== vectors.length || lines.length !== Number(meta.count)) {
        throw new Error('L0 durable copy vector count mismatch');
    }

    return {
        meta: { ...meta, dims, rDims, count: lines.length },
        rows: lines.map((line, index) => ({
            atomId: line.atomId,
            floor: line.floor,
            dims,
            rDims: line.hasRVector ? rDims : 0,
            vector: vectors[index],
            rVector: line.hasRVector ? (rVectors[index] || null) : null,
        })),
    };
}

/**
 * 写入完整 L0 向量集并读回校验。任一步失败抛错，由调用方保留待写状态重试。
 */
export async function writeL0DurableCopy(chatId, rows, { fingerprint = '' } = {}) {
    const store = requireStore();
    const keys = await getDurableKeys(chatId);
    const { bytes, dims, rDims, count } = packL0Package(rows, { fingerprint });

    const blobOptions = { namespace: NAMESPACE, table: TABLE, key: keys.l0Key };
    await store.setBlob({ ...blobOptions, data: bytes });
    const readBack = new Uint8Array(await (await store.getBlob(blobOptions)).arrayBuffer());
    if (readBack.byteLength !== bytes.byteLength) {
        throw new Error('L0 durable copy read-back size mismatch');
    }
    const digest = await sha256Hex(readBack);
    if (digest !== await sha256Hex(bytes)) {
        throw new Error('L0 durable copy read-back digest mismatch');
    }

    const manifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        l0: {
            key: keys.l0Key,
            count,
            dims,
            rDims,
            fingerprint: String(fingerprint || ''),
            bytes: bytes.byteLength,
            sha256: digest,
            committedAt: Date.now(),
        },
    };
    const manifestOptions = { namespace: NAMESPACE, table: TABLE, key: keys.manifestKey };
    await store.setJson({ ...manifestOptions, value: manifest });
    const stored = await store.tryGetJson(manifestOptions);
    if (!stored?.found || stored.value?.l0?.sha256 !== digest) {
        throw new Error('L0 durable copy manifest read-back verification failed');
    }
    xbLog.info(MODULE_ID, `L0 durable 副本已提交 count=${count} dims=${dims} bytes=${bytes.byteLength}`);
    return manifest;
}

/** 读取并校验 durable 副本；manifest 不存在返回 null，损坏直接抛错。 */
export async function readL0DurableCopy(chatId) {
    const store = requireStore();
    const keys = await getDurableKeys(chatId);
    const stored = await store.tryGetJson({ namespace: NAMESPACE, table: TABLE, key: keys.manifestKey });
    if (!stored?.found) return null;

    const manifest = stored.value;
    const entry = manifest?.l0;
    if (Number(manifest?.schemaVersion) !== MANIFEST_SCHEMA_VERSION || !entry?.key) {
        throw new Error('L0 durable copy manifest is invalid');
    }

    const bytes = new Uint8Array(await (await store.getBlob({
        namespace: NAMESPACE, table: TABLE, key: entry.key,
    })).arrayBuffer());
    if (Number(entry.bytes) !== bytes.byteLength) {
        throw new Error('L0 durable copy size mismatch');
    }
    if (await sha256Hex(bytes) !== entry.sha256) {
        throw new Error('L0 durable copy digest mismatch');
    }

    const { rows, meta } = unpackL0Package(bytes);
    if (meta.count !== Number(entry.count) || String(meta.fingerprint || '') !== String(entry.fingerprint || '')) {
        throw new Error('L0 durable copy metadata mismatch');
    }
    return { rows, manifest };
}

/** 清空副本；目标不存在按缺失处理，其它错误直接传播。 */
export async function deleteL0DurableCopy(chatId) {
    const store = requireStore();
    const keys = await getDurableKeys(chatId);
    const deleteOptions = { namespace: NAMESPACE, table: TABLE };
    try {
        await store.deleteBlob({ ...deleteOptions, key: keys.l0Key });
    } catch (error) {
        if (!isNotFoundError(error)) throw error;
    }
    try {
        await store.deleteJson({ ...deleteOptions, key: keys.manifestKey });
    } catch (error) {
        if (!isNotFoundError(error)) throw error;
    }
}
