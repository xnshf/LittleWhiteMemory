// Relation graph and character profile for the story-summary iframe.

const TREND_COLORS = {
    '破裂': '#444444', '厌恶': '#8b0000', '反感': '#cd5c5c',
    '陌生': '#888888', '投缘': '#4a9a7e', '亲密': '#d87a7a', '交融': '#c71585'
};

const TREND_CLASS = {
    '破裂': 'trend-broken', '厌恶': 'trend-hate', '反感': 'trend-dislike',
    '陌生': 'trend-stranger', '投缘': 'trend-click', '亲密': 'trend-close', '交融': 'trend-merge'
};

function getCssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function getRelationTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
        text: getCssVar('--txt', isDark ? '#e0e0e0' : '#333'),
        textMuted: getCssVar('--txt3', isDark ? '#9a9a9a' : '#888'),
        panel: getCssVar('--bg2', isDark ? '#1e1e1e' : '#fff'),
        border: getCssVar('--bdr', isDark ? '#3a3a3a' : '#ddd'),
        line: getCssVar('--bdr', isDark ? 'rgba(224,224,224,.32)' : '#d8d8d8'),
        lineFocus: getCssVar('--txt3', isDark ? 'rgba(224,224,224,.58)' : '#aaa'),
        nodeBorder: isDark ? getCssVar('--bg', '#121212') : '#fff',
        nodeShadow: isDark ? 'rgba(0,0,0,.38)' : 'rgba(0,0,0,.1)',
        tooltipShadow: isDark ? '0 8px 22px rgba(0,0,0,.38)' : '0 4px 12px rgba(0,0,0,.15)',
    };
}

export function getCharName(c) {
    return typeof c === 'string' ? c : c.name;
}

export function buildRelationGraph(data, theme) {
    const rels = data?.relationships || [];
    const allNames = new Set((data?.main || []).map(getCharName));
    rels.forEach(r => { if (r.from) allNames.add(r.from); if (r.to) allNames.add(r.to); });

    const degrees = {};
    rels.forEach(r => {
        degrees[r.from] = (degrees[r.from] || 0) + 1;
        degrees[r.to] = (degrees[r.to] || 0) + 1;
    });

    const nodeColors = { main: '#d87a7a', sec: '#f1c3c3', ter: '#888888', qua: '#b8b8b8' };
    const sortedDegs = Object.values(degrees).sort((a, b) => b - a);
    const getPercentile = deg => {
        if (!sortedDegs.length || deg === 0) return 100;
        const rank = sortedDegs.filter(d => d > deg).length;
        return (rank / sortedDegs.length) * 100;
    };

    const nodes = Array.from(allNames).map(name => {
        const deg = degrees[name] || 0;
        const pct = getPercentile(deg);
        let col, fontWeight;
        if (pct < 30) { col = nodeColors.main; fontWeight = '600'; }
        else if (pct < 60) { col = nodeColors.sec; fontWeight = '500'; }
        else if (pct < 90) { col = nodeColors.ter; fontWeight = '400'; }
        else { col = nodeColors.qua; fontWeight = '400'; }
        return {
            id: name, name, symbol: 'circle',
            symbolSize: Math.min(36, Math.max(16, deg * 3 + 12)),
            draggable: true,
            itemStyle: { color: col, borderColor: theme.nodeBorder, borderWidth: 2, shadowColor: theme.nodeShadow, shadowBlur: 6, shadowOffsetY: 2 },
            label: { show: true, position: 'right', distance: 5, color: theme.text, fontSize: 11, fontWeight },
            degree: deg
        };
    });

    const relMap = new Map();
    rels.forEach(r => {
        const k = [r.from, r.to].sort().join('|||');
        if (!relMap.has(k)) relMap.set(k, { from: r.from, to: r.to, fromLabel: '', toLabel: '', fromTrend: '', toTrend: '' });
        const e = relMap.get(k);
        if (r.from === e.from) { e.fromLabel = r.label || r.type || ''; e.fromTrend = r.trend || ''; }
        else { e.toLabel = r.label || r.type || ''; e.toTrend = r.trend || ''; }
    });

    const links = Array.from(relMap.values()).map(r => {
        const fc = TREND_COLORS[r.fromTrend] || '#b8b8b8';
        const tc = TREND_COLORS[r.toTrend] || '#b8b8b8';
        return {
            source: r.from, target: r.to, fromName: r.from, toName: r.to,
            fromLabel: r.fromLabel, toLabel: r.toLabel, fromTrend: r.fromTrend, toTrend: r.toTrend,
            lineStyle: { width: 1, color: theme.line, curveness: 0, opacity: 1 },
            label: {
                show: true, position: 'middle', distance: 0,
                formatter: '{a|◀}{b|▶}',
                rich: { a: { color: fc, fontSize: 10 }, b: { color: tc, fontSize: 10 } },
                align: 'center', verticalAlign: 'middle', offset: [0, -0.1]
            },
            emphasis: { lineStyle: { width: 1.5, color: theme.lineFocus }, label: { fontSize: 11 } }
        };
    });

    return { nodes, links };
}

