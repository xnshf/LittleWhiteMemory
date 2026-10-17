// Shared confirmation modal for ordinary actions, text import, and cleanup choices.
export function createConfirmationUI({ getElement, postMsg, isBusyLike, cleanActionState }) {
    const $ = getElement;

    function showConfirm(title, message, okText = '执行', cancelText = '取消') {
        return new Promise(resolve => {
            const modal = $('confirm-modal');
            const titleEl = $('confirm-title');
            const msgEl = $('confirm-message');
            const inputWrap = $('confirm-input-wrap');
            const inputEl = $('confirm-input');
            const actionList = $('confirm-action-list');
            const okBtn = $('confirm-ok');
            const cancelBtn = $('confirm-cancel');
            const closeBtn = $('confirm-close');
            const backdrop = $('confirm-backdrop');

            titleEl.textContent = title;
            msgEl.textContent = message;
            inputWrap.classList.add('hidden');
            actionList.classList.add('hidden');
            inputEl.value = '';
            okBtn.classList.remove('hidden');
            okBtn.textContent = okText;
            cancelBtn.textContent = cancelText;

            const close = (result) => {
                modal.classList.remove('active');
                postMsg('CONFIRM_CLOSED');
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                if (closeBtn) closeBtn.onclick = null;
                backdrop.onclick = null;
                resolve(result);
            };

            okBtn.onclick = () => close(true);
            cancelBtn.onclick = () => close(false);
            if (closeBtn) closeBtn.onclick = () => close(false);
            backdrop.onclick = () => close(false);

            modal.classList.add('active');
            postMsg('CONFIRM_OPENED');
        });
    }

    function showConfirmInput(title, message, okText = '执行', cancelText = '取消', placeholder = '') {
        return new Promise(resolve => {
            const modal = $('confirm-modal');
            const titleEl = $('confirm-title');
            const msgEl = $('confirm-message');
            const inputWrap = $('confirm-input-wrap');
            const inputEl = $('confirm-input');
            const actionList = $('confirm-action-list');
            const okBtn = $('confirm-ok');
            const cancelBtn = $('confirm-cancel');
            const closeBtn = $('confirm-close');
            const backdrop = $('confirm-backdrop');

            titleEl.textContent = title;
            msgEl.textContent = message;
            inputWrap.classList.remove('hidden');
            actionList.classList.add('hidden');
            inputEl.placeholder = placeholder || '';
            inputEl.value = '';
            okBtn.classList.remove('hidden');
            okBtn.textContent = okText;
            cancelBtn.textContent = cancelText;

            const close = (result) => {
                clearTimeout(focusTimer);
                modal.classList.remove('active');
                postMsg('CONFIRM_CLOSED');
                inputWrap.classList.add('hidden');
                inputEl.value = '';
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                if (closeBtn) closeBtn.onclick = null;
                backdrop.onclick = null;
                resolve(result);
            };

            okBtn.onclick = () => close(inputEl.value);
            cancelBtn.onclick = () => close(null);
            if (closeBtn) closeBtn.onclick = () => close(null);
            backdrop.onclick = () => close(null);

            modal.classList.add('active');
            postMsg('CONFIRM_OPENED');
            const focusTimer = setTimeout(() => inputEl.focus(), 0);
        });
    }

    function showCleanActionMenu() {
        return new Promise(resolve => {
            const modal = $('confirm-modal');
            const titleEl = $('confirm-title');
            const msgEl = $('confirm-message');
            const inputWrap = $('confirm-input-wrap');
            const inputEl = $('confirm-input');
            const actionList = $('confirm-action-list');
            const rollbackBtn = $('confirm-action-rollback');
            const clearBtn = $('confirm-action-clear');
            const rollbackDesc = $('confirm-action-rollback-desc');
            const clearDesc = $('confirm-action-clear-desc');
            const okBtn = $('confirm-ok');
            const cancelBtn = $('confirm-cancel');
            const closeBtn = $('confirm-close');
            const backdrop = $('confirm-backdrop');
            const busy = isBusyLike();

            titleEl.textContent = '清理总结数据';
            msgEl.textContent = '请选择要执行的清理操作。';
            inputWrap.classList.add('hidden');
            inputEl.value = '';
            actionList.classList.remove('hidden');
            okBtn.classList.add('hidden');
            cancelBtn.textContent = '退出';

            if (busy) {
                rollbackBtn.disabled = true;
                clearBtn.disabled = true;
                rollbackDesc.textContent = '当前有任务运行中，暂时不能执行。';
                clearDesc.textContent = '当前有任务运行中，暂时不能执行。';
            } else {
                rollbackBtn.disabled = !cleanActionState.canRollback;
                clearBtn.disabled = false;
                rollbackDesc.textContent = cleanActionState.canRollback
                    ? (cleanActionState.rollbackWillResetBoundary
                        ? '撤销首次总结生成的内容；人工修改不会被覆盖，存在冲突时将拒绝回退。聊天记录不会删除。'
                        : `撤销最近一次总结，已总结楼层将回退到 ${cleanActionState.rollbackTargetSummarizedUpTo} 楼。聊天记录不会删除。`)
                    : '当前没有可回退的总结快照。';
                clearDesc.textContent = '删除本聊天的全部总结数据，聊天记录不会删除。';
            }

            const close = (result) => {
                modal.classList.remove('active');
                postMsg('CONFIRM_CLOSED');
                actionList.classList.add('hidden');
                okBtn.classList.remove('hidden');
                rollbackBtn.onclick = null;
                clearBtn.onclick = null;
                cancelBtn.onclick = null;
                if (closeBtn) closeBtn.onclick = null;
                backdrop.onclick = null;
                resolve(result);
            };

            rollbackBtn.onclick = () => {
                if (!rollbackBtn.disabled) close('rollback');
            };
            clearBtn.onclick = () => {
                if (!clearBtn.disabled) close('clear');
            };
            cancelBtn.onclick = () => close(null);
            if (closeBtn) closeBtn.onclick = () => close(null);
            backdrop.onclick = () => close(null);

            modal.classList.add('active');
            postMsg('CONFIRM_OPENED');
        });
    }

    return { showConfirm, showConfirmInput, showCleanActionMenu };
}
