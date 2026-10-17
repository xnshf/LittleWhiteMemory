import { ensureExtensionsUiReady, extension_settings, showHideExtensionsMenu } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { EXT_ID, extensionFolderPath } from './src/support/constants.js';

const settings = extension_settings[EXT_ID] ||= { storySummary: { enabled: true } };
settings.storySummary ||= { enabled: true };

let summaryLoaded = false;
let summaryModule;
let wandItem;

function updateWandVisibility() {
    if (!wandItem) return;
    wandItem.parentElement.style.display = settings.storySummary.enabled !== false && summaryLoaded ? '' : 'none';
    showHideExtensionsMenu();
}

async function mountWandEntry() {
    await ensureExtensionsUiReady();
    const menu = document.querySelector('#extensionsMenu');
    if (!menu) throw new Error('魔棒菜单不可用');
    const container = document.createElement('div');
    container.id = 'littlewhitememory_wand_container';
    container.className = 'extension_container';
    wandItem = document.createElement('div');
    wandItem.className = 'list-group-item flex-container flexGap5';
    wandItem.setAttribute('role', 'button');
    wandItem.tabIndex = 0;
    wandItem.innerHTML = '<div class="fa-fw fa-solid fa-chart-line extensionsMenuExtensionButton"></div><span>剧情记忆</span>';
    wandItem.addEventListener('click', () => summaryModule?.openStorySummaryPanel());
    wandItem.addEventListener('keydown', event => {
        if ((event.key !== 'Enter' && event.key !== ' ') || event.repeat) return;
        event.preventDefault();
        wandItem.click();
    });
    container.style.display = 'none';
    container.append(wandItem);
    menu.append(container);
    updateWandVisibility();
}

async function loadSummary() {
    if (summaryLoaded) return;
    await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__);
    const api = window.__TAURITAVERN__?.api;
    if (!api?.chat?.current?.ref || !api?.chat?.current?.handle || !api?.extension?.store) {
        throw new Error('LittleWhiteMemory 需要 TauriTavern 的 chat 与 extension.store API');
    }
    const module = await import('./src/runtime/story-summary.js');
    await module.initStorySummary();
    summaryModule = module;
    summaryLoaded = true;
    updateWandVisibility();
}

async function setSummaryEnabled(enabled) {
    const previous = settings.storySummary.enabled !== false;
    settings.storySummary.enabled = enabled;
    try {
        if (enabled && !summaryLoaded) {
            await loadSummary();
        } else if (summaryLoaded && enabled !== previous) {
            $(document).trigger('littlewhitememory:storySummary:toggle', [enabled]);
        }
        updateWandVisibility();
        saveSettingsDebounced();
    } catch (error) {
        settings.storySummary.enabled = previous;
        throw error;
    }
}

export function activate() {
    // No ChatSurface takeover: the memory module owns its prompt; the entry is in the wand menu.
}

jQuery(async () => {
    try {
        let container = document.querySelector('#extensions_settings');
        for (let i = 0; !container && i < 100; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            container = document.querySelector('#extensions_settings');
        }
        if (container) {
            const response = await fetch(`${extensionFolderPath}/settings.html`);
            if (!response.ok) throw new Error(`设置页面加载失败 (${response.status})`);
            $(container).append(await response.text());
            $('#littlewhitememory_enabled')
                .prop('checked', settings.storySummary.enabled !== false)
                .on('change', async function () {
                    const enabled = this.checked;
                    this.disabled = true;
                    try {
                        await setSummaryEnabled(enabled);
                    } catch (error) {
                        this.checked = settings.storySummary.enabled !== false;
                        console.error('[LittleWhiteMemory] 剧情记忆启动失败', error);
                        toastr.error(`剧情记忆启动失败：${error.message}`);
                    } finally {
                        this.disabled = false;
                    }
                });
        }
        await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__);
        await mountWandEntry();
        if (settings.storySummary.enabled !== false) await loadSummary();
    } catch (error) {
        console.error('[LittleWhiteMemory] 初始化失败', error);
        toastr.error(`LittleWhiteMemory 初始化失败：${error.message}`);
    }
});
