// Iframe summary editor. Data is read at open/save time, not snapshotted, to retain
// the existing behavior when the parent changes the active chat while editing.
import { getCharName } from './relation-ui.js';
import { EVENT_MEMORY_ROLES, projectEditedSummaryEvents } from '../summary/data/events.js';

export function createStorySummaryEditor({ document, h, setHtml, postMsg, getSummaryData }) {
    const $ = id => document.getElementById(id);
    const $$ = sel => document.querySelectorAll(sel);
    let currentEditSection = null;

    const SECTION_META = {
        keywords: { title: '编辑关键词', hint: '每行一个关键词，格式：关键词|权重（核心/重要/一般）' },
        events: { title: '编辑事件时间线', hint: '编辑时，每个事件要素都应完整' },
        characters: { title: '编辑人物关系', hint: '编辑时，每个要素都应完整' },
        arcs: { title: '编辑角色弧光', hint: '编辑时，每个要素都应完整' },
        facts: { title: '编辑事实图谱', hint: '每行一条：主体|谓词|值|趋势(可选)。删除用：主体|谓词|（留空值）' },
        aliases: { title: '编辑别名映射', hint: '别名与角色主名必须不同；确认依据可留空' }
    };

    function renderArcsEditor(arcs) {
        const list = arcs?.length ? arcs : [{ name: '', trajectory: '', progress: 0, moments: [] }];
        const es = $('editor-struct');

        setHtml(es, `
            <div id="arc-list">
                ${list.map((a, i) => `
                    <div class="struct-item arc-item" data-index="${i}">
                        <div class="struct-row"><input type="text" class="arc-name" placeholder="角色名" value="${h(a.name || '')}"></div>
                        <div class="struct-row"><textarea class="arc-trajectory" rows="2" placeholder="当前状态描述">${h(a.trajectory || '')}</textarea></div>
                        <div class="struct-row">
                            <label style="font-size:.75rem;color:var(--txt3)">进度：<input type="number" class="arc-progress" min="0" max="100" value="${Math.round((a.progress || 0) * 100)}" style="width:64px;display:inline-block"> %</label>
                        </div>
                        <div class="struct-row"><textarea class="arc-moments" rows="3" placeholder="关键时刻，一行一个">${h((a.moments || []).map(m => typeof m === 'string' ? m : m.text).join('\n'))}</textarea></div>
                        <div class="struct-actions"><span>角色弧光 ${i + 1}</span></div>
                    </div>
                `).join('')}
            </div>
            <div style="margin-top:8px"><button type="button" class="btn btn-sm" id="arc-add">＋ 新增角色弧光</button></div>
        `);

        es.querySelectorAll('.arc-item').forEach(addDeleteHandler);

        $('arc-add').onclick = () => {
            const listEl = $('arc-list');
            const idx = listEl.querySelectorAll('.arc-item').length;
            const div = document.createElement('div');
            div.className = 'struct-item arc-item';
            div.dataset.index = idx;
            setHtml(div, `
                <div class="struct-row"><input type="text" class="arc-name" placeholder="角色名"></div>
                <div class="struct-row"><textarea class="arc-trajectory" rows="2" placeholder="当前状态描述"></textarea></div>
                <div class="struct-row">
                    <label style="font-size:.75rem;color:var(--txt3)">进度：<input type="number" class="arc-progress" min="0" max="100" value="0" style="width:64px;display:inline-block"> %</label>
                </div>
                <div class="struct-row"><textarea class="arc-moments" rows="3" placeholder="关键时刻，一行一个"></textarea></div>
                <div class="struct-actions"><span>角色弧光 ${idx + 1}</span></div>
            `);
            addDeleteHandler(div);
            listEl.appendChild(div);
        };
    }


    function preserveAddedAt(n, o) {
        if (o?._addedAt != null) n._addedAt = o._addedAt;
        return n;
    }

    function createDelBtn() {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm btn-del';
        b.textContent = '删除';
        return b;
    }

    function addDeleteHandler(item) {
        const del = createDelBtn();
        (item.querySelector('.struct-actions') || item).appendChild(del);
        del.onclick = () => item.remove();
    }

    function memoryRoleOptions(role = '') {
        return `<option value=""${role ? '' : ' selected'}>未标注</option>`
            + EVENT_MEMORY_ROLES.map(value => `<option value="${h(value)}"${role === value ? ' selected' : ''}>${h(value)}</option>`).join('');
    }

    function renderEventsEditor(events) {
        const list = events?.length ? events : [{ id: 'evt-1', title: '', timeLabel: '', summary: '', participants: [], memoryRole: '' }];
        let maxId = 0;
        list.forEach(e => {
            const m = e.id?.match(/evt-(\d+)/);
            if (m) maxId = Math.max(maxId, +m[1]);
        });

        const es = $('editor-struct');
        setHtml(es, list.map(ev => {
            const id = ev.id || `evt-${++maxId}`;
            return `<div class="struct-item event-item" data-id="${h(id)}">
                <div class="struct-row">
                    <input type="text" class="event-title" placeholder="事件标题" value="${h(ev.title || '')}">
                    <input type="text" class="event-time" placeholder="时间标签" value="${h(ev.timeLabel || '')}">
                </div>
                <div class="struct-row">
                    <textarea class="event-summary" rows="2" placeholder="一句话描述">${h(ev.summary || '')}</textarea>
                </div>
                <div class="struct-row">
                    <input type="text" class="event-participants" placeholder="人物（顿号分隔）" value="${h((ev.participants || []).join('、'))}">
                </div>
                <div class="struct-row">
                    <label class="event-memory-role-field">记忆作用<select class="event-memory-role">${memoryRoleOptions(ev.memoryRole)}</select></label>
                </div>
                <div class="struct-actions"><span>ID：${h(id)}</span></div>
            </div>`;
        }).join('') + '<div style="margin-top:8px"><button type="button" class="btn btn-sm" id="event-add">＋ 新增事件</button></div>');

        es.querySelectorAll('.event-item').forEach(addDeleteHandler);

        $('event-add').onclick = () => {
            let nmax = maxId;
            es.querySelectorAll('.event-item').forEach(it => {
                const m = it.dataset.id?.match(/evt-(\d+)/);
                if (m) nmax = Math.max(nmax, +m[1]);
            });
            const nid = `evt-${nmax + 1}`;
            const div = document.createElement('div');
            div.className = 'struct-item event-item';
            div.dataset.id = nid;
            setHtml(div, `
                <div class="struct-row"><input type="text" class="event-title" placeholder="事件标题"><input type="text" class="event-time" placeholder="时间标签"></div>
                <div class="struct-row"><textarea class="event-summary" rows="2" placeholder="一句话描述"></textarea></div>
                <div class="struct-row"><input type="text" class="event-participants" placeholder="人物（顿号分隔）"></div>
                <div class="struct-row">
                    <label class="event-memory-role-field">记忆作用<select class="event-memory-role">${memoryRoleOptions()}</select></label>
                </div>
                <div class="struct-actions"><span>ID：${h(nid)}</span></div>
            `);
            addDeleteHandler(div);
            es.insertBefore(div, $('event-add').parentElement);
        };
    }

    function renderCharactersEditor(data) {
        const d = data || { main: [], relationships: [] };
        const main = (d.main || []).map(getCharName);
        const rels = d.relationships || [];
        const trendOpts = ['破裂', '厌恶', '反感', '陌生', '投缘', '亲密', '交融'];

        const es = $('editor-struct');
        setHtml(es, `
            <div class="struct-item">
                <div class="struct-row"><strong>角色列表</strong></div>
                <div id="char-main-list">
                    ${(main.length ? main : ['']).map(n => `<div class="struct-row char-main-item"><input type="text" class="char-main-name" placeholder="角色名" value="${h(n || '')}"></div>`).join('')}
                </div>
                <div style="margin-top:8px"><button type="button" class="btn btn-sm" id="char-main-add">＋ 新增角色</button></div>
            </div>
            <div class="struct-item">
                <div class="struct-row"><strong>人物关系</strong></div>
                <div id="char-rel-list">
                    ${(rels.length ? rels : [{ from: '', to: '', label: '', trend: '陌生' }]).map(r => `
                        <div class="struct-row char-rel-item">
                            <input type="text" class="char-rel-from" placeholder="角色 A" value="${h(r.from || '')}">
                            <input type="text" class="char-rel-to" placeholder="角色 B" value="${h(r.to || '')}">
                            <input type="text" class="char-rel-label" placeholder="关系" value="${h(r.label || '')}">
                            <select class="char-rel-trend">${trendOpts.map(t => `<option ${r.trend === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
                        </div>
                    `).join('')}
                </div>
                <div style="margin-top:8px"><button type="button" class="btn btn-sm" id="char-rel-add">＋ 新增关系</button></div>
            </div>
        `);

        es.querySelectorAll('.char-main-item,.char-rel-item').forEach(addDeleteHandler);

        $('char-main-add').onclick = () => {
            const div = document.createElement('div');
            div.className = 'struct-row char-main-item';
            setHtml(div, '<input type="text" class="char-main-name" placeholder="角色名">');
            addDeleteHandler(div);
            $('char-main-list').appendChild(div);
        };

        $('char-rel-add').onclick = () => {
            const div = document.createElement('div');
            div.className = 'struct-row char-rel-item';
            setHtml(div, `
                <input type="text" class="char-rel-from" placeholder="角色 A">
                <input type="text" class="char-rel-to" placeholder="角色 B">
                <input type="text" class="char-rel-label" placeholder="关系">
                <select class="char-rel-trend">${trendOpts.map(t => `<option>${t}</option>`).join('')}</select>
            `);
            addDeleteHandler(div);
            $('char-rel-list').appendChild(div);
        };
    }

    function renderCharacterAliasesEditor(aliases) {
        const list = aliases?.length ? aliases : [{ from: '', to: '', evidence: '' }];
        const es = $('editor-struct');
        const renderItem = alias => `
            <div class="struct-item alias-edit-item">
                <div class="struct-row">
                    <input type="text" class="alias-edit-from" placeholder="别名、称号或译名" value="${h(alias.from || '')}">
                    <input type="text" class="alias-edit-to" placeholder="角色主名" value="${h(alias.to || '')}">
                </div>
                <div class="struct-row">
                    <input type="text" class="alias-edit-evidence" placeholder="确认依据（可选）" value="${h(alias.evidence || '')}">
                </div>
                <div class="struct-actions"><span>别名映射</span></div>
            </div>`;

        setHtml(es, `
            <div id="alias-edit-list">${list.map(renderItem).join('')}</div>
            <div style="margin-top:8px"><button type="button" class="btn btn-sm" id="alias-add">＋ 新增映射</button></div>
        `);
        es.querySelectorAll('.alias-edit-item').forEach(addDeleteHandler);
        $('alias-add').onclick = () => {
            const div = document.createElement('div');
            div.className = 'struct-item alias-edit-item';
            setHtml(div, renderItem({ from: '', to: '', evidence: '' }));
            addDeleteHandler(div);
            $('alias-edit-list').appendChild(div);
        };
    }

    function openEditor(section) {
        currentEditSection = section;
        const summaryData = getSummaryData();
        const meta = SECTION_META[section];
        const es = $('editor-struct');
        const ta = $('editor-ta');

        $('editor-title').textContent = meta.title;
        $('editor-hint').textContent = meta.hint;
        $('editor-err').classList.remove('visible');
        $('editor-err').textContent = '';
        es.classList.add('hidden');
        ta.classList.remove('hidden');

        if (section === 'keywords') {
            ta.value = summaryData.keywords.map(k => `${k.text}|${k.weight || '一般'}`).join('\n');
        } else if (section === 'facts') {
            ta.value = (summaryData.facts || [])
                .filter(f => !f.retracted)
                .map(f => {
                    const parts = [f.s, f.p, f.o];
                    if (f.trend) parts.push(f.trend);
                    return parts.join('|');
                })
                .join('\n');
        } else {
            ta.classList.add('hidden');
            es.classList.remove('hidden');
            if (section === 'events') renderEventsEditor(summaryData.events || []);
            else if (section === 'characters') renderCharactersEditor(summaryData.characters || { main: [], relationships: [] });
            else if (section === 'arcs') renderArcsEditor(summaryData.arcs || []);
            else if (section === 'aliases') renderCharacterAliasesEditor(summaryData.characterAliases || []);
        }

        $('editor-modal').classList.add('active');
        postMsg('EDITOR_OPENED');
    }

    function closeEditor() {
        $('editor-modal').classList.remove('active');
        currentEditSection = null;
        postMsg('EDITOR_CLOSED');
    }

    function saveEditor() {
        const section = currentEditSection;
        const es = $('editor-struct');
        const ta = $('editor-ta');
        const summaryData = getSummaryData();
        let parsed;

        try {
            if (section === 'keywords') {
                const oldMap = new Map((summaryData.keywords || []).map(k => [k.text, k]));
                parsed = ta.value.trim().split('\n').filter(l => l.trim()).map(line => {
                    const [text, weight] = line.split('|').map(s => s.trim());
                    return preserveAddedAt({ text: text || '', weight: weight || '一般' }, oldMap.get(text));
                });
            } else if (section === 'events') {
                const oldMap = new Map((summaryData.events || []).map(e => [e.id, e]));
                parsed = Array.from(es.querySelectorAll('.event-item')).map(it => {
                    const id = it.dataset.id;
                    return preserveAddedAt({
                        id,
                        title: it.querySelector('.event-title').value.trim(),
                        timeLabel: it.querySelector('.event-time').value.trim(),
                        summary: it.querySelector('.event-summary').value.trim(),
                        participants: it.querySelector('.event-participants').value.trim().split(/[,、，]/).map(s => s.trim()).filter(Boolean),
                        memoryRole: it.querySelector('.event-memory-role').value,
                        causedBy: [...(oldMap.get(id)?.causedBy || [])],
                    }, oldMap.get(id));
                }).filter(e => e.title || e.summary);
                parsed = projectEditedSummaryEvents(parsed);
            } else if (section === 'characters') {
                const oldMainMap = new Map((summaryData.characters?.main || []).map(m => [getCharName(m), m]));
                const mainNames = Array.from(es.querySelectorAll('.char-main-name')).map(i => i.value.trim()).filter(Boolean);
                const main = mainNames.map(n => preserveAddedAt({ name: n }, oldMainMap.get(n)));

                const oldRelMap = new Map((summaryData.characters?.relationships || []).map(r => [`${r.from}->${r.to}`, r]));
                const rels = Array.from(es.querySelectorAll('.char-rel-item')).map(it => {
                    const from = it.querySelector('.char-rel-from').value.trim();
                    const to = it.querySelector('.char-rel-to').value.trim();
                    return preserveAddedAt({
                        from, to,
                        label: it.querySelector('.char-rel-label').value.trim(),
                        trend: it.querySelector('.char-rel-trend').value
                    }, oldRelMap.get(`${from}->${to}`));
                }).filter(r => r.from && r.to);

                parsed = { main, relationships: rels };
            } else if (section === 'arcs') {
                const oldArcMap = new Map((summaryData.arcs || []).map(a => [a.name, a]));
                parsed = Array.from(es.querySelectorAll('.arc-item')).map(it => {
                    const name = it.querySelector('.arc-name').value.trim();
                    const oldArc = oldArcMap.get(name);
                    const oldMomentMap = new Map((oldArc?.moments || []).map(m => [typeof m === 'string' ? m : m.text, m]));
                    const momentsRaw = it.querySelector('.arc-moments').value.trim();
                    const moments = momentsRaw ? momentsRaw.split('\n').map(s => s.trim()).filter(Boolean).map(t => preserveAddedAt({ text: t }, oldMomentMap.get(t))) : [];
                    return preserveAddedAt({
                        name,
                        trajectory: it.querySelector('.arc-trajectory').value.trim(),
                        progress: Math.max(0, Math.min(1, (parseFloat(it.querySelector('.arc-progress').value) || 0) / 100)),
                        moments
                    }, oldArc);
                }).filter(a => a.name || a.trajectory || a.moments?.length);
            } else if (section === 'facts') {
                const oldMap = new Map((summaryData.facts || []).map(f => [`${f.s}::${f.p}`, f]));
                parsed = ta.value
                    .split('\n')
                    .map(l => l.trim())
                    .filter(Boolean)
                    .map(line => {
                        const parts = line.split('|').map(s => s.trim());
                        const s = parts[0];
                        const p = parts[1];
                        const o = parts[2];
                        const trend = parts[3];
                        if (!s || !p) return null;
                        if (!o) return null;
                        const key = `${s}::${p}`;
                        const old = oldMap.get(key);
                        const fact = {
                            id: old?.id || `f-${Date.now()}`,
                            s, p, o,
                            since: old?.since ?? 0,
                            _addedAt: old?._addedAt ?? 0,
                        };
                        if (/^对.+的/.test(p) && trend) {
                            fact.trend = trend;
                        }
                        return fact;
                    })
                    .filter(Boolean);
            } else if (section === 'aliases') {
                parsed = Array.from(es.querySelectorAll('.alias-edit-item')).map(item => ({
                    from: item.querySelector('.alias-edit-from').value.trim(),
                    to: item.querySelector('.alias-edit-to').value.trim(),
                    evidence: item.querySelector('.alias-edit-evidence').value.trim(),
                })).filter(alias => alias.from || alias.to || alias.evidence);
                if (parsed.some(alias => !alias.from || !alias.to)) {
                    throw new Error('每条映射都要填写别名和角色主名');
                }
            }
        } catch (e) {
            $('editor-err').textContent = `格式错误: ${e.message}`;
            $('editor-err').classList.add('visible');
            return;
        }

        return { section, data: parsed };
    }
    function bind() {
        $$('.sec-btn[data-section]').forEach(b => b.onclick = () => openEditor(b.dataset.section));
        $('editor-backdrop').onclick = closeEditor;
        $('editor-close').onclick = closeEditor;
        $('editor-cancel').onclick = closeEditor;
    }

    return { bind, closeEditor, saveEditor };
}
