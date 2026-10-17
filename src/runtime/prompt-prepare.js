// Read-only prompt preparation. Publication, cancellation ownership and reuse adoption
// remain with the runtime caller.
import { getContext } from '../../../../../extensions.js';
import { extension_prompt_roles } from '../../../../../../script.js';
import { xbLog } from '../support/debug-core.js';
import { getVectorConfig, getSummaryPanelConfig } from '../summary/data/config.js';
import { getSummaryStore } from '../summary/data/store.js';
import { buildVectorPromptText, buildNonVectorPromptText } from '../summary/generate/prompt.js';
import { preload as preloadTokenizer, isReady as isTokenizerReady } from '../vector/utils/tokenizer.js';
import { getMeta } from '../vector/storage/chunk-store.js';
import { createRecallDiagnostics, recordRecallFallback } from './recall-diagnostics.js';

const MODULE_ID = 'storySummary';
const MIN_INJECTION_DEPTH = 2;
const ROLE_MAP = {
    system: extension_prompt_roles.SYSTEM,
    user: extension_prompt_roles.USER,
    assistant: extension_prompt_roles.ASSISTANT,
};

/**
 * Prepare one memory prompt without publishing any observable result. This is
 * safe to start immediately after the host pushes the real USER object while
 * save/render continue in parallel. The caller owns the existing reuse instance.
 */
export async function prepareMemoryPrompt(type, signal, recallReuse, diagnostics = createRecallDiagnostics(getContext()?.chatId, type)) {
    const T0 = performance.now();
    let preparedChatId = null;
    let reuseTicket = null;
    const timing = {
        tokenizer: 0,
        boundary: 0,
        buildPrompt: 0,
    };
    const finish = (reason, result = {}) => {
        const total = Math.round(performance.now() - T0);
        diagnostics.finishedAt ??= performance.now();
        if (!diagnostics.reason && reason !== 'prepared') diagnostics.reason = reason;
        xbLog.info(
            MODULE_ID,
            `Prompt prepare timing: type=${type || 'unknown'} reason=${reason} total=${total}ms `
            + `tokenizer=${timing.tokenizer}ms boundary=${timing.boundary}ms `
            + `build=${timing.buildPrompt}ms`
        );
        return {
            text: '',
            diagnostics,
            notice: null,
            chatId: preparedChatId,
            depth: null,
            role: null,
            boundary: -1,
            reuseTicket,
            timing: { ...timing, total },
            skipReason: reason,
            ...result,
        };
    };

    if (signal?.aborted) return finish('aborted_before_prepare');

    const context = getContext();
    const { chat, chatId } = context;
    preparedChatId = chatId || null;
    const chatLen = Array.isArray(chat) ? chat.length : 0;
    const reuse = recallReuse.prepare(context, type);
    reuseTicket = reuse.ticket;
    if (reuse.memory) {
        diagnostics.stage = 'reuse';
        const { text, boundary, role } = reuse.memory;
        return finish('reused', {
            text, boundary, role,
            depth: Math.max(MIN_INJECTION_DEPTH, chatLen - boundary - 1),
            reuseMemory: reuse.memory,
        });
    }
    if (chatLen === 0) return finish('empty_chat');

    // Single-chat regenerate has already removed the old answer in the host.
    const excludeLastAi = type === 'swipe';
    const vectorCfg = getVectorConfig();

    // ★ 最后一道关卡：向量启用时，同步等待分词器就绪
    if (vectorCfg?.enabled && !isTokenizerReady()) {
        diagnostics.stage = 'tokenizer';
        const T_Tokenizer = performance.now();
        try {
            await preloadTokenizer();
        } catch (e) {
            xbLog.warn(MODULE_ID, "生成前分词器预热失败，将使用降级分词", e);
            recordRecallFallback(diagnostics, 'tokenizer', e);
        } finally {
            timing.tokenizer = Math.round(performance.now() - T_Tokenizer);
        }
    }
    if (signal?.aborted) return finish('aborted_after_tokenizer');

    const store = getSummaryStore();

    // 确定注入边界
    // - 向量开：meta.lastChunkFloor（若无则回退 lastSummarizedMesId）
    // - 向量关：lastSummarizedMesId
    let boundary = -1;
    const T_Boundary = performance.now();
    diagnostics.stage = 'source-boundary';
    if (vectorCfg?.enabled) {
        const meta = chatId ? await getMeta(chatId) : null;
        if (signal?.aborted) return finish('aborted_after_boundary_read');
        boundary = meta?.lastChunkFloor ?? -1;
        if (boundary < 0) boundary = store?.lastSummarizedMesId ?? -1;
    } else {
        boundary = store?.lastSummarizedMesId ?? -1;
    }
    // A restored/imported canonical summary has no floor vectors yet; inject it directly
    // until the next successful summary establishes a real floor boundary.
    const usePendingCanonicalSummary = boundary < 0 && store?.pendingImportBoundary && store?.json;
    if (usePendingCanonicalSummary) {
        boundary = chatLen - 1;
    }
    timing.boundary = Math.round(performance.now() - T_Boundary);
    if (boundary < 0) {
        return finish('no_boundary');
    }

    // 计算深度：倒序插入，从末尾往前数
    // 最小为 MIN_INJECTION_DEPTH，避免插入太靠近底部
    const depth = Math.max(MIN_INJECTION_DEPTH, chatLen - boundary - 1);
    if (depth < 0) {
        return finish('invalid_depth');
    }

    // 构建注入文本
    let text = "";
    let notice = null;
    const T_BuildPrompt = performance.now();
    if (vectorCfg?.enabled && !usePendingCanonicalSummary) {
        const r = await buildVectorPromptText(excludeLastAi, {
            signal,
            diagnostics,
        });
        if (signal?.aborted) {
            return finish('aborted_after_build');
        }
        text = r?.text || "";
        notice = r?.notice || null;
    } else {
        diagnostics.stage = 'canonical-summary';
        text = buildNonVectorPromptText() || "";
    }
    timing.buildPrompt = Math.round(performance.now() - T_BuildPrompt);

    // 获取用户配置的 role
    const cfg = getSummaryPanelConfig();
    const roleKey = cfg.trigger?.role || 'system';
    const role = ROLE_MAP[roleKey] || extension_prompt_roles.SYSTEM;

    return finish(text.trim() ? 'prepared' : 'empty_prompt', {
        text,
        notice,
        depth,
        role,
        boundary,
    });
}
