// ═══════════════════════════════════════════════════════════════════════════
// Vector Import/Export
// 向量数据导入导出（当前 chatId 级别）
// ═══════════════════════════════════════════════════════════════════════════

import { packVectorPackage, openVectorPackage, parseVectorPackage } from './vector-package-codec.js';
import { uint8ToBase64, getBackupFilename, upsertManifestEntry } from './vector-backup-server.js';
export { fetchManifest, deleteServerBackup, isDeleteUnsupportedError, getBackupFilename } from './vector-backup-server.js';
import { getContext } from '../../../../../../extensions.js';
import { getRequestHeaders } from '../../../../../../../script.js';
import { xbLog } from '../../support/debug-core.js';
import {
    getMeta,
    updateMeta,
    getAllChunks,
    getAllChunkVectors,
    getAllEventVectors,
    saveChunks,
    saveChunkVectors,
    clearAllChunks,
    clearEventVectors,
    saveEventVectors,
} from './chunk-store.js';
import {
    getStateAtoms,
    saveStateAtoms,
    clearStateAtoms,
    getAllStateVectors,
    saveStateVectors,
    clearStateVectors,
} from './state-store.js';
import { getEngineFingerprint } from '../utils/embedder.js';
import { getVectorConfig } from '../../summary/data/config.js';
import { captureFrozenChatIdentity, assertChatTargetUnchanged } from './chat-target.js';
import { flushL12DurableCopy } from './l12-durable-copy.js';

const MODULE_ID = 'vector-io';

// ═══════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════════════════════

