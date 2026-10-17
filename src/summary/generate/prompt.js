// ═══════════════════════════════════════════════════════════════════════════
// Story Summary - Prompt Injection (v7 - L0 scene-based display)
//
// 命名规范：
// - 存储层用 L0/L1/L2/L3（StateAtom/Chunk/Event/Fact）
// - 装配层用语义名称：constraint/event/evidence/arc
//
// 架构变更（v5 → v6）：
// - 同楼层多个 L0 共享一对 L1（EvidenceGroup per-floor）
// - L0 展示文本直接使用 semantic 字段（v7: 场景摘要，纯自然语言）
// - 仅负责"构建注入文本"，不负责写入 extension_prompts
// - 注入发生在 story-summary.js：generate_interceptor 时写入 extension_prompts
// ═══════════════════════════════════════════════════════════════════════════

import { getContext } from "../../../../../../extensions.js";
import { xbLog } from "../../support/debug-core.js";
import { getSummaryStore, getFacts } from "../data/store.js";
import { getVectorConfig, getSummaryPanelConfig, getSettings } from "../data/config.js";
import {
    hydrateSelectedDirectEvidence,
    recallMemory,
    releaseDirectEvidenceContext,
} from "../../vector/retrieval/recall.js";
import { getMeta } from "../../vector/storage/chunk-store.js";
import { getStateAtoms } from "../../vector/storage/state-store.js";
import { getEngineFingerprint } from "../../vector/utils/embedder.js";
import { filterConstraintsByRelevance } from "./constraint-filter.js";
import {
    getTemporalProtectionLimit,
    TEMPORAL_PROTECTION_POLICY,
} from "../../vector/retrieval/temporal-turn-carrier.js";
import {
    pushWithBudget, cleanSummary, normalize, buildMemoryPromptText,
    formatConstraintsStructured, formatArcLine, groupL0ByFloor,
    buildEvidenceGroup, buildRecentEvidenceGroup, formatEvidenceGroup,
} from "./prompt-format.js";
import {
    CONSTRAINT_MAX, getKnownCharacters, buildConstraintPeopleDict,
    groupConstraintsForDisplay, assembleVectorConstraints,
} from "./prompt-constraints.js";
import {
    EVENT_BUDGET_MAX, selectPromptEvents, assembleEventEvidence, renderPromptEvents,
    markEvidenceGroupUsed, unusedL1PairChunks,
} from "./prompt-event-assembly.js";
import { createEvidenceTraceRecorder } from "./prompt-evidence-trace.js";

// Metrics
import { detectIssues, finalizeMetricsTiming } from "../../vector/retrieval/metrics.js";
import { createRecallDiagnostics } from '../../runtime/recall-diagnostics.js';

const MODULE_ID = "summaryPrompt";

// ─────────────────────────────────────────────────────────────────────────────
// 预算常量
// ─────────────────────────────────────────────────────────────────────────────

const ARCS_MAX = 1500;
const EVENT_EVIDENCE_MAX = 4000;
const DISTANT_EVIDENCE_MAX = 1000;
const UNSUMMARIZED_EVIDENCE_MAX = 2000;
const TOTAL_BUDGET_MAX = CONSTRAINT_MAX + ARCS_MAX + EVENT_BUDGET_MAX
    + EVENT_EVIDENCE_MAX + DISTANT_EVIDENCE_MAX + UNSUMMARIZED_EVIDENCE_MAX;

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 收集 L0 的实体集合（用于背景证据实体过滤）
 * 使用 edges.s/edges.t。
 * @param {object} l0
 * @returns {Set<string>}
 */
function collectL0Entities(l0) {
    const atom = l0?.atom || {};
    const set = new Set();

    const add = (v) => {
        const n = normalize(v);
        if (n) set.add(n);
    };

    for (const e of (atom.edges || [])) {
        add(e?.s);
        add(e?.t);
    }

    return set;
}

