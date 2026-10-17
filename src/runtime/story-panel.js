import { extensionFolderPath } from '../support/constants.js';
import { postToIframe } from '../support/iframe-messaging.js';

const IFRAME_ID = 'littlewhitememory-story-summary-iframe';
const OVERLAY_ID = 'littlewhitememory-story-summary-overlay';
const iframePath = `${extensionFolderPath}/src/panel/story-summary.html`;

// The overlay and its message queue have one lifecycle, independent of chat data.
export function createStoryPanel({ document, window, navigator, $, onMessage, onClose }) {
    let overlayCreated = false;
    let ready = false;
    let pendingMessages = [];

    function post(payload) {
        const iframe = document.getElementById(IFRAME_ID);
        if (!iframe?.contentWindow) return;
        if (!ready) {
            pendingMessages.push(payload);
            return;
        }
        postToIframe(iframe, payload, 'LittleWhiteMemory', window.location.origin);
    }

    function flush() {
        if (!ready) return false;
        const iframe = document.getElementById(IFRAME_ID);
        if (!iframe?.contentWindow) return false;
        pendingMessages.forEach(payload => postToIframe(iframe, payload, 'LittleWhiteMemory', window.location.origin));
        pendingMessages = [];
        return true;
    }

    function createOverlay() {
        if (overlayCreated) return;
        overlayCreated = true;
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent);
        const isNarrow = window.matchMedia?.('(max-width: 768px)').matches;
        const overlayHeight = (isMobile || isNarrow) ? '92.5vh' : '100vh';
        const $overlay = $(`
        <div id="${OVERLAY_ID}" style="
            position: fixed !important; inset: 0 !important;
            width: 100vw !important; height: ${overlayHeight} !important;
            z-index: 99999 !important; display: none; overflow: hidden !important;
        ">
            <div class="xb-ss-backdrop" style="
                position: absolute !important; inset: 0 !important;
                background: rgba(0,0,0,.55) !important;
                backdrop-filter: blur(4px) !important;
            "></div>
            <div class="xb-ss-frame-wrap" style="
                position: absolute !important; inset: 12px !important; z-index: 1 !important;
            ">
                <iframe id="${IFRAME_ID}"
                    src="${iframePath}"
                    style="width:100% !important; height:100% !important; border:none !important;
                           border-radius:12px !important; box-shadow:0 0 30px rgba(0,0,0,.4) !important;
                           background:#fafafa !important;">
                </iframe>
            </div>
            <button class="xb-ss-close-btn" style="
                position: absolute !important; top: 20px !important; right: 20px !important;
                z-index: 2 !important; width: 36px !important; height: 36px !important;
                border-radius: 50% !important; border: none !important;
                background: rgba(0,0,0,.6) !important; color: #fff !important;
                font-size: 20px !important; cursor: pointer !important;
                display: flex !important; align-items: center !important;
                justify-content: center !important;
            ">✕</button>
        </div>
    `);
        $overlay.on('click', '.xb-ss-backdrop, .xb-ss-close-btn', hide);
        document.body.appendChild($overlay[0]);
        window.addEventListener('message', onMessage);
    }

    function show() {
        if (!overlayCreated) createOverlay();
        $(`#${OVERLAY_ID}`).show();
    }

    function hide() {
        onClose();
        document.getElementById(OVERLAY_ID)?.remove();
        overlayCreated = false;
        ready = false;
        pendingMessages = [];
        window.removeEventListener('message', onMessage);
    }

    return {
        show, hide, post, flush,
        markReady: () => { ready = true; },
        isReady: () => ready,
        getPendingMessages: () => pendingMessages,
        clearPendingMessages: predicate => {
            pendingMessages = predicate ? pendingMessages.filter(payload => !predicate(payload)) : [];
        },
    };
}
