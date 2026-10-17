// 备份管理 Modal（渲染在父窗口，确保层级在 settings modal 之上）
export function createBackupManagerModal({ fetchManifest, deleteServerBackup, isDeleteUnsupportedError }) {
    let backupDeleteSupported = true;
    let backupDeleteUnsupportedReason = '';
    let backupManagerCleanup = null;

    function removeBackupManagerModal() {
        backupManagerCleanup?.();
        backupManagerCleanup = null;
        document.getElementById('lwb-backup-manager-modal')?.remove();
    }

    function showBackupManagerModal(initialFiles) {
        removeBackupManagerModal();
        const isNarrowViewport = window.matchMedia?.('(max-width: 640px)').matches || window.innerWidth <= 640;

        const overlay = document.createElement('div');
        overlay.id = 'lwb-backup-manager-modal';
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'background:rgba(0,0,0,.55)',
            'z-index:100000', 'display:flex', 'align-items:center', 'justify-content:center',
            'box-sizing:border-box', `padding:${isNarrowViewport ? '10px' : '16px'}`,
            'overflow:hidden',
        ].join(';');

        const viewport = window.visualViewport;
        const syncOverlayToViewport = () => {
            if (!viewport) return;
            overlay.style.inset = 'auto';
            overlay.style.left = `${viewport.offsetLeft}px`;
            overlay.style.top = `${viewport.offsetTop}px`;
            overlay.style.width = `${viewport.width}px`;
            overlay.style.height = `${viewport.height}px`;
        };
        if (viewport) {
            syncOverlayToViewport();
            viewport.addEventListener('resize', syncOverlayToViewport);
            viewport.addEventListener('scroll', syncOverlayToViewport);
            backupManagerCleanup = () => {
                viewport.removeEventListener('resize', syncOverlayToViewport);
                viewport.removeEventListener('scroll', syncOverlayToViewport);
            };
        }

        const box = document.createElement('div');
        box.style.cssText = [
            'background:#fff', 'color:#222', 'border-radius:8px',
            `width:${isNarrowViewport ? '100%' : 'min(520px,92vw)'}`,
            `padding:${isNarrowViewport ? '12px' : '18px'}`,
            `max-height:${isNarrowViewport ? 'calc(100dvh - 20px)' : '80vh'}`,
            'box-sizing:border-box', 'display:flex', 'flex-direction:column',
            'overflow:hidden',
            'box-shadow:0 8px 32px rgba(0,0,0,.35)', 'font-size:14px',
        ].join(';');

        // Header
        const header = document.createElement('div');
        header.style.cssText = [
            'display:flex', 'justify-content:space-between', 'align-items:center',
            'gap:8px', 'margin-bottom:10px', 'flex-shrink:0',
        ].join(';');
        const title = document.createElement('span');
        title.style.cssText = 'font-weight:700;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        title.textContent = '服务器向量备份';
        const badge = document.createElement('span');
        badge.id = 'lwb-backup-badge';
        badge.style.cssText = 'opacity:0.5;font-size:0.85em;margin-left:4px';
        title.appendChild(badge);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:6px';

        const btnRefresh = document.createElement('button');
        btnRefresh.className = 'btn btn-sm';
        btnRefresh.textContent = '刷新';

        const btnClose = document.createElement('button');
        btnClose.className = 'btn btn-sm';
        btnClose.textContent = '✕';
        btnClose.onclick = removeBackupManagerModal;

        btnRow.append(btnRefresh, btnClose);
        header.append(title, btnRow);

        // List area
        const listEl = document.createElement('div');
        listEl.id = 'lwb-backup-list';
        listEl.style.cssText = 'overflow-y:auto;overflow-x:hidden;flex:1;min-height:60px;-webkit-overflow-scrolling:touch';

        // Status bar
        const statusEl = document.createElement('div');
        statusEl.id = 'lwb-backup-status';
        statusEl.style.cssText = 'margin-top:8px;font-size:0.82em;color:#666;min-height:1em;flex-shrink:0;word-break:break-word';

        box.append(header, listEl, statusEl);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // Close on backdrop click
        overlay.addEventListener('click', e => { if (e.target === overlay) removeBackupManagerModal(); });

        function setStatus(text, isError) {
            statusEl.textContent = text;
            statusEl.style.color = isError ? '#c00' : '#666';
        }

        function renderList(files) {
            badge.textContent = `(${files.length})`;
            if (!files.length) {
                listEl.innerHTML = '<div style="padding:12px;opacity:0.5;text-align:center">暂无备份记录</div>';
                return;
            }
            const sorted = [...files].sort((a, b) => new Date(b.backupTime) - new Date(a.backupTime));
            listEl.replaceChildren();
            sorted.forEach(f => {
                const row = document.createElement('div');
                row.style.cssText = isNarrowViewport
                    ? [
                        'display:grid', 'grid-template-columns:1fr auto', 'gap:4px 8px',
                        'align-items:center', 'padding:8px 2px',
                        'border-bottom:1px solid #e8e8e8', 'font-size:0.82em',
                    ].join(';')
                    : [
                        'display:flex', 'gap:8px', 'align-items:center', 'padding:6px 2px',
                        'border-bottom:1px solid #e8e8e8', 'font-size:0.82em',
                    ].join(';');

                const label = document.createElement('span');
                label.style.cssText = isNarrowViewport
                    ? 'grid-column:1 / -1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#333'
                    : 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#333';
                label.title = f.chatId || f.filename;
                label.textContent = f.chatId || f.filename;

                const size = document.createElement('span');
                size.style.cssText = 'white-space:nowrap;color:#555';
                size.textContent = f.size ? (f.size / 1024 / 1024).toFixed(2) + 'MB' : '?';

                const time = document.createElement('span');
                time.style.cssText = isNarrowViewport
                    ? 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#888'
                    : 'white-space:nowrap;color:#888';
                time.textContent = f.backupTime ? new Date(f.backupTime).toLocaleString() : '?';

                const btnDel = document.createElement('button');
                btnDel.className = 'btn btn-sm';
                btnDel.style.cssText = 'padding:1px 10px;flex-shrink:0;color:#c00;border-color:#c00';
                btnDel.textContent = '删';
                btnDel.onclick = async () => {
                    if (!confirm(`确认删除此备份？\n${f.filename}`)) return;
                    setStatus('删除中...');
                    btnDel.disabled = true;
                    try {
                        await deleteServerBackup(f.filename, f.serverPath);
                        setStatus('已删除');
                        const updated = await fetchManifest();
                        renderList(updated);
                    } catch (e) {
                        if (isDeleteUnsupportedError(e)) {
                            backupDeleteSupported = false;
                            backupDeleteUnsupportedReason = e.message || '宿主不支持删除接口';
                            setStatus('⚠️ 只读模式：' + backupDeleteUnsupportedReason, true);
                            // 禁用所有删除按钮
                            listEl.querySelectorAll('button').forEach(b => { b.disabled = true; });
                        } else {
                            setStatus('删除失败: ' + (e.message || '未知'), true);
                            btnDel.disabled = false;
                        }
                    }
                };

                row.append(label, size, time, btnDel);
                listEl.appendChild(row);
            });

            if (!backupDeleteSupported) {
                setStatus('⚠️ 只读模式：' + backupDeleteUnsupportedReason, true);
                listEl.querySelectorAll('button').forEach(b => { b.disabled = true; });
            }
        }

        btnRefresh.onclick = async () => {
            setStatus('加载中...');
            try {
                const files = await fetchManifest();
                renderList(files);
                setStatus('');
            } catch (e) {
                setStatus('加载失败: ' + e.message, true);
            }
        };

        renderList(initialFiles);
    }

    return { removeBackupManagerModal, showBackupManagerModal };
}
