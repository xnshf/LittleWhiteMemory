import { normalizeCharacterAliases } from "./character-aliases.js";
import { normalizeEventMemoryRole } from "./events.js";

function stripFloorMarker(summary) {
    return String(summary || "")
        .replace(/\s*\(#\d+(?:-\d+)?\)\s*$/, "")
        .trim();
}

function normalizeInternalFact(item) {
    const fact = item && typeof item === "object" ? item : {};
    const base = {
        id: String(fact?.id || "").trim(),
        s: String(fact?.s ?? "").trim(),
        p: String(fact?.p ?? "").trim(),
        o: String(fact?.o ?? "").trim(),
    };

    const stateValue = fact?._isState ?? fact?.isState;
    if (stateValue != null) {
        base._isState = !!stateValue;
    }

    const trendValue = String(fact?.trend ?? "").trim();
    if (trendValue) {
        base.trend = trendValue;
    }

    return base;
}

function normalizePortableFact(item) {
    const fact = item && typeof item === "object" ? item : {};
    const base = {
        id: String(fact?.id || "").trim(),
        s: String(fact?.人物名字 ?? "").trim(),
        p: String(fact?.种类 ?? "").trim(),
        o: String(fact?.描述 ?? "").trim(),
    };

    const stateValue = fact?._isState ?? fact?.isState ?? fact?.核心事实;
    if (stateValue != null) {
        base._isState = !!stateValue;
    }

    const trendValue = String(fact?.trend ?? fact?.趋势 ?? "").trim();
    if (trendValue) {
        base.trend = trendValue;
    }

    return base;
}

function serializePortableFact(fact) {
    const out = {
        人物名字: String(fact?.s || "").trim(),
        种类: String(fact?.p || "").trim(),
        描述: String(fact?.o || "").trim(),
    };

    if (fact?._isState != null) {
        out.核心事实 = !!fact._isState;
    }

    if (fact?.trend) {
        out.趋势 = String(fact.trend).trim();
    }

    return out;
}

function cloneSummaryJsonForPortability(json) {
    const src = json && typeof json === "object" ? json : {};
    const characters = src.characters && typeof src.characters === "object" ? src.characters : {};
    return {
        keywords: Array.isArray(src.keywords)
            ? src.keywords.map((item) => ({
                text: String(item?.text || "").trim(),
                weight: String(item?.weight || "").trim(),
            })).filter((item) => item.text)
            : [],
        events: Array.isArray(src.events)
            ? src.events.map((item) => ({
                id: String(item?.id || "").trim(),
                title: String(item?.title || "").trim(),
                timeLabel: String(item?.timeLabel || "").trim(),
                summary: stripFloorMarker(item?.summary),
                participants: Array.isArray(item?.participants)
                    ? item.participants.map((name) => String(name || "").trim()).filter(Boolean)
                    : [],
                memoryRole: normalizeEventMemoryRole(item?.memoryRole),
                causedBy: Array.isArray(item?.causedBy)
                    ? item.causedBy.map((id) => String(id || "").trim()).filter(Boolean)
                    : [],
            })).filter((item) => item.id || item.title || item.summary)
            : [],
        characters: {
            main: Array.isArray(characters.main)
                ? characters.main
                    .map((item) => typeof item === "string"
                        ? { name: String(item).trim() }
                        : { name: String(item?.name || "").trim() })
                    .filter((item) => item.name)
                : (Array.isArray(characters)
                    ? characters
                        .map((item) => typeof item === "string"
                            ? { name: String(item).trim() }
                            : { name: String(item?.name || "").trim() })
                        .filter((item) => item.name)
                    : []),
        },
        characterAliases: normalizeCharacterAliases(src.characterAliases)
            .map((item) => ({
                from: item.from,
                to: item.to,
                evidence: item.evidence,
            })),
        arcs: Array.isArray(src.arcs)
            ? src.arcs.map((item) => ({
                name: String(item?.name || "").trim(),
                trajectory: String(item?.trajectory || "").trim(),
                progress: Number.isFinite(Number(item?.progress)) ? Number(item.progress) : 0,
                moments: Array.isArray(item?.moments)
                    ? item.moments
                        .map((moment) => typeof moment === "string"
                            ? { text: String(moment).trim() }
                            : { text: String(moment?.text || "").trim() })
                        .filter((moment) => moment.text)
                    : [],
            })).filter((item) => item.name)
            : [],
        facts: Array.isArray(src.facts)
            ? src.facts.map(normalizeInternalFact).filter((item) => item.s && item.p && item.o)
            : [],
    };
}

export function extractSummaryImportJson(raw) {
    if (!raw || typeof raw !== "object") {
        throw new Error("文件内容不是有效 JSON 对象");
    }

    const candidate =
        (raw.type === "LittleWhiteMemoryStorySummaryMemory" && raw.data && typeof raw.data === "object" ? raw.data : null) ||
        (raw.storySummary?.json && typeof raw.storySummary.json === "object" ? raw.storySummary.json : null) ||
        (raw.json && typeof raw.json === "object" ? raw.json : null) ||
        raw;

    const hasSummaryShape =
        Array.isArray(candidate.keywords) ||
        Array.isArray(candidate.events) ||
        Array.isArray(candidate.arcs) ||
        Array.isArray(candidate.facts) ||
        (candidate.characters && typeof candidate.characters === "object");

    if (!hasSummaryShape) {
        throw new Error("未识别到可导入的总结数据");
    }

    const json = cloneSummaryJsonForPortability(candidate);
    json.facts = Array.isArray(candidate.facts)
        ? candidate.facts.map(normalizePortableFact).filter((item) => item.s && item.p && item.o)
        : [];
    return json;
}

export function buildSummaryExportPackage(store) {
    const json = cloneSummaryJsonForPortability(store?.json || {});
    const data = {
        ...json,
        facts: json.facts.map(serializePortableFact),
    };
    return {
        type: "LittleWhiteMemoryStorySummaryMemory",
        version: 1,
        exportedAt: new Date().toISOString(),
        data,
        counts: {
            keywords: json.keywords.length,
            events: json.events.length,
            characters: json.characters.main.length,
            aliases: json.characterAliases.length,
            arcs: json.arcs.length,
            facts: json.facts.length,
        },
    };
}

function pushSection(lines, title, items) {
    if (!items.length) return;
    if (lines.length) lines.push("");
    lines.push(`## ${title}`, "", ...items);
}

function formatSummaryCharacterName(item) {
    return String(typeof item === "string" ? item : item?.name || "").trim();
}

function formatSummaryProgress(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0%";
    return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

export function formatStorySummaryMemoryText(store) {
    const json = cloneSummaryJsonForPortability(store?.json || {});
    const lines = [];

    pushSection(lines, "关键词", (json.keywords || [])
        .map((item) => {
            const text = String(item?.text || "").trim();
            if (!text) return "";
            const weight = String(item?.weight || "").trim();
            return `- ${text}${weight ? `（${weight}）` : ""}`;
        })
        .filter(Boolean));

    pushSection(lines, "事件时间线", (json.events || [])
        .map((event, index) => {
            const title = String(event?.title || "").trim() || `事件 ${index + 1}`;
            const timeLabel = String(event?.timeLabel || "").trim();
            const summary = stripFloorMarker(event?.summary);
            const participants = Array.isArray(event?.participants)
                ? event.participants.map((name) => String(name || "").trim()).filter(Boolean)
                : [];
            const meta = [
                timeLabel ? `时间：${timeLabel}` : "",
                participants.length ? `参与者：${participants.join("、")}` : "",
                event?.memoryRole ? `记忆作用：${event.memoryRole}` : "",
            ].filter(Boolean).join("；");
            return [
                `### ${title}`,
                meta,
                summary,
            ].filter(Boolean).join("\n");
        })
        .filter(Boolean));

    pushSection(lines, "主要角色", (json.characters?.main || [])
        .map(formatSummaryCharacterName)
        .filter(Boolean)
        .map((name) => `- ${name}`));

    pushSection(lines, "角色别名", normalizeCharacterAliases(json.characterAliases)
        .map((alias) => `- ${alias.to}：${alias.from}${alias.evidence ? `（${alias.evidence}）` : ""}`));

    pushSection(lines, "角色弧光", (json.arcs || [])
        .map((arc) => {
            const name = String(arc?.name || "").trim();
            if (!name) return "";
            const trajectory = String(arc?.trajectory || "").trim();
            const moments = Array.isArray(arc?.moments)
                ? arc.moments.map((moment) => String(moment?.text || "").trim()).filter(Boolean)
                : [];
            return [
                `### ${name}`,
                trajectory ? `${trajectory}（进度：${formatSummaryProgress(arc?.progress)}）` : `进度：${formatSummaryProgress(arc?.progress)}`,
                ...moments.map((moment) => `- ${moment}`),
            ].filter(Boolean).join("\n");
        })
        .filter(Boolean));

    pushSection(lines, "事实图谱", (json.facts || [])
        .map((fact) => {
            const subject = String(fact?.s || "").trim();
            const predicate = String(fact?.p || "").trim();
            const object = String(fact?.o || "").trim();
            if (!subject || !predicate || !object) return "";
            const trend = String(fact?.trend || "").trim();
            return `- ${subject}｜${predicate}｜${object}${trend ? `（趋势：${trend}）` : ""}`;
        })
        .filter(Boolean));

    return lines.join("\n").trim();
}

function stampImportedSummaryJson(json, boundary) {
    if (!json || typeof json !== "object" || !Number.isFinite(boundary) || boundary < 0) {
        return;
    }

    for (const item of (json.keywords || [])) {
        if (item && typeof item === "object") item._addedAt = boundary;
    }

    for (const item of (json.events || [])) {
        if (item && typeof item === "object") item._addedAt = boundary;
    }

    const mainCharacters = json.characters?.main || [];
    for (const item of mainCharacters) {
        if (item && typeof item === "object") item._addedAt = boundary;
    }

    for (const alias of (json.characterAliases || [])) {
        if (alias && typeof alias === "object") alias._addedAt = boundary;
    }

    for (const arc of (json.arcs || [])) {
        if (!arc || typeof arc !== "object") continue;
        arc._addedAt = boundary;
        for (const moment of (arc.moments || [])) {
            if (moment && typeof moment === "object") moment._addedAt = boundary;
        }
    }

    for (const fact of (json.facts || [])) {
        if (fact && typeof fact === "object") fact._addedAt = boundary;
    }
}

export function applyImportedSummaryBoundary(store, boundary) {
    if (!store?.json || !Number.isFinite(boundary) || boundary < 0) {
        return false;
    }

    stampImportedSummaryJson(store.json, boundary);
    store.lastSummarizedMesId = boundary;
    store.summaryHistory = [{ endMesId: boundary }];
    delete store.pendingImportBoundary;
    store.updatedAt = Date.now();
    return true;
}
