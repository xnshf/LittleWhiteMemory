import { VECTOR_API_DEFAULT_MODELS, createDefaultProviderProfile, normalizeProviderProfiles } from './provider-config.js';

// Owns action-button wiring and transient progress state; the panel coordinator owns messaging.
export function createVectorActionsUI({ config, getElement, postMsg, showConfirm, setStatusText,
    saveConfig, syncVectorBoundaryControl, saveCurrentVectorApiProfile, updateVectorProviderUI,
    fetchVectorModels, saveVectorApiSection, getVectorConfig, addFilterRule }) {
    const $ = getElement;
    let anchorGenerating = false;
    let vectorGenerating = false;
    const isBusy = () => anchorGenerating || vectorGenerating;

    function updateVectorStats(stats) {
        $('vector-atom-count').textContent = stats.stateVectors || 0;
        $('vector-chunk-count').textContent = stats.chunkCount || 0;
        $('vector-event-count').textContent = stats.eventVectors || 0;
    }

    function showVectorMismatchWarning(show) {
        $('vector-mismatch-warning').classList.toggle('hidden', !show);
    }

    function updateAnchorStats(stats) {
        const extracted = stats.extracted || 0;
        const total = stats.total || 0;
        const pending = stats.pending || 0;
        const empty = stats.empty || 0;
        const fail = stats.fail || 0;
        const atomsCount = stats.atomsCount || 0;

        $('anchor-extracted').textContent = extracted;
        $('anchor-total').textContent = total;
        $('anchor-pending').textContent = pending;
        $('anchor-atoms-count').textContent = atomsCount;

        const pendingWrap = $('anchor-pending-wrap');
        if (pendingWrap) pendingWrap.classList.toggle('hidden', pending === 0);

        const extraWrap = $('anchor-extra-wrap');
        const extraSep = $('anchor-extra-sep');
        const extra = $('anchor-extra');
        if (extraWrap && extra) {
            if (empty > 0 || fail > 0) {
                const parts = [];
                if (empty > 0) parts.push(`空 ${empty}`);
                if (fail > 0) parts.push(`失败 ${fail}`);
                extra.textContent = parts.join(' · ');
                extraWrap.style.display = '';
                if (extraSep) extraSep.style.display = '';
            } else {
                extraWrap.style.display = 'none';
                if (extraSep) extraSep.style.display = 'none';
            }
        }
        const emptyWarning = $('vector-empty-l0-warning');
        if (emptyWarning) emptyWarning.classList.toggle('hidden', extracted > 0);
    }

    function syncMemoryActionButtons() {
        for (const id of ['btn-anchor-generate', 'btn-anchor-clear', 'btn-repair-vectors', 'btn-gen-vectors', 'btn-clear-vectors']) {
            $(id).disabled = isBusy();
        }
    }

    function updateAnchorProgress(current, total, message) {
        const progress = $('anchor-progress');
        const btnGen = $('btn-anchor-generate');
        const btnClear = $('btn-anchor-clear');
        const btnCancel = $('btn-anchor-cancel');
        if (current < 0) {
            progress.classList.add('hidden');
            btnGen.classList.remove('hidden');
            btnClear.classList.remove('hidden');
            btnCancel.classList.add('hidden');
            anchorGenerating = false;
            btnCancel.disabled = false;
            btnCancel.textContent = '取消';
        } else {
            anchorGenerating = true;
            progress.classList.remove('hidden');
            btnGen.classList.add('hidden');
            btnClear.classList.add('hidden');
            btnCancel.classList.remove('hidden');
            const percent = total > 0 ? Math.round(current / total * 100) : 0;
            progress.querySelector('.progress-inner').style.width = percent + '%';
            progress.querySelector('.progress-text').textContent = message || `${current}/${total}`;
        }
        syncMemoryActionButtons();
    }

    function updateVectorProgress({ current, total, phase, message }) {
        const progress = $('vector-gen-progress');
        vectorGenerating = current >= 0;
        progress.classList.toggle('hidden', !vectorGenerating);
        for (const id of ['btn-repair-vectors', 'btn-gen-vectors', 'btn-clear-vectors']) {
            $(id).classList.toggle('hidden', vectorGenerating);
        }
        const cancel = $('btn-cancel-vectors');
        cancel.classList.toggle('hidden', !vectorGenerating);
        if (!vectorGenerating) {
            cancel.disabled = false;
            cancel.textContent = '取消';
        } else {
            progress.querySelector('.progress-inner').style.width = (total > 0 ? Math.round(current / total * 100) : 0) + '%';
            progress.querySelector('.progress-text').textContent = message || `${phase || ''}: ${current}/${total}`;
        }
        syncMemoryActionButtons();
    }

    function initAnchorUI() {
        $('btn-anchor-generate').onclick = () => {
            if (isBusy()) return;
            updateAnchorProgress(0, 0, '检查锚点缺漏...');
            postMsg('ANCHOR_GENERATE');
        };
        $('btn-anchor-clear').onclick = async () => {
            if (isBusy()) return;
            if (await showConfirm('清空锚点', '清空所有记忆锚点？（L0 向量也会一并清除）')) {
                postMsg('ANCHOR_CLEAR');
            }
        };
        $('btn-anchor-cancel').onclick = () => {
            $('btn-anchor-cancel').disabled = true;
            $('btn-anchor-cancel').textContent = '停止中...';
            postMsg('ANCHOR_CANCEL');
        };
    }

    function initVectorUI() {
        $('vector-enabled').onchange = e => {
            $('vector-config-area').classList.toggle('hidden', !e.target.checked);
            syncVectorBoundaryControl(e.target.checked, config.ui.hideSummarized);
        };
        syncVectorBoundaryControl(config.vector?.enabled, config.ui.hideSummarized);
        ['l0', 'embedding', 'rerank'].forEach(prefix => {
            $(`${prefix}-api-key-toggle`).onclick = () => {
                const input = $(`${prefix}-api-key`);
                const btn = $(`${prefix}-api-key-toggle`);
                if (!input || !btn) return;
                const show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                btn.textContent = show ? '隐藏' : '显示';
            };
            $(`${prefix}-api-provider`).onchange = e => {
                const target = config.vector[`${prefix}Api`] ||= {};
                const previousProvider = target.provider || 'siliconflow';
                saveCurrentVectorApiProfile(prefix, previousProvider);
                target.providers = normalizeProviderProfiles(prefix, target);
                target.provider = e.target.value;
                target.providers[e.target.value] ||= createDefaultProviderProfile(e.target.value, VECTOR_API_DEFAULT_MODELS[prefix]);
                updateVectorProviderUI(prefix, e.target.value);
            };
            $(`${prefix}-api-model-select`).onchange = e => {
                if (e.target.value) $(`${prefix}-api-model-text`).value = e.target.value;
            };
            $(`${prefix}-btn-connect`).onclick = () => fetchVectorModels(prefix);
            $(`${prefix}-btn-save`).onclick = () => saveVectorApiSection(prefix);
            $(`${prefix}-btn-test`).onclick = () => {
                const btn = $(`${prefix}-btn-test`);
                if (btn) btn.disabled = true;
                setStatusText($(`${prefix}-api-connect-status`), '测试中...', 'loading');
                saveConfig();
                const cfg = getVectorConfig();
                postMsg('VECTOR_TEST_ONLINE', {
                    target: prefix,
                    provider: cfg[`${prefix}Api`].provider,
                    config: cfg[`${prefix}Api`],
                });
            };
        });
        $('btn-add-filter-rule').onclick = addFilterRule;
        $('btn-gen-vectors').onclick = () => {
            if (isBusy()) return;
            updateVectorProgress({ current: 0, total: 0, message: '准备重建向量...' });
            postMsg('VECTOR_GENERATE', { config: getVectorConfig() });
        };
        $('btn-repair-vectors').onclick = () => {
            if (isBusy()) return;
            updateVectorProgress({ current: 0, total: 0, message: '检查向量缺漏...' });
            postMsg('VECTOR_REPAIR', { config: getVectorConfig() });
        };
        $('btn-clear-vectors').onclick = async () => {
            if (isBusy()) return;
            if (await showConfirm('清空向量', '确定清空所有向量数据？')) postMsg('VECTOR_CLEAR');
        };
        $('btn-cancel-vectors').onclick = () => {
            $('btn-cancel-vectors').disabled = true;
            $('btn-cancel-vectors').textContent = '停止中...';
            postMsg('VECTOR_CANCEL_GENERATE');
        };
        $('btn-export-vectors').onclick = () => {
            $('btn-export-vectors').disabled = true;
            $('vector-io-status').textContent = '导出中...';
            postMsg('VECTOR_EXPORT');
        };
        $('btn-import-vectors').onclick = () => {
            $('btn-import-vectors').disabled = true;
            $('vector-io-status').textContent = '导入中...';
            postMsg('VECTOR_IMPORT_PICK');
        };
        $('btn-backup-server').onclick = () => {
            $('btn-backup-server').disabled = true;
            $('server-io-status').textContent = '备份中...';
            postMsg('VECTOR_BACKUP_SERVER');
        };
        $('btn-restore-server').onclick = () => {
            $('btn-restore-server').disabled = true;
            $('server-io-status').textContent = '恢复中...';
            postMsg('VECTOR_RESTORE_SERVER');
        };
        $('btn-manage-backups').onclick = () => postMsg('VECTOR_LIST_BACKUPS');
        initAnchorUI();
        postMsg('REQUEST_ANCHOR_STATS');
    }

    function updateVectorOnlineStatus(target, status, message) {
        const prefix = target || 'embedding';
        const btn = $(`${prefix}-btn-test`);
        if (btn) btn.disabled = false;
        setStatusText($(`${prefix}-api-connect-status`), message || '',
            status === 'error' ? 'error' : status === 'success' ? 'success' : 'loading');
    }

    function handleExportResult(d) {
        $('btn-export-vectors').disabled = false;
        if (d.success) {
            $('vector-io-status').textContent = `导出成功: ${d.filename} (${(d.size / 1024 / 1024).toFixed(2)}MB)`;
        } else {
            $('vector-io-status').textContent = '导出失败: ' + (d.error || '未知错误');
        }
    }

    function handleImportResult(d) {
        $('btn-import-vectors').disabled = false;
        if (d.success) {
            let msg = `导入成功: ${d.chunkCount} 片段, ${d.eventCount} 事件`;
            if (d.warnings?.length) {
                msg += '\n⚠️ ' + d.warnings.join('\n⚠️ ');
            }
            $('vector-io-status').textContent = msg;
            // 刷新统计
            postMsg('REQUEST_VECTOR_STATS');
        } else {
            $('vector-io-status').textContent = '导入失败: ' + (d.error || '未知错误');
        }
    }

    function handleBackupResult(d) {
        $('btn-backup-server').disabled = false;
        if (d.success) {
            $('server-io-status').textContent = `☁️ 备份成功: ${(d.size / 1024 / 1024).toFixed(2)}MB (${d.chunkCount} 片段, ${d.eventCount} 事件)`;
        } else {
            $('server-io-status').textContent = '备份失败: ' + (d.error || '未知错误');
        }
    }

    function handleRestoreResult(d) {
        $('btn-restore-server').disabled = false;
        if (d.success) {
            let msg = `☁️ 恢复成功: ${d.chunkCount} 片段, ${d.eventCount} 事件`;
            if (d.warnings?.length) {
                msg += '\n⚠️ ' + d.warnings.join('\n⚠️ ');
            }
            $('server-io-status').textContent = msg;
            postMsg('REQUEST_VECTOR_STATS');
        } else {
            $('server-io-status').textContent = '恢复失败: ' + (d.error || '未知错误');
        }
    }

    return { isBusy, initVectorUI, updateVectorStats, showVectorMismatchWarning,
        updateAnchorStats, updateAnchorProgress, updateVectorProgress, updateVectorOnlineStatus,
        handleExportResult, handleImportResult, handleBackupResult, handleRestoreResult };
}
