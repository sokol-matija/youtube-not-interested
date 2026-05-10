(function() {
    'use strict';

    const PROCESSED_ATTR = 'data-quick-block-added';
    const HIDE_CHECKED_ATTR = 'data-quick-hide-checked';
    const HIDDEN_CLASS = 'quick-block-hidden';

    const Storage = self.QuickBlockStorage;

    // Detect orphaned content script (extension reloaded, this script's context dead)
    function extensionAlive() {
        try { return !!chrome.runtime?.id; } catch { return false; }
    }
    window.addEventListener('unhandledrejection', (e) => {
        const msg = e.reason?.message || '';
        if (msg.includes('Extension context invalidated')) e.preventDefault();
    });

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
        if (!extensionAlive()) return;
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
        if (!extensionAlive()) return;
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

    function applyBottomCommentsToggle(on) {
        document.body.classList.toggle('quick-block-hide-comments', !!on);
    }

    function applyShareToggle(on) {
        document.body.classList.toggle('quick-block-hide-share', !!on);
    }

    function applyThanksToggle(on) {
        document.body.classList.toggle('quick-block-hide-thanks', !!on);
    }

    function applySearchOnWatchToggle(on) {
        document.body.classList.toggle('quick-block-hide-search-watch', !!on);
    }

    function applyOnWatchClass() {
        document.body.classList.toggle('quick-block-on-watch', !!currentWatchVideoId());
    }

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
            applyBottomCommentsToggle(newSettings.hideBottomComments);
            applyShareToggle(newSettings.hideShareButton);
            applyThanksToggle(newSettings.hideThanksButton);
            applySearchOnWatchToggle(newSettings.hideSearchOnWatch);
        }
    });

    // ── Watch-page automations ────────────────────────────────────────────────
    let lastWatchVideoId = null;

    async function waitForElement(selector, timeoutMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const el = document.querySelector(selector);
            if (el) return el;
            await new Promise(r => setTimeout(r, 100));
        }
        return null;
    }

    function currentWatchVideoId() {
        const m = location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        return location.pathname === '/watch' && m ? m[1] : null;
    }

    async function ensureVideoPlaying(timeoutMs = 4000) {
        const start = Date.now();
        let video = null;
        while (Date.now() - start < timeoutMs) {
            video = document.querySelector('video.html5-main-video');
            if (video && video.readyState >= 2) break;
            await new Promise(r => setTimeout(r, 100));
        }
        if (!video) return null;

        if (video.paused) {
            try { await video.play(); } catch {}
        }
        // If still paused (autoplay blocked), try clicking the big play button
        if (video.paused) {
            const bigPlay = document.querySelector('.ytp-large-play-button, .ytp-play-button');
            if (bigPlay) bigPlay.click();
        }
        // Wait briefly for playback to actually start
        const playStart = Date.now();
        while (Date.now() - playStart < 1500) {
            if (!video.paused && video.currentTime > 0) break;
            await new Promise(r => setTimeout(r, 80));
        }
        return video;
    }

    async function applyWatchAutomations() {
        const id = currentWatchVideoId();
        if (!id) return;
        if (id === lastWatchVideoId) return;
        lastWatchVideoId = id;

        const settings = await Storage.getSettings();

        if (settings.autoFullscreen) {
            const video = await ensureVideoPlaying();
            const fsBtn = await waitForElement('.ytp-fullscreen-button.ytp-button');
            if (fsBtn && !document.fullscreenElement) {
                // After fullscreen, the transition can pause the video — auto-resume.
                const onFsChange = () => {
                    setTimeout(() => {
                        if (video && video.paused) {
                            video.play().catch(() => {});
                        }
                    }, 200);
                    document.removeEventListener('fullscreenchange', onFsChange);
                };
                document.addEventListener('fullscreenchange', onFsChange);

                // Also catch a stray pause within the first 3 seconds and resume once.
                if (video) {
                    let resumed = false;
                    const onPause = () => {
                        if (resumed) return;
                        resumed = true;
                        setTimeout(() => video.play().catch(() => {}), 100);
                    };
                    video.addEventListener('pause', onPause, { once: true });
                    setTimeout(() => video.removeEventListener('pause', onPause), 3000);
                }

                fsBtn.click();
            }
        }

        if (settings.autoOpenComments) {
            const commentsBtn = await waitForElement('button[aria-label="Comments"]');
            if (commentsBtn && commentsBtn.getAttribute('aria-pressed') === 'false') {
                commentsBtn.click();
            }
        }
    }

    async function reopenCommentsAfterFullscreenExit() {
        if (document.fullscreenElement) return; // entering, ignore
        if (!currentWatchVideoId()) return;
        if (!extensionAlive()) return;
        const settings = await Storage.getSettings();
        if (!settings.autoOpenComments) return;
        // Give YouTube a beat to settle after fullscreen exit
        await new Promise(r => setTimeout(r, 300));
        const commentsBtn = document.querySelector('button[aria-label="Comments"]');
        if (commentsBtn && commentsBtn.getAttribute('aria-pressed') === 'false') {
            commentsBtn.click();
        }
    }

    document.addEventListener('fullscreenchange', reopenCommentsAfterFullscreenExit);

    // YouTube SPA navigation event
    document.addEventListener('yt-navigate-finish', () => {
        applyOnWatchClass();
        applyWatchAutomations();
    });
    // Also fire on initial load (event may have already passed)
    if (document.readyState === 'complete') applyWatchAutomations();
    else window.addEventListener('load', applyWatchAutomations);

    // ── Init ───────────────────────────────────────────────────────────────────
    async function loadStateAndRescan() {
        wlIds = await Storage.getWlIds();
        const settings = await Storage.getSettings();
        hideEnabled = settings.hideEnabled !== false;
        applyBottomCommentsToggle(settings.hideBottomComments);
        applyShareToggle(settings.hideShareButton);
        applyThanksToggle(settings.hideThanksButton);
        applySearchOnWatchToggle(settings.hideSearchOnWatch);
        applyOnWatchClass();
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
