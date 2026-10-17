// Text-filter rules are edited locally; persistence belongs to the panel's settings form.
export function createFilterRulesUI({ document, getElement, escapeHtml, setHtml }) {
    const $ = getElement;
    const h = escapeHtml;

    function updateFilterRulesCount() {
        const el = $('filter-rules-count');
        if (!el) return;
        el.textContent = $('filter-rules-list')?.querySelectorAll('.filter-rule-item')?.length || 0;
    }

    function renderFilterRules(rules) {
        const list = $('filter-rules-list');
        if (!list) return;
        const items = rules?.length ? rules : [];
        setHtml(list, items.map((r, i) => `
            <div class="filter-rule-item" data-idx="${i}">
                <div class="filter-rule-inputs">
                    <input type="text" class="filter-rule-start" placeholder="起始（可空）" value="${h(r.start || '')}">
                    <span class="rule-arrow">⬇</span>
                    <input type="text" class="filter-rule-end" placeholder="结束（可空）" value="${h(r.end || '')}">
                </div>
                <button class="btn-del-rule">✕</button>
            </div>
        `).join(''));
        list.querySelectorAll('.btn-del-rule').forEach(btn => {
            btn.onclick = () => {
                btn.closest('.filter-rule-item')?.remove();
                updateFilterRulesCount();
            };
        });
        updateFilterRulesCount();
    }

    function collectFilterRules() {
        const list = $('filter-rules-list');
        if (!list) return [];
        const rules = [];
        list.querySelectorAll('.filter-rule-item').forEach(item => {
            const start = item.querySelector('.filter-rule-start')?.value?.trim() || '';
            const end = item.querySelector('.filter-rule-end')?.value?.trim() || '';
            if (start || end) rules.push({ start, end });
        });
        return rules;
    }

    function addFilterRule() {
        const list = $('filter-rules-list');
        if (!list) return;
        const idx = list.querySelectorAll('.filter-rule-item').length;
        const div = document.createElement('div');
        div.className = 'filter-rule-item';
        div.dataset.idx = idx;
        setHtml(div, `
            <div class="filter-rule-inputs">
                <input type="text" class="filter-rule-start" placeholder="起始（可空）" value="">
                <span class="rule-arrow">⬇</span>
                <input type="text" class="filter-rule-end" placeholder="结束（可空）" value="">
            </div>
            <button class="btn-del-rule">✕</button>
        `);
        div.querySelector('.btn-del-rule').onclick = () => {
            div.remove();
            updateFilterRulesCount();
        };
        list.appendChild(div);
        updateFilterRulesCount();
    }

    return { renderFilterRules, collectFilterRules, addFilterRule };
}