export function createRelationUI({ $, h, setHtml, postMsg, initChart }) {
    let relationChart = null;
    let relationChartFullscreen = null;
    let currentCharacterId = null;
    let allNodes = [];
    let allLinks = [];
    let activeRelationTooltip = null;
    let characters = { main: [], relationships: [] };
    let characterArcs = [];
    let zrClickHandler = null;

    function hideRelationTooltip() {
        if (activeRelationTooltip) {
            activeRelationTooltip.remove();
            activeRelationTooltip = null;
        }
    }

    function showRelationTooltip(from, to, fromLabel, toLabel, fromTrend, toTrend, x, y, container) {
        hideRelationTooltip();
        const tip = document.createElement('div');
        const mobile = innerWidth <= 768;
        const fc = TREND_COLORS[fromTrend] || '#888';
        const tc = TREND_COLORS[toTrend] || '#888';
        const theme = getRelationTheme();

        setHtml(tip, `<div style="line-height:1.8">
            ${fromLabel ? `<div><small>${h(from)}→${h(to)}：</small> <span style="color:${fc}">${h(fromLabel)}</span> <span style="font-size:10px;color:${fc}">[${h(fromTrend)}]</span></div>` : ''}
            ${toLabel ? `<div><small>${h(to)}→${h(from)}：</small> <span style="color:${tc}">${h(toLabel)}</span> <span style="font-size:10px;color:${tc}">[${h(toTrend)}]</span></div>` : ''}
        </div>`);

        tip.style.cssText = mobile
            ? `position:absolute;left:8px;bottom:8px;background:${theme.panel};color:${theme.text};padding:10px 14px;border:1px solid ${theme.border};border-radius:6px;font-size:12px;z-index:100;box-shadow:${theme.tooltipShadow};max-width:calc(100% - 16px)`
            : `position:absolute;left:${Math.max(80, Math.min(x, container.clientWidth - 80))}px;top:${Math.max(60, y)}px;transform:translate(-50%,-100%);background:${theme.panel};color:${theme.text};padding:10px 16px;border:1px solid ${theme.border};border-radius:6px;font-size:12px;z-index:1000;box-shadow:${theme.tooltipShadow};max-width:280px`;

        container.style.position = 'relative';
        container.appendChild(tip);
        activeRelationTooltip = tip;
    }

    function renderRelations(data) {
        characters = data || { main: [], relationships: [] };
        const dom = $('relation-chart');
        if (!relationChart) relationChart = initChart(dom);
        const theme = getRelationTheme();

        ({ nodes: allNodes, links: allLinks } = buildRelationGraph(data, theme));

        if (zrClickHandler) relationChart.getZr().off('click', zrClickHandler);
        zrClickHandler = null;
        relationChart.off('click');
        if (!allNodes.length) {
            hideRelationTooltip();
            relationChart.clear();
            return;
        }

        const updateChart = (nodes, links, focusId = null) => {
            const fadeOpacity = 0.2;
            const processedNodes = focusId ? nodes.map(n => {
                const rl = links.filter(l => l.source === focusId || l.target === focusId);
                const rn = new Set([focusId]);
                rl.forEach(l => { rn.add(l.source); rn.add(l.target); });
                const isRelated = rn.has(n.id);
                return { ...n, itemStyle: { ...n.itemStyle, opacity: isRelated ? 1 : fadeOpacity }, label: { ...n.label, opacity: isRelated ? 1 : fadeOpacity } };
            }) : nodes;

            const processedLinks = focusId ? links.map(l => {
                const isRelated = l.source === focusId || l.target === focusId;
                return { ...l, lineStyle: { ...l.lineStyle, opacity: isRelated ? 1 : fadeOpacity }, label: { ...l.label, opacity: isRelated ? 1 : fadeOpacity } };
            }) : links;

            relationChart.setOption({
                backgroundColor: 'transparent',
                tooltip: { show: false },
                hoverLayerThreshold: Infinity,
                series: [{
                    type: 'graph', layout: 'force', roam: true, draggable: true,
                    animation: true, animationDuration: 800, animationDurationUpdate: 300, animationEasingUpdate: 'cubicInOut',
                    progressive: 0, hoverAnimation: false,
                    data: processedNodes, links: processedLinks,
                    force: { initLayout: 'circular', repulsion: 350, edgeLength: [80, 160], gravity: .12, friction: .6, layoutAnimation: true },
                    label: { show: true }, edgeLabel: { show: true, position: 'middle' },
                    emphasis: { disabled: true }
                }]
            });
        };

        updateChart(allNodes, allLinks);
        setTimeout(() => relationChart.resize(), 0);

        relationChart.on('click', p => {
            if (p.dataType === 'node') {
                hideRelationTooltip();
                const id = p.data.id;
                selectCharacter(id);
                updateChart(allNodes, allLinks, id);
            } else if (p.dataType === 'edge') {
                const d = p.data;
                const e = p.event?.event;
                if (e) {
                    const rect = dom.getBoundingClientRect();
                    showRelationTooltip(d.fromName, d.toName, d.fromLabel, d.toLabel, d.fromTrend, d.toTrend,
                        e.offsetX || (e.clientX - rect.left), e.offsetY || (e.clientY - rect.top), dom);
                }
            }
        });

        zrClickHandler = p => {
            if (!p.target) {
                hideRelationTooltip();
                updateChart(allNodes, allLinks);
            }
        };
        relationChart.getZr().on('click', zrClickHandler);
    }

    function selectCharacter(id) {
        currentCharacterId = id;
        const txt = $('sel-char-text');
        const opts = $('char-sel-opts');
        if (opts && id) {
            opts.querySelectorAll('.sel-opt').forEach(o => {
                if (o.dataset.value === id) {
                    o.classList.add('sel');
                    if (txt) txt.textContent = o.textContent;
                } else {
                    o.classList.remove('sel');
                }
            });
        } else if (!id && txt) {
            txt.textContent = '选择角色';
        }
        renderCharacterProfile();
        if (relationChart && id) {
            const opt = relationChart.getOption();
            const idx = opt?.series?.[0]?.data?.findIndex(n => n.id === id || n.name === id);
            if (idx >= 0) relationChart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: idx });
        }
    }

    function updateCharacterSelector(arcs) {
        const opts = $('char-sel-opts');
        const txt = $('sel-char-text');
        if (!opts) return;
        if (!arcs?.length) {
            setHtml(opts, '<div class="sel-opt" data-value="">暂无角色</div>');
            if (txt) txt.textContent = '暂无角色';
            currentCharacterId = null;
            return;
        }
        setHtml(opts, arcs.map(a => `<div class="sel-opt" data-value="${h(a.id || a.name)}">${h(a.name || '角色')}</div>`).join(''));
        opts.querySelectorAll('.sel-opt').forEach(o => {
            o.onclick = e => {
                e.stopPropagation();
                if (o.dataset.value) {
                    selectCharacter(o.dataset.value);
                    $('char-sel').classList.remove('open');
                }
            };
        });
        if (currentCharacterId && arcs.some(a => (a.id || a.name) === currentCharacterId)) {
            selectCharacter(currentCharacterId);
        } else if (arcs.length) {
            selectCharacter(arcs[0].id || arcs[0].name);
        }
    }

    function renderCharacterProfile() {
        const c = $('profile-content');
        const arcs = characterArcs || [];
        const rels = characters?.relationships || [];

        if (!currentCharacterId || !arcs.length) {
            setHtml(c, '<div class="empty">暂无角色数据</div>');
            return;
        }

        const arc = arcs.find(a => (a.id || a.name) === currentCharacterId);
        if (!arc) {
            setHtml(c, '<div class="empty">未找到角色数据</div>');
            return;
        }

        const name = arc.name || '角色';
        const moments = (arc.moments || arc.beats || []).map(m => typeof m === 'string' ? m : m.text);
        const outRels = rels.filter(r => r.from === name);
        const inRels = rels.filter(r => r.to === name);

        setHtml(c, `
            <div class="prof-arc">
                <div>
                    <div class="prof-name">${h(name)}</div>
                    <div class="prof-traj">${h(arc.trajectory || arc.phase || '')}</div>
                </div>
                <div class="prof-prog-wrap">
                    <div class="prof-prog-lbl">
                        <span>弧光进度</span>
                        <span>${Math.round((arc.progress || 0) * 100)}%</span>
                    </div>
                    <div class="prof-prog">
                        <div class="prof-prog-inner" style="width:${(arc.progress || 0) * 100}%"></div>
                    </div>
                </div>
                ${moments.length ? `
                    <div class="prof-moments">
                        <div class="prof-moments-title">关键时刻</div>
                        ${moments.map(m => `<div class="prof-moment">${h(m)}</div>`).join('')}
                    </div>
                ` : ''}
            </div>
            <div class="prof-rels">
                <div class="rels-group">
                    <div class="rels-group-title">${h(name)}对别人的羁绊：</div>
                    ${outRels.length ? outRels.map(r => `
                        <div class="rel-item">
                            <span class="rel-target">对${h(r.to)}：</span>
                            <span class="rel-label">${h(r.label || '—')}</span>
                            ${r.trend ? `<span class="rel-trend ${TREND_CLASS[r.trend] || ''}">${h(r.trend)}</span>` : ''}
                        </div>
                    `).join('') : '<div class="empty" style="padding:16px">暂无关系记录</div>'}
                </div>
                <div class="rels-group">
                    <div class="rels-group-title">别人对${h(name)}的羁绊：</div>
                    ${inRels.length ? inRels.map(r => `
                        <div class="rel-item">
                            <span class="rel-target">${h(r.from)}：</span>
                            <span class="rel-label">${h(r.label || '—')}</span>
                            ${r.trend ? `<span class="rel-trend ${TREND_CLASS[r.trend] || ''}">${h(r.trend)}</span>` : ''}
                        </div>
                    `).join('') : '<div class="empty" style="padding:16px">暂无关系记录</div>'}
                </div>
            </div>
        `);
    }

    function renderArcs(arcs) {
        characterArcs = arcs || [];
        updateCharacterSelector(arcs || []);
        renderCharacterProfile();
    }

    function openRelationsFullscreen() {
        $('rel-fs-modal').classList.add('active');
        const dom = $('relation-chart-fullscreen');
        if (!relationChartFullscreen) relationChartFullscreen = initChart(dom);

        if (!allNodes.length) {
            relationChartFullscreen.clear();
            return;
        }

        relationChartFullscreen.setOption({
            tooltip: { show: false },
            hoverLayerThreshold: Infinity,
            series: [{
                type: 'graph', layout: 'force', roam: true, draggable: true,
                animation: true, animationDuration: 800, animationDurationUpdate: 300, animationEasingUpdate: 'cubicInOut',
                progressive: 0, hoverAnimation: false,
                data: allNodes.map(n => ({
                    ...n,
                    symbolSize: Array.isArray(n.symbolSize) ? [n.symbolSize[0] * 1.3, n.symbolSize[1] * 1.3] : n.symbolSize * 1.3,
                    label: { ...n.label, fontSize: 14 }
                })),
                links: allLinks.map(l => ({ ...l, label: { ...l.label, fontSize: 18 } })),
                force: { repulsion: 700, edgeLength: [150, 280], gravity: .06, friction: .6, layoutAnimation: true },
                label: { show: true }, edgeLabel: { show: true, position: 'middle' },
                emphasis: { disabled: true }
            }]
        });

        setTimeout(() => relationChartFullscreen.resize(), 100);
        postMsg('FULLSCREEN_OPENED');
    }

    function closeRelationsFullscreen() {
        $('rel-fs-modal').classList.remove('active');
        postMsg('FULLSCREEN_CLOSED');
    }

    function resize() {
        relationChart?.resize();
        relationChartFullscreen?.resize();
    }

    return {
        renderRelations, renderArcs, hideRelationTooltip,
        openRelationsFullscreen, closeRelationsFullscreen, resize,
        hasRelationChart: () => !!relationChart,
    };
}
