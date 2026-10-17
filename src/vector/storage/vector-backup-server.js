// 服务器备份命名、清单与删除；保留既有宽容读取和部分成功语义。
import { getRequestHeaders } from '../../../../../../../script.js';

// 二进制 Uint8Array → base64（分块处理，避免 btoa 栈溢出）
export function uint8ToBase64(uint8) {
    const CHUNK = 0x8000;
    let result = '';
    for (let i = 0; i < uint8.length; i += CHUNK) {
        result += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
    }
    return btoa(result);
}

// 服务器备份文件名
export function getBackupFilename(chatId) {
    // chatId 可能含中文/特殊字符，ST 只接受 [a-zA-Z0-9_-]
    // 用简单 hash 生成安全文件名
    let hash = 0;
    for (let i = 0; i < chatId.length; i++) {
        hash = ((hash << 5) - hash + chatId.charCodeAt(i)) | 0;
    }
    const safe = (hash >>> 0).toString(36);
    return `LittleWhiteMemory_VectorBackup_${safe}.zip`;
}

const BACKUP_MANIFEST = 'LittleWhiteMemory_BackupManifest.json';

// 宽容解析：非数组/JSON 失败/字段异常时清洗，不抛错
export async function fetchManifest() {
    try {
        const res = await fetch(`/user/files/${BACKUP_MANIFEST}`, {
            headers: getRequestHeaders(),
            cache: 'no-cache',
        });
        if (!res.ok) return [];
        const raw = await res.json();
        if (!Array.isArray(raw)) return [];
        return raw.map(normalizeManifestEntry).filter(Boolean);
    } catch (_) {
        return [];
    }
}

// 标准化单条条目字段，非法 filename 直接丢弃，其余字段降级
function normalizeManifestEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const filename = typeof raw.filename === 'string' ? raw.filename : null;
    if (!filename || !/^LittleWhiteMemory_VectorBackup_[a-z0-9]+\.zip$/.test(filename)) return null;
    const rawPath = typeof raw.serverPath === 'string' ? raw.serverPath.replace(/^\/+/, '') : null;
    return {
        filename,
        serverPath: rawPath,
        size: typeof raw.size === 'number' ? raw.size : null,
        chatId: typeof raw.chatId === 'string' ? raw.chatId : null,
        backupTime: typeof raw.backupTime === 'string' ? raw.backupTime : null,
    };
}

// 安全推导/校验 serverPath：缺失时推导，与 filename 不一致时拒绝
function buildSafeServerPath(filename, serverPath) {
    const expected = `user/files/${filename}`;
    if (!serverPath) return expected;
    const normalized = serverPath.replace(/^\/+/, '');
    if (normalized !== expected) {
        throw new Error(`serverPath 不安全: ${serverPath}`);
    }
    return normalized;
}

// 读-改(upsert by filename)-写回-验证，失败最多重试 2 次
export async function upsertManifestEntry({ filename, serverPath, size, chatId, backupTime }) {
    if (typeof serverPath === 'string') serverPath = serverPath.replace(/^\/+/, '');
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // 读取现有清单
        const existing = await fetchManifest();

        // upsert by filename
        const idx = existing.findIndex(e => e.filename === filename);
        const entry = { filename, serverPath, size, chatId, backupTime };
        if (idx >= 0) {
            existing[idx] = entry;
        } else {
            existing.push(entry);
        }

        // 上传清单
        const json = JSON.stringify(existing, null, 2);
        const base64 = uint8ToBase64(new TextEncoder().encode(json));
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: BACKUP_MANIFEST, data: base64 }),
        });
        if (!res.ok) throw new Error(`清单上传失败: ${res.status}`);

        // 写后立即重读验证
        const verified = await fetchManifest();
        if (verified.some(e => e.filename === filename)) return;

        // 最后一次仍失败才抛出
        if (attempt === MAX_RETRIES - 1) {
            throw new Error('清单写入后验证失败，重试已耗尽');
        }
    }
}

// 删除前校验 + POST /api/files/delete + 更新清单
export async function deleteServerBackup(filename, serverPath) {
    // 安全校验
    if (!/^LittleWhiteMemory_VectorBackup_[a-z0-9]+\.zip$/.test(filename)) {
        throw new Error(`非法文件名: ${filename}`);
    }
    const safePath = buildSafeServerPath(filename, serverPath || null);

    // 物理删除
    const res = await fetch('/api/files/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ path: safePath }),
    });
    if (!res.ok) {
        const err = new Error(`删除失败: ${res.status}`);
        err.status = res.status;
        err.method = 'DELETE';
        throw err;
    }

    // 更新清单（删除条目）
    try {
        const existing = await fetchManifest();
        const filtered = existing.filter(e => e.filename !== filename);
        const json = JSON.stringify(filtered, null, 2);
        const base64 = uint8ToBase64(new TextEncoder().encode(json));
        const upRes = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: BACKUP_MANIFEST, data: base64 }),
        });
        if (!upRes.ok) {
            throw new Error('zip 已删除，但清单更新失败，请手动刷新');
        }
    } catch (e) {
        // zip 删成功但清单更新失败 → 抛"部分成功"错误
        const partialErr = new Error(e.message || 'zip 已删除，清单同步失败');
        partialErr.partial = true;
        throw partialErr;
    }
}

// 集中判断 404/405/method not allowed/unsupported
export function isDeleteUnsupportedError(err) {
    if (!err) return false;
    const status = err.status;
    if (status === 404 || status === 405) return true;
    const msg = String(err.message || '').toLowerCase();
    return msg.includes('method not allowed') || msg.includes('unsupported') || msg.includes('not found');
}