/**
 * 背景证据是否保留（按焦点实体过滤）
 * 规则：
 * 1) 无焦点实体：保留，由语义相关性决定准入
 * 2) edges 或文本命中焦点实体：保留
 * 否则过滤。
 * @param {object} l0
 * @param {Set<string>} focusSet
 * @returns {boolean}
 */
function shouldKeepEvidenceL0(l0, focusSet) {
    if (!focusSet?.size) return true;

    const entities = collectL0Entities(l0);
    for (const f of focusSet) {
        if (entities.has(f)) return true;
    }

    // 兼容旧数据：semantic 文本包含焦点实体
    const textNorm = normalize(l0?.atom?.semantic || l0?.text || '');
    for (const f of focusSet) {
        if (f && textNorm.includes(f)) return true;
    }
    return false;
}

/**
 * Get all available L0 atoms in recent window and normalize to evidence shape.
 * @param {number} recentStart
 * @param {number} recentEnd
 * @returns {object[]}
 */
function getRecentWindowL0Atoms(recentStart, recentEnd) {
    if (!Number.isFinite(recentStart) || !Number.isFinite(recentEnd) || recentEnd < recentStart) return [];
    const atoms = getStateAtoms() || [];
    const out = [];
    for (const atom of atoms) {
        const floor = atom?.floor;
        const atomId = atom?.atomId;
        const semantic = String(atom?.semantic || '').trim();
        if (!Number.isFinite(floor)) continue;
        if (floor < recentStart || floor > recentEnd) continue;
        if (!atomId || !semantic) continue;
        out.push({
            id: atomId,
            floor,
            atom,
            similarity: 0,
            rerankScore: 0,
        });
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 非向量模式
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构建非向量模式注入文本
 * @param {object} store - 存储对象
 * @returns {string} 注入文本
 */
function buildNonVectorPrompt(store) {
    const data = store.json || {};
    const sections = [];

    // [Constraints] L3 Facts (structured: people/world)
    const allFacts = getFacts().filter(f => !f.retracted);
    const nonVectorPeopleDict = buildConstraintPeopleDict(
        { events: data.events || [] },
        []
    );
    const nonVectorFocus = nonVectorPeopleDict.size > 0
        ? [...nonVectorPeopleDict.values()]
        : [...getKnownCharacters(store)];
    const nonVectorKnownCharacters = getKnownCharacters(store);
    const filteredConstraints = filterConstraintsByRelevance(
        allFacts,
        nonVectorFocus,
        nonVectorKnownCharacters,
        getContext().name1,
    );
    const groupedConstraints = groupConstraintsForDisplay(filteredConstraints, nonVectorPeopleDict);
    const constraintLines = formatConstraintsStructured(groupedConstraints, 'asc');

    if (constraintLines.length) {
        sections.push(`[定了的事] 已确立的事实\n${constraintLines.join("\n")}`);
    }

    // [Events] L2 Events
    if (data.events?.length) {
        const lines = data.events.map((ev, i) => {
            const time = ev.timeLabel || "";
            const title = ev.title || "";
            const people = (ev.participants || []).join(" / ");
            const summary = cleanSummary(ev.summary);
            const header = time ? `${i + 1}.【${time}】${title || people}` : `${i + 1}. ${title || people}`;
            return `${header}\n  ${summary}`;
        });
        sections.push(`[剧情记忆]\n\n${lines.join("\n\n")}`);
    }

    // [Arcs]
    if (data.arcs?.length) {
        const lines = data.arcs.map(formatArcLine);
        sections.push(`[人物弧光]\n${lines.join("\n")}`);
    }

    if (!sections.length) return "";

    return buildMemoryPromptText(sections.join("\n\n"));
}

/**
 * 构建非向量模式注入文本（公开接口）
 * @returns {string} 注入文本
 */
export function buildNonVectorPromptText() {
    if (!getSettings().storySummary?.enabled) {
        return "";
    }

    const store = getSummaryStore();
    if (!store?.json) {
        return "";
    }

    let text = buildNonVectorPrompt(store);
    if (!text.trim()) {
        return "";
    }

    const cfg = getSummaryPanelConfig();
    if (cfg.trigger?.wrapperHead) text = cfg.trigger.wrapperHead + "\n" + text;
    if (cfg.trigger?.wrapperTail) text = text + "\n" + cfg.trigger.wrapperTail;

    return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// 向量模式：预算装配
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构建向量模式注入文本
 * @param {object} store - 存储对象
 * @param {object} recallResult - 召回结果
 * @param {Map<string, object>} causalById - 因果事件索引
 * @param {string[]} focusCharacters - 焦点人物
 * @param {object} meta - 元数据
 * @param {object} metrics - 指标对象
 * @param {{ captureEvidenceTrace?: boolean }} options - replay-only observation options
 * @returns {Promise<{promptText: string, injectionStats: object, metrics: object, evidenceTrace?: object}>}
 */
async function buildVectorPrompt(store, recallResult, causalById, focusCharacters, meta, metrics, options = {}) {
    const T_Start = performance.now();
    const recallElapsed = metrics?.timing.total || 0;
    const releaseElapsedBefore = metrics?.timing.runtimeEndSession || 0;
    let deferredDirectEvidenceContext = recallResult?.directEvidenceContext || null;
    try {

    const data = store.json || {};
    // Recalled events may themselves be another selected event's direct cause.
    // Keep them addressable even when recall excluded them from causalChain.
    causalById = new Map(causalById);
    for (const item of recallResult?.events || []) {
        if (item?.event?.id) causalById.set(item.event.id, item);
    }
    const eventEvidenceBudget = { used: 0, max: EVENT_EVIDENCE_MAX };
    const temporalEvidenceProtectionBudget = {
        used: 0,
        max: getTemporalProtectionLimit(
            EVENT_EVIDENCE_MAX,
            TEMPORAL_PROTECTION_POLICY.maxEvidenceBudgetShare,
        ),
    };

    // 从 recallResult 解构
    const l0Selected = recallResult?.l0Selected || [];
    const l1ByFloor = recallResult?.l1ByFloor || new Map();
    const evidenceTrace = options.captureEvidenceTrace ? createEvidenceTraceRecorder(causalById) : null;

    // 装配结果
    const assembled = {
        constraints: { lines: [], tokens: 0 },
        directEvents: { lines: [], tokens: 0 },
        relatedEvents: { lines: [], tokens: 0 },
        distantEvidence: { lines: [], tokens: 0 },
        recentEvidence: { lines: [], tokens: 0 },
        arcs: { lines: [], tokens: 0 },
    };

    // 注入统计
    const injectionStats = {
        budget: { max: TOTAL_BUDGET_MAX, used: 0 },
        constraint: { count: 0, tokens: 0, filtered: 0 },
        arc: { count: 0, tokens: 0 },
        event: { selected: 0, tokens: 0 },
        directEvidence: { units: 0, l0: 0, l1: 0, tokens: 0 },
        causalEvidence: null,
        distantEvidence: { units: 0, tokens: 0 },
        recentEvidence: { units: 0, tokens: 0 },
    };

    // DIRECT、远期与近期证据共享同一去重集合，L0 与 L1 都有稳定身份。
    const usedEvidenceIds = new Set();

    // ═══════════════════════════════════════════════════════════════════════
    // [Constraints] L3 Facts → 世界约束
    // ═══════════════════════════════════════════════════════════════════════

    const allFacts = assembleVectorConstraints(store, recallResult, focusCharacters, assembled, injectionStats, metrics, evidenceTrace);

    // ═══════════════════════════════════════════════════════════════════════
    // [Arcs] 人物弧光
    // ═══════════════════════════════════════════════════════════════════════

    if (evidenceTrace && data.arcs?.length) {
        const { name1 } = getContext();
        const relevant = new Set(
            [String(name1 || "").trim(), ...(focusCharacters || [])]
                .map(s => String(s || "").trim())
                .filter(Boolean)
        );
        for (const arc of (data.arcs || [])) {
            const name = String(arc?.name || "").trim();
            if (name && relevant.has(name)) evidenceTrace.arc('final', arc);
        }
    }

    if (data.arcs?.length) {
        const { name1 } = getContext();
        const userName = String(name1 || "").trim();

        const relevant = new Set(
            [userName, ...(focusCharacters || [])]
                .map(s => String(s || "").trim())
                .filter(Boolean)
        );

        const filteredArcs = (data.arcs || []).filter(a => {
            const n = String(a?.name || "").trim();
            return n && relevant.has(n);
        });
        if (filteredArcs.length) {
            const arcBudget = { used: 0, max: ARCS_MAX };
            for (const a of filteredArcs) {
                const line = formatArcLine(a);
                if (!pushWithBudget(assembled.arcs.lines, line, arcBudget)) continue;
                if (evidenceTrace) evidenceTrace.arc('prompt', a);
            }
            assembled.arcs.tokens = arcBudget.used;
            injectionStats.arc.count = assembled.arcs.lines.length;
            injectionStats.arc.tokens = arcBudget.used;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // [Events] L2 Events → 直接命中 + 相似命中 + 因果链 + EvidenceGroup
    // ═══════════════════════════════════════════════════════════════════════
    const selection = selectPromptEvents(recallResult, injectionStats, metrics, evidenceTrace);
    const { candidates, selectedDirect, selectedRelated } = selection;

    let directEvidenceL1 = Array.isArray(recallResult?.directEvidenceL1)
        ? recallResult.directEvidenceL1
        : null;
    let directEvidenceStatus = String(recallResult?.directEvidenceStatus || '');
    const selectedEvidenceOwners = [...selectedDirect, ...selectedRelated]
        .filter(selected => candidates[selected.candidateRank]?._evidenceEligible === true)
        .sort((left, right) => left.candidateRank - right.candidateRank);
    if (!directEvidenceL1 && recallResult?.directEvidenceContext) {
        const selectedEvidenceHits = selectedEvidenceOwners
            .map(selected => candidates[selected.candidateRank]);
        const result = await hydrateSelectedDirectEvidence(
            selectedEvidenceHits,
            recallResult.directEvidenceContext,
            metrics,
        );
        directEvidenceL1 = result.items;
        directEvidenceStatus = result.status;
        if (recallResult.directEvidenceContext.diagnostics) {
            recallResult.directEvidenceContext.diagnostics.stage = 'prompt-assembly';
        }
        recallResult.directEvidenceL1 = directEvidenceL1;
        recallResult.directEvidenceStatus = directEvidenceStatus;
        recallResult.directEvidenceContext = null;
        deferredDirectEvidenceContext = null;
    }
    const { causalEvidence, causalOwners } = assembleEventEvidence({
        selection, selectedEvidenceOwners, l0Selected, l1ByFloor, directEvidenceL1,
        directEvidenceStatus, causalById, eventEvidenceBudget, temporalEvidenceProtectionBudget,
        usedEvidenceIds, injectionStats, metrics, evidenceTrace,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // [Evidence - Distant] 零散历史（已总结范围，未被事件消费的 L0，独立预算）
    // ═══════════════════════════════════════════════════════════════════════

    const lastSummarized = store.lastSummarizedMesId ?? -1;
    const lastChunkFloor = meta?.lastChunkFloor ?? -1;
    const uiCfg = getSummaryPanelConfig()?.ui || {};
    const parsedKeepVisible = Number.parseInt(uiCfg.keepVisibleCount, 10);
    const keepVisible = Number.isFinite(parsedKeepVisible)
        ? Math.max(0, Math.min(50, parsedKeepVisible))
        : 6;

    // 收集未被事件消费的 L0，按 rerankScore 降序
    const focusSetForEvidence = new Set((focusCharacters || []).map(normalize).filter(Boolean));

    const remainingL0 = l0Selected
        .filter(l0 => !usedEvidenceIds.has(`l0:${l0.id}`))
        .filter(l0 => shouldKeepEvidenceL0(l0, focusSetForEvidence))
        .sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));

    // 远期：floor <= lastSummarized
    const distantL0 = remainingL0.filter(l0 => l0.floor <= lastSummarized);

    // Build distant groups once so trace and admission observe the same groups.
    const distantRanked = [];
    for (const [floor, l0s] of groupL0ByFloor(distantL0)) {
        const group = buildEvidenceGroup(
            floor,
            l0s,
            unusedL1PairChunks(l1ByFloor, floor, usedEvidenceIds),
        );
        const bestScore = Math.max(...l0s.map(l0 => (l0.rerankScore ?? l0.similarity ?? 0)));
        distantRanked.push({ group, bestScore });
    }
    distantRanked.sort((a, b) => (b.bestScore - a.bestScore) || (a.group.floor - b.group.floor));
    if (evidenceTrace) {
        for (const item of distantRanked) {
            evidenceTrace.floor('final', item.group.floor, 'l0', item.bestScore);
        }
    }

    const acceptedDistantGroups = [];
    const distantEvidenceBudget = { used: 0, max: DISTANT_EVIDENCE_MAX };
    for (const item of distantRanked) {
        const group = item.group;
        if (distantEvidenceBudget.used + group.totalTokens > distantEvidenceBudget.max) continue;
        distantEvidenceBudget.used += group.totalTokens;
        acceptedDistantGroups.push(group);
        markEvidenceGroupUsed(group, usedEvidenceIds);
        injectionStats.distantEvidence.units++;
    }

    acceptedDistantGroups.sort((a, b) => a.floor - b.floor);
    for (const group of acceptedDistantGroups) {
        const groupLines = formatEvidenceGroup(group);
        for (const line of groupLines) {
            assembled.distantEvidence.lines.push(line);
        }
    }

    assembled.distantEvidence.tokens = distantEvidenceBudget.used;
    injectionStats.distantEvidence.tokens = distantEvidenceBudget.used;
    if (metrics?.evidence) {
        metrics.evidence.distantEvidenceBudgetUsed = distantEvidenceBudget.used;
        metrics.evidence.distantEvidenceBudgetMax = distantEvidenceBudget.max;
        metrics.evidence.distantEvidenceDroppedByBudget = Math.max(
            0,
            distantRanked.length - acceptedDistantGroups.length,
        );
    }
    injectionStats.causalEvidence = causalEvidence.stats;
    if (metrics?.evidence) {
        metrics.evidence.causalEvidence = causalEvidence.stats;
        metrics.evidence.eventEvidenceBudgetUsed = eventEvidenceBudget.used;
        metrics.evidence.eventEvidenceBudgetMax = eventEvidenceBudget.max;
    }

    renderPromptEvents(selection, causalEvidence, causalOwners, assembled, evidenceTrace);

    if (evidenceTrace) {
        for (const group of acceptedDistantGroups) evidenceTrace.floor('prompt', group.floor, 'l0');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // [Evidence - Recent] 近期证据（未总结范围，独立预算）
    // ═══════════════════════════════════════════════════════════════════════

    const recentStart = lastSummarized + 1;
    const recentEnd = lastChunkFloor - keepVisible;

    if (recentEnd >= recentStart) {
        const recentAllL0 = getRecentWindowL0Atoms(recentStart, recentEnd);
        const recentL0 = recentAllL0
            .filter(l0 => !usedEvidenceIds.has(`l0:${l0.id}`))
            .filter(l0 => l0.floor >= recentStart && l0.floor <= recentEnd);

        if (recentL0.length) {
            const recentBudget = { used: 0, max: UNSUMMARIZED_EVIDENCE_MAX };

            // Pick newest floors first, then output in chronological order.
            const recentFloorMap = groupL0ByFloor(recentL0);
            const recentRanked = [];
            for (const [floor, l0s] of recentFloorMap) {
                const group = buildRecentEvidenceGroup(floor, l0s);
                recentRanked.push({ group });
            }
            recentRanked.sort((a, b) => b.group.floor - a.group.floor);
            if (evidenceTrace) {
                for (const item of recentRanked) evidenceTrace.floor('final', item.group.floor, 'recent-l0');
            }

            const acceptedRecentGroups = [];
            for (const item of recentRanked) {
                const group = item.group;
                if (recentBudget.used + group.totalTokens > recentBudget.max) continue;
                recentBudget.used += group.totalTokens;
                acceptedRecentGroups.push(group);
                if (evidenceTrace) evidenceTrace.floor('prompt', group.floor, 'recent-l0');
                markEvidenceGroupUsed(group, usedEvidenceIds);
                injectionStats.recentEvidence.units++;
            }

            acceptedRecentGroups.sort((a, b) => a.floor - b.floor);
            for (const group of acceptedRecentGroups) {
                const groupLines = formatEvidenceGroup(group);
                for (const line of groupLines) {
                    assembled.recentEvidence.lines.push(line);
                }
            }

            assembled.recentEvidence.tokens = recentBudget.used;
            injectionStats.recentEvidence.tokens = recentBudget.used;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 按注入顺序拼接 sections
    // ═══════════════════════════════════════════════════════════════════════

    const T_Format_Start = performance.now();

    const sections = [];

    const budgetBreakdown = {
        constraints: assembled.constraints.tokens,
        events: injectionStats.event.tokens,
        directEvidence: injectionStats.directEvidence.tokens,
        causalEvidence: injectionStats.causalEvidence.tokens,
        distantEvidence: injectionStats.distantEvidence.tokens,
        recentEvidence: injectionStats.recentEvidence.tokens,
        arcs: assembled.arcs.tokens,
    };
    injectionStats.budget.used = Object.values(budgetBreakdown).reduce((sum, tokens) => sum + tokens, 0);
    if (metrics) {
        metrics.budget.total = injectionStats.budget.used;
        metrics.budget.limit = TOTAL_BUDGET_MAX;
        metrics.budget.utilization = Math.round(injectionStats.budget.used / TOTAL_BUDGET_MAX * 100);
        metrics.budget.breakdown = budgetBreakdown;
        metrics.evidence.tokens = budgetBreakdown.directEvidence
            + budgetBreakdown.causalEvidence
            + budgetBreakdown.distantEvidence
            + budgetBreakdown.recentEvidence;
    }

    if (assembled.constraints.lines.length) {
        sections.push(`[定了的事] 已确立的事实\n${assembled.constraints.lines.join("\n")}`);
    }
    if (assembled.directEvents.lines.length) {
        sections.push(`[印象深的事] 记得很清楚\n\n${assembled.directEvents.lines.join("\n\n")}`);
    }
    if (assembled.relatedEvents.lines.length) {
        sections.push(`[其他人的事] 别人经历的类似事\n\n${assembled.relatedEvents.lines.join("\n\n")}`);
    }
    if (assembled.distantEvidence.lines.length) {
        sections.push(`[零散记忆] 没归入事件的片段\n${assembled.distantEvidence.lines.join("\n")}`);
    }
    if (assembled.recentEvidence.lines.length) {
        sections.push(`[新鲜记忆] 还没总结的部分\n${assembled.recentEvidence.lines.join("\n")}`);
    }
    if (assembled.arcs.lines.length) {
        sections.push(`[这些人] 他们的弧光\n${assembled.arcs.lines.join("\n")}`);
    }

    if (!sections.length) {
        if (metrics) metrics.timing.formatting = Math.round(performance.now() - T_Format_Start);
        return {
            promptText: "",
            injectionStats,
            metrics,
            ...(evidenceTrace ? { evidenceTrace: evidenceTrace.value } : {}),
        };
    }

    const memoryBody = `<剧情记忆>\n\n${sections.join("\n\n")}\n\n</剧情记忆>`;
    const promptText = buildMemoryPromptText(memoryBody);

    if (metrics) {
        metrics.formatting.sectionsIncluded = [];
        if (assembled.constraints.lines.length) metrics.formatting.sectionsIncluded.push('constraints');
        if (assembled.directEvents.lines.length) metrics.formatting.sectionsIncluded.push('direct_events');
        if (assembled.relatedEvents.lines.length) metrics.formatting.sectionsIncluded.push('related_events');
        if (assembled.distantEvidence.lines.length) metrics.formatting.sectionsIncluded.push('distant_evidence');
        if (assembled.recentEvidence.lines.length) metrics.formatting.sectionsIncluded.push('recent_evidence');
        if (assembled.arcs.lines.length) metrics.formatting.sectionsIncluded.push('arcs');

        const formattingTime = Math.round(performance.now() - T_Format_Start);
        metrics.timing.formatting = formattingTime;

        const relevantFacts = Math.max(0, allFacts.length - (metrics.constraint.filtered || 0));
        metrics.quality.constraintCoverage = relevantFacts > 0
            ? Math.round((metrics.constraint.injected || 0) / relevantFacts * 100)
            : 100;

        // l1AttachRate：有 L1 挂载的唯一楼层占所有 L0 覆盖楼层的比例
        const l0Floors = new Set(l0Selected.map(l0 => l0.floor));
        const l0FloorsWithL1 = new Set();
        for (const floor of l0Floors) {
            const pair = l1ByFloor.get(floor);
            if (pair?.aiTop1 || pair?.userTop1) {
                l0FloorsWithL1.add(floor);
            }
        }
        metrics.quality.l1AttachRate = l0Floors.size > 0
            ? Math.round(l0FloorsWithL1.size / l0Floors.size * 100)
            : 0;

    }

    return {
        promptText,
        injectionStats,
        metrics,
        ...(evidenceTrace ? { evidenceTrace: evidenceTrace.value } : {}),
    };
    } finally {
        if (deferredDirectEvidenceContext) {
            await releaseDirectEvidenceContext(deferredDirectEvidenceContext, metrics);
        }
        if (recallResult?.directEvidenceContext === deferredDirectEvidenceContext) {
            recallResult.directEvidenceContext = null;
        }
        if (metrics) {
            const elapsed = performance.now() - T_Start;
            metrics.timing.evidenceAssembly = Math.max(0, Math.round(elapsed
                - metrics.timing.constraintFilter - metrics.timing.formatting
                - metrics.timing.directEvidenceRetrieval
                - (metrics.timing.runtimeEndSession - releaseElapsedBefore)));
            finalizeMetricsTiming(metrics, recallElapsed + elapsed);
            metrics.quality.potentialIssues = detectIssues(metrics);
        }
    }
}

export async function buildVectorPromptForReplay(store, recallResult, causalById, focusCharacters, meta, metrics) {
    return await buildVectorPrompt(
        store,
        recallResult,
        causalById,
        focusCharacters,
        meta,
        metrics,
        { captureEvidenceTrace: true },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 向量模式：召回 + 注入
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构建向量模式注入文本。这里只计算，不发布 UI 日志、警告或 extension prompt。
 * 所有可观察副作用都由 generate interceptor 在认领本轮结果后提交。
 * @param {boolean} excludeLastAi - 是否排除最后的 AI 消息
 * @param {object} options - 计算选项
 * @returns {Promise<{text: string, diagnostics: object, notice: object|null}>}
 */
export async function buildVectorPromptText(excludeLastAi = false, options = {}) {
    const { signal = null, diagnostics = createRecallDiagnostics(getContext()?.chatId),
        stageObserver = null, captureEvidenceTrace = false } = options;
    let recallResult = null;
    let meta = null;
    let assembly = null;
    const finish = (text, reason = '', notice = null) => {
        diagnostics.reason = reason || diagnostics.reason;
        diagnostics.finishedAt ??= performance.now();
        return { text, notice, diagnostics,
            ...(captureEvidenceTrace ? { observation: { recallResult, meta, assembly } } : {}) };
    };

    if (!getSettings().storySummary?.enabled) {
        return finish('', '剧情总结未启用');
    }

    const { chat } = getContext();
    const store = getSummaryStore();

    if (!store?.json) {
        return finish('', '没有已保存的总结');
    }

    const allEvents = store.json.events || [];
    const lastIdx = store.lastSummarizedMesId ?? 0;
    const length = chat?.length || 0;

    if (lastIdx >= length) {
        return finish('', '总结边界超过当前聊天范围');
    }

    const vectorCfg = getVectorConfig();
    if (!vectorCfg?.enabled) {
        return finish('', '向量召回未启用');
    }

    const { chatId } = getContext();
    meta = chatId ? await getMeta(chatId) : null;
    let causalById = new Map();

    try {
        try {
            recallResult = await recallMemory(allEvents, vectorCfg, {
                excludeLastAi,
                signal,
                deferRuntimeRelease: true,
                diagnostics,
                stageObserver,
            });

            recallResult = {
                ...recallResult,
                events: recallResult?.events || [],
                l0Selected: recallResult?.l0Selected || [],
                l1ByFloor: recallResult?.l1ByFloor || new Map(),
                causalChain: recallResult?.causalChain || [],
                focusTerms: recallResult?.focusTerms || recallResult?.focusEntities || [],
                focusEntities: recallResult?.focusTerms || recallResult?.focusEntities || [], // compat alias
                focusCharacters: recallResult?.focusCharacters || [],
                metrics: recallResult?.metrics || null,
            };

            // 构建因果事件索引
            causalById = new Map(
                (recallResult.causalChain || [])
                    .map(c => [c?.event?.id, c])
                    .filter(x => x[0])
            );
        } catch (e) {
            if (signal?.aborted) {
                return finish('', '召回已取消');
            }
            xbLog.error(MODULE_ID, "向量召回失败", e);
            throw e;
        }

        if (signal?.aborted) {
            return finish('', '召回已取消');
        }

        const hasRecallEvidence =
            (recallResult?.events?.length || 0) > 0 ||
            (recallResult?.l0Selected?.length || 0) > 0 ||
            (recallResult?.causalChain?.length || 0) > 0;

        let notice = null;
        if (!hasRecallEvidence) {
            const noVectorsGenerated = !meta?.fingerprint || (meta?.lastChunkFloor ?? -1) < 0;
            const fpMismatch = meta?.fingerprint && meta.fingerprint !== getEngineFingerprint(vectorCfg);

            if (!diagnostics.reason && fpMismatch) {
                notice = {
                    issueCode: 'fingerprint_mismatch',
                    message: '向量引擎已变更，请重新生成向量',
                };
            } else if (!diagnostics.reason && noVectorsGenerated) {
                notice = {
                    issueCode: 'vectors_not_generated',
                    message: '没有可用向量，请在剧情总结面板中生成向量',
                };
            }
            // 向量存在但本次未命中 → 静默跳过，不打扰用户
            return finish('', diagnostics.reason || notice?.message || '检索完成，没有命中候选', notice);
        }

        diagnostics.stage = 'prompt-assembly';
        assembly = await buildVectorPrompt(
            store,
            recallResult,
            causalById,
            recallResult?.focusCharacters || [],
            meta,
            recallResult?.metrics || null,
            { captureEvidenceTrace },
        );
        if (signal?.aborted) {
            return finish('', '召回已取消');
        }

        const cfg = getSummaryPanelConfig();
        let finalText = String(assembly.promptText || "");
        if (cfg.trigger?.wrapperHead) finalText = cfg.trigger.wrapperHead + "\n" + finalText;
        if (cfg.trigger?.wrapperTail) finalText = finalText + "\n" + cfg.trigger.wrapperTail;

        diagnostics.stage = 'prompt-ready';
        return finish(finalText, finalText.trim() ? '' : '已有候选，但没有内容进入最终装配', notice);
    } finally {
        if (recallResult?.directEvidenceContext) {
            await releaseDirectEvidenceContext(recallResult.directEvidenceContext, recallResult.metrics);
            recallResult.directEvidenceContext = null;
        }
    }
}
