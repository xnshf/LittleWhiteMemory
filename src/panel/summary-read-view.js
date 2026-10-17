// Read-only sections of the story summary panel.
export function createSummaryReadView({ $, h, setHtml, relationUI, getSummaryData }) {
    let timelineHasRenderedEvents = false;
    let lastRecallLogText = '';

    function renderRelations(data) {
        getSummaryData().characters = data || { main: [], relationships: [] };
        relationUI.renderRelations(data);
    }

    function renderArcs(arcs) {
        getSummaryData().arcs = arcs || [];
        relationUI.renderArcs(arcs);
    }

    function renderKeywords(kw) {
        getSummaryData().keywords = kw || [];
        const wc = { '核心': 'p', '重要': 's', high: 'p', medium: 's' };
        setHtml($('keywords-cloud'), kw.length
            ? kw.map(k => `<span class="tag ${wc[k.weight] || wc[k.level] || ''}">${h(k.text)}</span>`).join('')
            : '<div class="empty">暂无关键词</div>');
    }

    function getTimelineScrollState() {
        const el = $('timeline-list');
        if (!el) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0, wasAtBottom: true };
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        return {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            wasAtBottom: distanceToBottom <= 24,
        };
    }

    function restoreTimelineScroll(state, mode = 'auto') {
        const el = $('timeline-list');
        if (!el) return;
        requestAnimationFrame(() => {
            const preserve = () => {
                const delta = el.scrollHeight - state.scrollHeight;
                el.scrollTop = Math.max(0, state.scrollTop + delta);
            };
            if (mode === 'preserve') {
                preserve();
                return;
            }
            if (!timelineHasRenderedEvents || state.wasAtBottom) {
                el.scrollTop = el.scrollHeight;
                return;
            }
            preserve();
        });
    }

    function renderTimeline(ev, options = {}) {
        const scrollState = getTimelineScrollState();
        getSummaryData().events = ev || [];
        const c = $('timeline-list');
        if (!ev?.length) {
            setHtml(c, '<div class="empty">暂无事件记录</div>');
            timelineHasRenderedEvents = false;
            return;
        }
        setHtml(c, ev.map(e => {
            const participants = (e.participants || e.characters || []).map(h).join('、');
            return `<div class="tl-item">
                <div class="tl-dot"></div>
                <div class="tl-head">
                    <div class="tl-title">${h(e.title || '')}</div>
                    <div class="tl-time">${h(e.timeLabel || '')}</div>
                </div>
                <div class="tl-brief">${h(e.summary || e.brief || '')}</div>
                <div class="tl-meta">
                    <span>人物：${participants || '—'}</span>
                    <span class="imp">${h(e.memoryRole || '未标注')}</span>
                </div>
            </div>`;
        }).join(''));
        restoreTimelineScroll(scrollState, options.scrollMode || 'auto');
        timelineHasRenderedEvents = true;
    }

    function resetTimelineRender() {
        timelineHasRenderedEvents = false;
    }

    function renderCharacterAliases(aliases) {
        getSummaryData().characterAliases = aliases || [];
        const list = $('aliases-list');
        if (!list) return;
        if (!aliases?.length) {
            setHtml(list, '<div class="empty">暂无别名映射</div>');
            return;
        }
        setHtml(list, aliases.map(alias => `
            <div class="alias-item">
                <span class="alias-from">${h(alias.from || '')}</span>
                <span class="alias-arrow" aria-hidden="true">→</span>
                <span class="alias-to">${h(alias.to || '')}</span>
                ${alias.evidence ? `<span class="alias-evidence">${h(alias.evidence)}</span>` : ''}
            </div>
        `).join(''));
    }

    function updateStats(s) {
        if (!s) return;
        $('stat-summarized').textContent = s.summarizedUpTo ?? 0;
        $('stat-events').textContent = s.eventsCount ?? 0;
        const p = s.pendingFloors ?? 0;
        $('stat-pending').textContent = p;
        $('pending-warning').classList.toggle('hidden', p !== -1);
    }

    function setRecallLog(text) {
        lastRecallLogText = text || '';
        updateRecallLogDisplay();
    }

    function updateRecallLogDisplay() {
        const content = $('recall-log-content');
        if (!content) return;

        if (lastRecallLogText) {
            content.textContent = lastRecallLogText;
            content.classList.remove('recall-empty');
        } else {
            setHtml(content, `<div class="recall-empty">
            暂无召回日志<br><br>
            当 AI 生成回复时，系统会自动进行记忆召回。<br><br>
            召回日志将显示：<br>
            • [L0] Query Understanding - 意图识别<br>
            • [L1] Constraints - 硬约束注入<br>
            • [L2] Narrative Retrieval - 事件召回<br>
            • [L3] Evidence Assembly - 证据装配<br>
            • [L4] Prompt Formatting - 格式化<br>
            • [Budget] Token 预算使用情况<br>
            • [Quality] 质量指标与潜在问题
        </div>`);
        }
    }

    function renderFacts(facts) {
        getSummaryData().facts = facts || [];

        const container = $('facts-list');
        if (!container) return;

        const isRelation = f => /^对.+的/.test(f.p);
        const stateFacts = (facts || []).filter(f => !f.retracted && !isRelation(f));

        if (!stateFacts.length) {
            setHtml(container, '<div class="empty">暂无状态记录</div>');
            return;
        }

        const grouped = new Map();
        for (const f of stateFacts) {
            if (!grouped.has(f.s)) grouped.set(f.s, []);
            grouped.get(f.s).push(f);
        }

        let html = '';
        for (const [subject, items] of grouped) {
            html += `<div class="fact-group">
            <div class="fact-group-title">${h(subject)}</div>
            ${items.map(f => `
                <div class="fact-item">
                    <span class="fact-predicate">${h(f.p)}</span>
                    <span class="fact-object">${h(f.o)}</span>
                    <span class="fact-since">#${(f.since || 0) + 1}</span>
                </div>
            `).join('')}
        </div>`;
        }

        setHtml(container, html);
    }

    return {
        renderRelations, renderArcs, renderKeywords, renderTimeline, renderCharacterAliases,
        updateStats, setRecallLog, updateRecallLogDisplay, renderFacts, resetTimelineRender,
    };
}
