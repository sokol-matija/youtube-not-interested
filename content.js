(function() {
    'use strict';

    const PROCESSED_ATTR = 'data-quick-block-added';
    const HIDE_CHECKED_ATTR = 'data-quick-hide-checked';
    const HIDDEN_CLASS = 'quick-block-hidden';

    const Storage = self.QuickBlockStorage;

    let wlIds = new Set();
    let hideEnabled = true;
    const sessionRestored = new Set(); // IDs user restored this session
    let lastMenuVideoElement = null;    // for capturing "Save to Watch later" clicks

    // ── X button (Not Interested) ──────────────────────────────────────────────
    function addBlockButton(videoElement) {
        try {
            if (videoElement.hasAttribute(PROCESSED_ATTR)) return;
            videoElement.setAttribute(PROCESSED_ATTR, 'true');

            const thumbnail = videoElement.querySelector('yt-thumbnail-view-model');
            if (!thumbnail) return;

            const btn = document.createElement('button');
            btn.className = 'quick-block-btn';
            btn.textContent = '✕';
            btn.title = 'Not interested';

            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                lastMenuVideoElement = videoElement;
                await markNotInterested(videoElement);
            });

            thumbnail.appendChild(btn);
        } catch (error) {
            console.error('[Quick Block] addBlockButton error:', error);
        }
    }

    async function markNotInterested(videoElement) {
        const menuBtn = videoElement.querySelector('button[aria-label="More actions"]');
        if (!menuBtn) return;

        document.body.classList.add('quick-block-suppress-menu');
        menuBtn.click();
        await new Promise(r => setTimeout(r, 300));

        const titles = document.querySelectorAll('.ytListItemViewModelTitle, .yt-list-item-view-model__title');
        for (const title of titles) {
            if (title.textContent.trim() === 'Not interested') {
                const item = title.closest('yt-list-item-view-model, [role="menuitem"]') || title;
                item.click();
                setTimeout(() => document.body.classList.remove('quick-block-suppress-menu'), 100);
                return;
            }
        }
        document.body.click();
        document.body.classList.remove('quick-block-suppress-menu');
    }

    // ── Video ID extraction ────────────────────────────────────────────────────
    function getVideoId(videoElement) {
        const a = videoElement.querySelector('a[href*="/watch?v="]');
        if (!a) return null;
        const m = a.getAttribute('href').match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        return m ? m[1] : null;
    }

    function getVideoTitle(videoElement) {
        const t = videoElement.querySelector('#video-title, yt-formatted-string.ytd-rich-grid-media, span.yt-core-attributed-string');
        return (t?.textContent || '').trim().slice(0, 120);
    }

    // ── Hide ──────────────────────────────────────────────────────────────────
    function hideVideo(videoElement, id) {
        if (videoElement.classList.contains(HIDDEN_CLASS)) return;
        const title = getVideoTitle(videoElement);
        videoElement.classList.add(HIDDEN_CLASS);
        Storage.logHidden(id, title || id).catch(() => {});
    }

    function maybeHide(videoElement) {
        if (!hideEnabled) return;
        if (videoElement.hasAttribute(HIDE_CHECKED_ATTR)) return;
        videoElement.setAttribute(HIDE_CHECKED_ATTR, 'true');
        const id = getVideoId(videoElement);
        if (!id) return;
        if (sessionRestored.has(id)) return;
        if (wlIds.has(id)) hideVideo(videoElement, id);
    }

    function unhideAll() {
        document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach(el => {
            el.classList.remove(HIDDEN_CLASS);
            el.removeAttribute(HIDE_CHECKED_ATTR);
        });
    }

    function rescanAll() {
        document.querySelectorAll('ytd-rich-item-renderer').forEach(el => {
            el.removeAttribute(HIDE_CHECKED_ATTR);
            maybeHide(el);
        });
    }

    // ── Process new videos ─────────────────────────────────────────────────────
    function processVideos() {
        const cards = document.querySelectorAll('ytd-rich-item-renderer');
        cards.forEach(card => {
            addBlockButton(card);
            maybeHide(card);
        });
    }

    // ── Capture WL membership changes from any UI path ────────────────────────
    async function recordWlAdd(id) {
        if (!id) return;
        wlIds.add(id);
        await Storage.addWlId(id);
    }
    async function recordWlRemove(id) {
        if (!id) return;
        wlIds.delete(id);
        await Storage.removeWlId(id);
    }

    document.addEventListener('click', (e) => {
        const target = e.target;

        // Track which video the "More actions" menu was opened for
        const moreBtn = target.closest('button[aria-label="More actions"]');
        if (moreBtn) {
            lastMenuVideoElement = moreBtn.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer');
        }

        // Inline thumbnail "Watch later" overlay button (clock icon)
        const wlBtn = target.closest('button[aria-label="Watch later"], button[aria-label="Remove from Watch later"]');
        if (wlBtn) {
            const label = wlBtn.getAttribute('aria-label');
            const videoEl = wlBtn.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer');
            const id = videoEl ? getVideoId(videoEl) : null;
            if (id) {
                if (label === 'Watch later') recordWlAdd(id);
                else recordWlRemove(id);
            }
        }

        // Dropdown menu items
        const menuItem = target.closest('yt-list-item-view-model, [role="menuitem"]');
        if (menuItem) {
            const titleEl = menuItem.querySelector('.ytListItemViewModelTitle, .yt-list-item-view-model__title');
            const text = titleEl?.textContent?.trim();
            if (text === 'Save to Watch later' && lastMenuVideoElement) {
                recordWlAdd(getVideoId(lastMenuVideoElement));
            } else if (text === 'Remove from Watch later' && lastMenuVideoElement) {
                recordWlRemove(getVideoId(lastMenuVideoElement));
            }
        }
    }, true);

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type === 'rescan') {
            loadStateAndRescan().then(() => sendResponse({ ok: true }));
            return true;
        }
    });

    // ── React to storage changes (popup toggles, click capture, etc.) ─────────
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[Storage.KEYS.WL_IDS]) {
            wlIds = new Set(changes[Storage.KEYS.WL_IDS].newValue || []);
            rescanAll();
        }
        if (changes[Storage.KEYS.SETTINGS]) {
            const newSettings = changes[Storage.KEYS.SETTINGS].newValue || {};
            const wasEnabled = hideEnabled;
            hideEnabled = newSettings.hideEnabled !== false;
            if (wasEnabled && !hideEnabled) unhideAll();
            else if (!wasEnabled && hideEnabled) rescanAll();
        }
    });

    // ── Init ───────────────────────────────────────────────────────────────────
    async function loadStateAndRescan() {
        wlIds = await Storage.getWlIds();
        const settings = await Storage.getSettings();
        hideEnabled = settings.hideEnabled !== false;
        rescanAll();
    }

    async function init() {
        await loadStateAndRescan();
        processVideos();
        setTimeout(processVideos, 500);
        setTimeout(processVideos, 1500);

        const observer = new MutationObserver(() => processVideos());
        observer.observe(document.body, { childList: true, subtree: true });

        // First-run: if we've never synced, kick one off via background
        const last = await Storage.getLastSync();
        if (!last) chrome.runtime.sendMessage({ type: 'request-sync' }).catch(() => {});
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
