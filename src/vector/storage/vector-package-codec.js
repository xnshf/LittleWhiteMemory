// ZIP 格式与数量校验；不读取当前聊天或执行持久写入。
import { zipSync, unzipSync, strToU8, strFromU8 } from '../../../libs/fflate.mjs';
import { assertVectorPackageChunkCounts, orderCompleteChunkVectors } from './vector-package-policy.js';

const EXPORT_VERSION = 2;

function assertEventInputs(events) {
    if (events.some(event => event.inputText !== undefined
        && (typeof event.inputText !== 'string' || !event.inputText.trim()))) {
        throw new Error('事件向量 inputText 无效');
    }
}

function float32ToBytes(vectors, dims) {
    const totalFloats = vectors.length * dims;
    const buffer = new ArrayBuffer(totalFloats * 4);
    const view = new Float32Array(buffer);

    let offset = 0;
    for (const vec of vectors) {
        for (let i = 0; i < dims; i++) {
            view[offset++] = vec[i] || 0;
        }
    }

    return new Uint8Array(buffer);
}

function bytesToFloat32(bytes, dims) {
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const vectors = [];

    for (let i = 0; i < view.length; i += dims) {
        vectors.push(Array.from(view.slice(i, i + dims)));
    }

    return vectors;
}

export function packVectorPackage({ chatId, meta, chunks, chunkVectors, eventVectors, stateAtoms, stateVectors }, onProgress, emptyMessage) {
    if (chunkVectors.length === 0 && eventVectors.length === 0 && stateVectors.length === 0) {
        throw new Error(emptyMessage);
    }

    const dims = chunkVectors[0]?.vector?.length
        || eventVectors[0]?.vector?.length
        || stateVectors[0]?.vector?.length
        || 0;
    if (dims === 0) {
        throw new Error('无法确定向量维度');
    }

    onProgress?.('构建索引...');

    const sortedChunks = [...chunks].sort((a, b) => a.chunkId.localeCompare(b.chunkId));
    const chunkVectorsOrdered = orderCompleteChunkVectors(sortedChunks, chunkVectors);
    const chunksJsonl = sortedChunks.map(c => JSON.stringify({
        chunkId: c.chunkId,
        floor: c.floor,
        chunkIdx: c.chunkIdx,
        speaker: c.speaker,
        isUser: c.isUser,
        text: c.text,
        textHash: c.textHash,
    })).join('\n');

    onProgress?.('压缩向量...');

    assertEventInputs(eventVectors);
    const sortedEventVectors = [...eventVectors].sort((a, b) => a.eventId.localeCompare(b.eventId));
    const eventsJsonl = sortedEventVectors.map(ev => JSON.stringify({
        eventId: ev.eventId,
        inputText: ev.inputText,
    })).join('\n');
    const eventVectorsOrdered = sortedEventVectors.map(ev => ev.vector);

    const sortedStateVectors = [...stateVectors].sort((a, b) => String(a.atomId).localeCompare(String(b.atomId)));
    const stateVectorsOrdered = sortedStateVectors.map(v => v.vector);
    const rDims = sortedStateVectors.find(v => v.rVector?.length)?.rVector?.length || dims;
    const stateRVectorsOrdered = sortedStateVectors.map(v =>
        v.rVector?.length ? v.rVector : new Array(rDims).fill(0)
    );
    const stateVectorsJsonl = sortedStateVectors.map(v => JSON.stringify({
        atomId: v.atomId,
        floor: v.floor,
        hasRVector: !!(v.rVector?.length),
        rDims: v.rVector?.length || 0,
    })).join('\n');

    const manifest = {
        version: EXPORT_VERSION,
        exportedAt: Date.now(),
        chatId,
        fingerprint: meta.fingerprint || '',
        dims,
        chunkCount: sortedChunks.length,
        chunkVectorCount: chunkVectors.length,
        eventCount: sortedEventVectors.length,
        stateAtomCount: stateAtoms.length,
        stateVectorCount: stateVectors.length,
        stateRVectorCount: sortedStateVectors.filter(v => v.rVector?.length).length,
        rDims,
        lastChunkFloor: meta.lastChunkFloor ?? -1,
    };

    onProgress?.('打包文件...');

    const zipData = zipSync({
        'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
        'chunks.jsonl': strToU8(chunksJsonl),
        'chunk_vectors.bin': float32ToBytes(chunkVectorsOrdered, dims),
        'events.jsonl': strToU8(eventsJsonl),
        'event_vectors.bin': float32ToBytes(eventVectorsOrdered, dims),
        'state_atoms.json': strToU8(JSON.stringify(stateAtoms)),
        'state_vectors.jsonl': strToU8(stateVectorsJsonl),
        'state_vectors.bin': stateVectorsOrdered.length
            ? float32ToBytes(stateVectorsOrdered, dims)
            : new Uint8Array(0),
        'state_r_vectors.bin': stateRVectorsOrdered.length
            ? float32ToBytes(stateRVectorsOrdered, rDims)
            : new Uint8Array(0),
    }, { level: 1 });

    return { zipData, chunkCount: sortedChunks.length, eventCount: sortedEventVectors.length };
}

