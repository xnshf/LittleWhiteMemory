// ═══════════════════════════════════════════════════════════════════════════
// Chat Target Identity
// 长异步写入前捕获目标聊天身份，永久写入前复验。
// ChatRef 区分角色/群聊与具体聊天文件；stableId 区分同一路径下的不同聊天身份。
// ═══════════════════════════════════════════════════════════════════════════

export function getChatRefKey(ref) {
    if (ref?.kind === 'character' && ref.characterId && ref.fileName) {
        return `character\0${ref.characterId}\0${ref.fileName}`;
    }
    if (ref?.kind === 'group' && ref.chatId) {
        return `group\0${ref.chatId}`;
    }
    throw new Error('TauriTavern returned an invalid current ChatRef');
}

function requireChatApi() {
    const chatApi = globalThis.window?.__TAURITAVERN__?.api?.chat;
    if (typeof chatApi?.current?.ref !== 'function' || typeof chatApi?.current?.handle !== 'function') {
        throw new Error('TauriTavern api.chat.current is unavailable');
    }
    return chatApi;
}

function normalizeChatId(value) {
    return String(value || '').replace(/\.jsonl$/i, '');
}

/**
 * 捕获当前聊天目标：同步快照 ChatRef 键与 handle，不发起任何读取。
 * 只能在目标聊天仍是当前聊天时调用；传入 expectedChatId 时校验 ChatRef 确实指向该聊天。
 */
export function captureChatTarget(expectedChatId = null) {
    const chatApi = requireChatApi();
    const handle = chatApi.current.handle();
    const refKey = getChatRefKey(handle?.ref);
    if (typeof handle?.stableId !== 'function') {
        throw new Error('TauriTavern ChatHandle.stableId is unavailable');
    }
    if (expectedChatId != null) {
        const refChatId = handle.ref.kind === 'group' ? handle.ref.chatId : handle.ref.fileName;
        if (normalizeChatId(refChatId) !== normalizeChatId(expectedChatId)) {
            throw new Error('Chat target does not match the current chat');
        }
    }

    return {
        refKey,
        handle,
        readStableId: () => handle.stableId(),
    };
}

/**
 * 捕获并冻结身份：额外读取一次 stableId 作为复验基准。
 * 读取失败保留为错误值，复验时原样抛出。
 */
export function captureFrozenChatIdentity(expectedChatId = null) {
    const target = captureChatTarget(expectedChatId);
    return Object.assign(target, {
        stableId: Promise.resolve()
            .then(() => target.readStableId())
            .then(value => ({ value }), error => ({ error })),
    });
}

/** 同步检查当前聊天是否仍是目标（ChatRef 级别）。无有效聊天时返回 false。 */
export function isChatTargetCurrent(target) {
    if (!target?.refKey) return false;
    try {
        return getChatRefKey(requireChatApi().current.ref()) === target.refKey;
    } catch {
        return false;
    }
}

/** 复验 ChatRef 与冻结的 stableId。身份读取失败按未通过处理，不伪装成匹配。 */
export async function isChatTargetUnchanged(target) {
    if (!target?.stableId) throw new Error('Chat identity was not frozen before verification');
    if (!isChatTargetCurrent(target)) return false;
    const frozen = await target.stableId;
    if (frozen?.error) throw frozen.error;
    return await requireChatApi().current.handle().stableId() === frozen.value;
}

/** 永久写入前调用。身份变化时抛错，调用方必须停止写入并向上传播。 */
export async function assertChatTargetUnchanged(target, action = 'permanent write') {
    if (!await isChatTargetUnchanged(target)) {
        throw new Error(`Chat identity changed before ${action}`);
    }
}
