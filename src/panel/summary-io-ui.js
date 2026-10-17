// The iframe handles only user input and status here; the parent owns persistence.
export function createSummaryIOUI({ getElement, postMsg, showConfirmInput }) {
    const $ = getElement;

    function init() {
        $('btn-copy-summary').onclick = () => {
            $('btn-copy-summary').disabled = true;
            $('summary-io-status').textContent = '复制中...';
            postMsg('SUMMARY_COPY');
        };

        $('btn-import-summary').onclick = async () => {
            const text = await showConfirmInput(
                '覆盖导入记忆包',
                '导入会覆盖当前聊天已有的总结资料，并立即清空向量、锚点、总结边界。请把记忆包粘贴到下面。',
                '继续导入',
                '取消',
                '在这里粘贴记忆包 JSON'
            );
            if (text == null) return;
            if (!String(text).trim()) {
                $('summary-io-status').textContent = '导入失败: 记忆包内容为空';
                return;
            }
            $('btn-import-summary').disabled = true;
            $('summary-io-status').textContent = '导入中...';
            postMsg('SUMMARY_IMPORT_TEXT', { text });
        };
    }

    function handleCopyResult(data) {
        $('btn-copy-summary').disabled = false;
        if (data.success) {
            $('summary-io-status').textContent = `复制成功: ${data.events || 0} 条事件, ${data.facts || 0} 条世界状态`;
        } else {
            $('summary-io-status').textContent = '复制失败: ' + (data.error || '未知错误');
        }
    }

    function handleImportResult(data) {
        $('btn-import-summary').disabled = false;
        if (data.success) {
            const counts = data.counts || {};
            $('summary-io-status').textContent = `导入成功: ${counts.events || 0} 条事件, ${counts.facts || 0} 条世界状态。向量与锚点已清空，请先生成锚点，再补齐向量。`;
            postMsg('REQUEST_VECTOR_STATS');
            postMsg('REQUEST_ANCHOR_STATS');
        } else {
            $('summary-io-status').textContent = '导入失败: ' + (data.error || '未知错误');
        }
    }

    return { init, handleCopyResult, handleImportResult };
}