// 与数据解析分开，以保留 manifest 校验、配置读取、进度回调的原有顺序。
export function openVectorPackage(zipData, unzipErrorMessage) {
    let unzipped;
    try {
        unzipped = unzipSync(zipData);
    } catch (e) {
        throw new Error(unzipErrorMessage);
    }
    if (!unzipped['manifest.json']) {
        throw new Error('缺少 manifest.json');
    }
    const manifest = JSON.parse(strFromU8(unzipped['manifest.json']));
    if (![1, 2].includes(manifest.version)) {
        throw new Error(`不支持的版本: ${manifest.version}`);
    }
    return { unzipped, manifest };
}

export function parseVectorPackage(unzipped, manifest) {
    const chunksJsonl = unzipped['chunks.jsonl'] ? strFromU8(unzipped['chunks.jsonl']) : '';
    const chunkMetas = chunksJsonl.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const chunkVectorsBytes = unzipped['chunk_vectors.bin'];
    const chunkVectors = chunkVectorsBytes ? bytesToFloat32(chunkVectorsBytes, manifest.dims) : [];

    const eventsJsonl = unzipped['events.jsonl'] ? strFromU8(unzipped['events.jsonl']) : '';
    const eventMetas = eventsJsonl.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assertEventInputs(eventMetas);
    const eventVectorsBytes = unzipped['event_vectors.bin'];
    const eventVectors = eventVectorsBytes ? bytesToFloat32(eventVectorsBytes, manifest.dims) : [];

    const stateAtoms = unzipped['state_atoms.json']
        ? JSON.parse(strFromU8(unzipped['state_atoms.json']))
        : [];
    const stateVectorsJsonl = unzipped['state_vectors.jsonl'] ? strFromU8(unzipped['state_vectors.jsonl']) : '';
    const stateVectorMetas = stateVectorsJsonl.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const stateVectorsBytes = unzipped['state_vectors.bin'];
    const stateVectors = (stateVectorsBytes && stateVectorMetas.length)
        ? bytesToFloat32(stateVectorsBytes, manifest.dims)
        : [];
    const stateRVectorsBytes = unzipped['state_r_vectors.bin'];
    const stateRVectors = (stateRVectorsBytes && stateVectorMetas.length)
        ? bytesToFloat32(stateRVectorsBytes, manifest.rDims || manifest.dims)
        : [];
    const hasRVectorMeta = stateVectorMetas.some(m => typeof m.hasRVector === 'boolean');

    assertVectorPackageChunkCounts(manifest, chunkMetas.length, chunkVectors.length);
    if (chunkMetas.length !== chunkVectors.length) {
        throw new Error(`chunk 数量不匹配: 元数据 ${chunkMetas.length}, 向量 ${chunkVectors.length}`);
    }
    if (eventMetas.length !== eventVectors.length) {
        throw new Error(`event 数量不匹配: 元数据 ${eventMetas.length}, 向量 ${eventVectors.length}`);
    }
    if (stateVectorMetas.length !== stateVectors.length) {
        throw new Error(`state 向量数量不匹配: 元数据 ${stateVectorMetas.length}, 向量 ${stateVectors.length}`);
    }
    if (stateRVectors.length > 0 && stateVectorMetas.length !== stateRVectors.length) {
        throw new Error(`state r-vector count mismatch: meta=${stateVectorMetas.length}, vectors=${stateRVectors.length}`);
    }

    return { chunkMetas, chunkVectors, eventMetas, eventVectors, stateAtoms, stateVectorMetas, stateVectors, stateRVectors, hasRVectorMeta };
}