export async function exportVectors(onProgress) {
    const { chatId } = getContext();
    if (!chatId) {
        throw new Error('未打开聊天');
    }

    onProgress?.('读取数据...');

    const meta = await getMeta(chatId);
    const chunks = await getAllChunks(chatId);
    const chunkVectors = await getAllChunkVectors(chatId);
    const eventVectors = await getAllEventVectors(chatId);
    const stateAtoms = getStateAtoms();
    const stateVectors = await getAllStateVectors(chatId);

    const { zipData, chunkCount, eventCount } = packVectorPackage({
        chatId, meta, chunks, chunkVectors, eventVectors, stateAtoms, stateVectors,
    }, onProgress, '没有可导出的向量数据');

    onProgress?.('下载文件...');

    // 生成文件名
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const shortChatId = chatId.slice(0, 8);
    const filename = `vectors_${shortChatId}_${timestamp}.zip`;

    downloadBlob(new Blob([zipData]), filename);

    const sizeMB = (zipData.byteLength / 1024 / 1024).toFixed(2);
    xbLog.info(MODULE_ID, `导出完成: ${filename} (${sizeMB}MB)`);

    return {
        filename,
        size: zipData.byteLength,
        chunkCount,
        eventCount,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 导入
// ═══════════════════════════════════════════════════════════════════════════

function assertActiveChat(chatId) {
    if (!chatId || getContext()?.chatId !== chatId) {
        throw new Error('聊天已切换，已取消向量数据写入');
    }
}

function assertWriteActive(chatId, options = {}) {
    assertActiveChat(chatId);
    if (options.signal?.aborted || options.isCurrent?.() === false) {
        const error = options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error('向量写入代际已失效');
        error.name ||= 'AbortError';
        throw error;
    }
}

export async function importVectors(file, onProgress, options = {}) {
    const chatId = options.targetChatId || getContext()?.chatId;
    if (!chatId) {
        throw new Error('未打开聊天');
    }
    assertWriteActive(chatId, options);
    const target = captureFrozenChatIdentity(chatId);

    onProgress?.('读取文件...');

    const arrayBuffer = await file.arrayBuffer();
    assertWriteActive(chatId, options);
    const zipData = new Uint8Array(arrayBuffer);

    onProgress?.('解压文件...');

    return applyVectorPackage(zipData, chatId, target, onProgress, options, 'import');
}

// 两个入口在读取文件/网络之前冻结身份；此处不重新捕获，也不增加异步校验间隙。
async function applyVectorPackage(zipData, chatId, target, onProgress, options, operation) {
    const { unzipped, manifest } = openVectorPackage(zipData, operation === 'import'
        ? '文件格式错误，无法解压'
        : '备份文件格式错误，无法解压');

    onProgress?.('校验数据...');

    // 校验 fingerprint
    const vectorCfg = getVectorConfig();
    const currentFingerprint = vectorCfg ? getEngineFingerprint(vectorCfg) : '';
    const fingerprintMismatch = manifest.fingerprint && currentFingerprint && manifest.fingerprint !== currentFingerprint;

    // chatId 校验（警告但允许）
    const chatIdMismatch = manifest.chatId !== chatId;

    const warnings = [];
    if (fingerprintMismatch) {
        warnings.push(`向量引擎不匹配（文件: ${manifest.fingerprint}, 当前: ${currentFingerprint}），导入后需重新生成`);
    }
    if (chatIdMismatch) {
        warnings.push(`聊天ID不匹配（文件: ${manifest.chatId}, 当前: ${chatId}）`);
    }

    onProgress?.('解析数据...');

    const {
        chunkMetas, chunkVectors, eventMetas, eventVectors, stateAtoms,
        stateVectorMetas, stateVectors, stateRVectors, hasRVectorMeta,
    } = parseVectorPackage(unzipped, manifest);

    onProgress?.('清空旧数据...');

    // 清空当前数据属于不可回退的永久写入，先复验身份再动手。
    assertWriteActive(chatId, options);
    await assertChatTargetUnchanged(target, `vector ${operation} clear`);
    await updateMeta(chatId, { fingerprint: manifest.fingerprint, lastChunkFloor: -1 });
    assertWriteActive(chatId, options);
    await clearAllChunks(chatId);
    assertWriteActive(chatId, options);
    await clearEventVectors(chatId);
    assertWriteActive(chatId, options);
    await clearStateVectors(chatId);
    assertWriteActive(chatId, options);
    clearStateAtoms();

    onProgress?.('写入数据...');

    // 写入 chunks
    if (chunkMetas.length > 0) {
        const chunksToSave = chunkMetas.map(meta => ({
            chunkId: meta.chunkId,
            floor: meta.floor,
            chunkIdx: meta.chunkIdx,
            speaker: meta.speaker,
            isUser: meta.isUser,
            text: meta.text,
            textHash: meta.textHash,
        }));
        await saveChunks(chatId, chunksToSave);
        assertWriteActive(chatId, options);

        // 写入 chunk vectors
        const chunkVectorItems = chunkMetas.map((meta, idx) => ({
            chunkId: meta.chunkId,
            inputText: meta.text,
            vector: chunkVectors[idx],
        }));
        await saveChunkVectors(chatId, chunkVectorItems, manifest.fingerprint);
        assertWriteActive(chatId, options);
    }

    // 写入 event vectors
    if (eventMetas.length > 0) {
        const eventVectorItems = eventMetas.map((meta, idx) => ({
            eventId: meta.eventId,
            inputText: meta.inputText,
            vector: eventVectors[idx],
        }));
        await saveEventVectors(chatId, eventVectorItems, manifest.fingerprint);
        assertWriteActive(chatId, options);
    }

    // 写入 state atoms
    if (stateAtoms.length > 0) {
        assertWriteActive(chatId, options);
        saveStateAtoms(stateAtoms);
    }

    // Write state vectors (semantic + optional r-vector)
    if (stateVectorMetas.length > 0) {
        const stateVectorItems = stateVectorMetas.map((meta, idx) => ({
            atomId: meta.atomId,
            floor: meta.floor,
            vector: stateVectors[idx],
            rVector: (stateRVectors[idx] && (!hasRVectorMeta || meta.hasRVector)) ? stateRVectors[idx] : null,
        }));
        await saveStateVectors(chatId, stateVectorItems, manifest.fingerprint);
        assertWriteActive(chatId, options);
    }

    // 更新 meta
    assertWriteActive(chatId, options);
    await assertChatTargetUnchanged(target, `vector ${operation} commit`);
    await updateMeta(chatId, {
        fingerprint: manifest.fingerprint,
        lastChunkFloor: manifest.lastChunkFloor,
    });
    assertWriteActive(chatId, options);

    await flushL12DurableCopy(chatId);
    const completed = operation === 'import' ? '导入完成' : '从服务器恢复完成';
    xbLog.info(MODULE_ID, `${completed}: ${chunkMetas.length} chunks, ${eventMetas.length} events, ${stateAtoms.length} state atoms`);

    return {
        chunkCount: chunkMetas.length,
        eventCount: eventMetas.length,
        warnings,
        fingerprintMismatch,
    };
}
// ═══════════════════════════════════════════════════════════════════════════
// 备份到服务器
// ═══════════════════════════════════════════════════════════════════════════

export async function backupToServer(onProgress) {
    const { chatId } = getContext();
    if (!chatId) {
        throw new Error('未打开聊天');
    }

    onProgress?.('读取数据...');

    const meta = await getMeta(chatId);
    const chunks = await getAllChunks(chatId);
    const chunkVectors = await getAllChunkVectors(chatId);
    const eventVectors = await getAllEventVectors(chatId);
    const stateAtoms = getStateAtoms();
    const stateVectors = await getAllStateVectors(chatId);

    const { zipData, chunkCount, eventCount } = packVectorPackage({
        chatId, meta, chunks, chunkVectors, eventVectors, stateAtoms, stateVectors,
    }, onProgress, '没有可备份的向量数据');

    onProgress?.('上传到服务器...');

    const base64 = uint8ToBase64(zipData);
    const filename = getBackupFilename(chatId);

    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: filename, data: base64 }),
    });
    if (!res.ok) {
        throw new Error(`服务器返回 ${res.status}`);
    }

    // 新增：安全读取 path 字段
    let uploadedPath = null;
    try {
        const resJson = await res.json();
        if (typeof resJson?.path === 'string') uploadedPath = resJson.path;
    } catch (_) { /* JSON 解析失败时 uploadedPath 保持 null */ }

    // 新增：写清单（独立 try/catch，失败不影响原有备份返回）
    try {
        await upsertManifestEntry({
            filename,
            serverPath: uploadedPath,
            size: zipData.byteLength,
            chatId,
            backupTime: new Date().toISOString(),
        });
    } catch (e) {
        xbLog.warn(MODULE_ID, `清单写入失败（不影响备份结果）: ${e.message}`);
    }

    const sizeMB = (zipData.byteLength / 1024 / 1024).toFixed(2);
    xbLog.info(MODULE_ID, `备份完成: ${filename} (${sizeMB}MB)`);

    return {
        filename,
        size: zipData.byteLength,
        chunkCount,
        eventCount,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 从服务器恢复
// ═══════════════════════════════════════════════════════════════════════════

export async function restoreFromServer(onProgress, options = {}) {
    const chatId = options.targetChatId || getContext()?.chatId;
    if (!chatId) {
        throw new Error('未打开聊天');
    }
    assertWriteActive(chatId, options);
    const target = captureFrozenChatIdentity(chatId);

    onProgress?.('从服务器下载...');

    const filename = getBackupFilename(chatId);
    const res = await fetch(`/user/files/${filename}`, {
        headers: getRequestHeaders(),
        cache: 'no-cache',
        signal: options.signal,
    });

    if (!res.ok) {
        if (res.status === 404) {
            throw new Error('服务器上没有找到此聊天的备份');
        }
        throw new Error(`服务器返回 ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    assertWriteActive(chatId, options);
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        throw new Error('服务器上没有找到此聊天的备份');
    }

    onProgress?.('解压文件...');

    const zipData = new Uint8Array(arrayBuffer);

    return applyVectorPackage(zipData, chatId, target, onProgress, options, 'restore');
}
