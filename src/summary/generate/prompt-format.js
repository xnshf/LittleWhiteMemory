// Prompt text and its existing token estimates. Keep formatting and charging in sync.
import { getContext } from "../../../../../../extensions.js";
import { getSummaryPanelConfig, DEFAULT_MEMORY_PROMPT_TEMPLATE } from "../data/config.js";
import { isRelationFact } from "../data/fact-predicates.js";

const L0_JOINED_MAX_LENGTH = 120;

export function estimateTokens(text) {
    if (!text) return 0;
    const s = String(text);
    const zh = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    return Math.ceil(zh + (s.length - zh) / 4);
}

export function pushWithBudget(lines, text, state) {
    const t = estimateTokens(text);
    if (state.used + t > state.max) return false;
    lines.push(text);
    state.used += t;
    return true;
}

export function cleanSummary(summary) {
    return String(summary || "")
        .replace(/\s*\(#\d+(?:-\d+)?\)\s*$/, "")
        .trim();
}

export function normalize(s) {
    return String(s || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim()
        .toLowerCase();
}

export function buildMemoryPromptText(memoryBody) {
    const templateRaw = String(
        getSummaryPanelConfig()?.prompts?.memoryTemplate || DEFAULT_MEMORY_PROMPT_TEMPLATE
    );
    const template = templateRaw.trim() || DEFAULT_MEMORY_PROMPT_TEMPLATE;
    if (template.includes("{$剧情记忆}")) {
        return template.replaceAll("{$剧情记忆}", memoryBody);
    }
    return `${template}\n${memoryBody}`;
}

export function formatConstraintLine(f, includeSubject = false) {
    const subject = String(f?.s || '').trim();
    const predicate = String(f?.p || '').trim();
    const object = String(f?.o || '').trim();
    const trendRaw = String(f?.trend || '').trim();
    const hasSince = f?.since !== undefined && f?.since !== null;
    const since = hasSince ? ` (#${f.since + 1})` : '';
    const trend = isRelationFact(f) && trendRaw ? ` [${trendRaw}]` : '';
    if (includeSubject) {
        return `- ${subject} ${predicate}: ${object}${trend}${since}`;
    }
    return `- ${predicate}: ${object}${trend}${since}`;
}

export function formatConstraintsStructured(grouped, order = 'desc') {
    const lines = [];
    const people = grouped?.people || new Map();
    const world = grouped?.world || [];
    const sorter = order === 'asc'
        ? ((a, b) => (a.since || 0) - (b.since || 0))
        : ((a, b) => (b.since || 0) - (a.since || 0));

    if (people.size > 0) {
        lines.push('people:');
        for (const [name, facts] of people.entries()) {
            lines.push(`  ${name}:`);
            const sorted = [...facts].sort(sorter);
            for (const f of sorted) {
                lines.push(`    ${formatConstraintLine(f, false)}`);
            }
        }
    }

    if (world.length > 0) {
        lines.push('world:');
        const sortedWorld = [...world].sort(sorter);
        for (const f of sortedWorld) {
            lines.push(`  ${formatConstraintLine(f, true)}`);
        }
    }

    return lines;
}

export function formatArcLine(arc) {
    const moments = (arc.moments || [])
        .map(m => (typeof m === "string" ? m : m.text))
        .filter(Boolean);

    if (moments.length) {
        return `- ${arc.name}：${moments.join(" → ")}`;
    }
    return `- ${arc.name}：${arc.trajectory}`;
}

export function buildL0DisplayText(l0) {
    const atom = l0.atom || {};
    return String(atom.semantic || l0.text || '').trim() || '（未知锚点）';
}

export function formatL1Line(chunk, isUser) {
    // Intentionally read on EVERY call (including cost estimation and rendering).
    // Hydration may change the host names; do not capture an assembly-wide snapshot.
    const { name1, name2 } = getContext();
    const speaker = chunk.isUser ? (name1 || "用户") : (chunk.speaker || name2 || "角色");
    const text = String(chunk.text || "").trim();
    const symbol = isUser ? "┌" : "›";
    return `    ${symbol} #${chunk.floor + 1} [${speaker}] ${text}`;
}

export function groupL0ByFloor(l0List) {
    const map = new Map();
    for (const l0 of l0List) {
        const floor = l0.floor;
        if (!map.has(floor)) {
            map.set(floor, []);
        }
        map.get(floor).push(l0);
    }
    return map;
}

/** Per-floor presentation group. Deduplicate L1, retaining the original cost model. */
export function buildEvidenceGroup(floor, l0AtomsForFloor = [], l1ChunksForFloor = []) {
    const l1Chunks = [...new Map(
        (l1ChunksForFloor || [])
            .filter(chunk => chunk?.chunkId && String(chunk?.text || '').trim())
            .map(chunk => [chunk.chunkId, chunk])
    ).values()].sort((left, right) => (
        Number(left.floor) - Number(right.floor)
        || Number(left.chunkIdx || 0) - Number(right.chunkIdx || 0)
    ));

    let totalTokens = 0;
    for (const l0 of l0AtomsForFloor) {
        totalTokens += estimateTokens(buildL0DisplayText(l0));
    }
    totalTokens += 10;
    for (const chunk of l1Chunks) {
        totalTokens += estimateTokens(formatL1Line(chunk, chunk.isUser === true));
    }
    return { floor, l0Atoms: l0AtomsForFloor, l1Chunks, totalTokens };
}

export function buildRecentEvidenceGroup(floor, l0AtomsForFloor) {
    let totalTokens = 0;
    for (const l0 of l0AtomsForFloor) {
        totalTokens += estimateTokens(buildL0DisplayText(l0));
    }
    totalTokens += 10;
    return { floor, l0Atoms: l0AtomsForFloor, l1Chunks: [], totalTokens };
}

/** Short anchors join with semicolons; long anchors retain one line per atom. */
export function formatEvidenceGroup(group) {
    const displayTexts = group.l0Atoms.map(l0 => buildL0DisplayText(l0));
    const lines = [];
    if (displayTexts.length) {
        const joined = displayTexts.join('；');
        if (joined.length <= L0_JOINED_MAX_LENGTH) {
            lines.push(`  › #${group.floor + 1} [📌] ${joined}`);
        } else {
            lines.push(`  › #${group.floor + 1} [📌] ${displayTexts[0]}`);
            for (let i = 1; i < displayTexts.length; i++) {
                lines.push(`  │      ${displayTexts[i]}`);
            }
        }
    }
    for (const chunk of group.l1Chunks || []) {
        lines.push(formatL1Line(chunk, chunk.isUser === true));
    }
    return lines;
}

export function formatEventWithEvidence(eventItem, idx, evidenceGroups, causalLines = []) {
    const ev = eventItem?.event || eventItem || {};
    const time = ev.timeLabel || "";
    const title = String(ev.title || "").trim();
    const people = (ev.participants || []).join(" / ").trim();
    const summary = cleanSummary(ev.summary);
    const displayTitle = title || people || ev.id || "事件";
    const header = time ? `${idx}.【${time}】${displayTitle}` : `${idx}. ${displayTitle}`;
    const lines = [header];
    if (people && displayTitle !== people) lines.push(`  ${people}`);
    lines.push(`  ${summary}`);
    lines.push(...causalLines);
    for (const group of evidenceGroups) {
        lines.push(...formatEvidenceGroup(group));
    }
    return lines.join("\n");
}
