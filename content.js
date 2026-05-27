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
    // Tracks the videoId we've already auto-opened comments for. Separate from
    // lastWatchVideoId so the comments retry survives a failed first attempt
    // (yt-navigate-finish can fire before the comments button is clickable).
    let commentsAutoOpenedFor = null;
    // Latches per videoId for the auto-summarize + auto-read flows. The summary
    // latch fires once we kick off generation (so the observer doesn't re-fire
    // while runSummarize is still running). The read latch fires once we ask for
    // TTS so a cached entry isn't re-read every time the observer ticks.
    let autoSummarizeTriggeredFor = null;
    let autoReadTriggeredFor = null;
    // Persisted TTS playback speed. Cycle 1 → 1.5 → 2 via the player button.
    const PLAYBACK_RATES = [1, 1.5, 2];
    let savedPlaybackRate = 1;
    chrome.storage.local.get(['ttsPlaybackRate'], (r) => {
        const v = Number(r?.ttsPlaybackRate);
        if (PLAYBACK_RATES.includes(v)) savedPlaybackRate = v;
    });

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
            await tryAutoOpenComments();
        }
    }

    // Idempotent: click the comments toggle at most once per videoId.
    // The latch is set ONLY after we actually click — never on observed
    // aria-pressed='true', because YT often carries stale aria-pressed from the
    // previous video's button DOM into the new page. Latching on that would
    // suppress the real click attempt that follows once YT resets the button.
    // Manual close during the same video still suppresses re-clicks because
    // the latch is keyed by videoId.
    // Idempotent auto-summarize trigger. Fires runSummarize() once per videoId
    // when the master toggle is on. Bails if a summary already exists (cached
    // restore handles the auto-read path separately) or generation is in flight.
    async function tryAutoSummarize() {
        const id = currentWatchVideoId();
        if (!id) return;
        if (!extensionAlive()) return;
        if (autoSummarizeTriggeredFor === id) return;
        if (summaryState.running) return;
        if (summaryState.summarized && summaryState.videoId === id) return;
        const settings = await Storage.getSettings();
        if (!settings.autoSummarize) return;
        // Make sure the drawer + FAB are mounted so runSummarize has DOM to
        // write status into. injectSummaryUI is idempotent.
        if (!getSummaryFab()) injectSummaryUI();
        // restoreCachedSummary is async; give it a beat so we don't double-fire
        // on a cached video right as the observer tick races the cache read.
        await new Promise(r => setTimeout(r, 200));
        if (summaryState.summarized && summaryState.videoId === id) return;
        autoSummarizeTriggeredFor = id;
        await runSummarize();
        // Roll back the latch if generation didn't actually produce a summary
        // (bridge unreachable, transcript fetch failed, etc.) so the observer
        // can retry once the user fixes whatever was broken.
        if (!summaryState.summarized || summaryState.videoId !== id) {
            autoSummarizeTriggeredFor = null;
        }
    }

    async function tryAutoOpenComments() {
        const id = currentWatchVideoId();
        if (!id) return;
        if (commentsAutoOpenedFor === id) return;
        if (!extensionAlive()) return;
        const settings = await Storage.getSettings();
        if (!settings.autoOpenComments) return;
        const btn = document.querySelector('ytd-comments-header-renderer button[aria-label="Comments"], #comments button[aria-label="Comments"], button[aria-label="Comments"]');
        if (!btn) return;
        const pressed = btn.getAttribute('aria-pressed');
        if (pressed !== 'false') return; // already open, or not yet wired — wait
        // Re-check the latch after the await — a parallel observer tick may
        // have entered tryAutoOpenComments and clicked between our pre-await
        // check and now. Reserve sync before the click to close the race.
        if (commentsAutoOpenedFor === id) return;
        commentsAutoOpenedFor = id;
        btn.click();
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

    // Hide summary FAB / drawer while a YouTube element is in fullscreen.
    function applyFullscreenClass() {
        document.body.classList.toggle('quick-block-fullscreen', !!document.fullscreenElement);
    }
    document.addEventListener('fullscreenchange', applyFullscreenClass);

    // ── Summary panel ──────────────────────────────────────────────────────────
    const SUMMARY_PANEL_ID = 'quick-block-summary-panel';
    const SUMMARY_FAB_ID = 'quick-block-summary-fab';
    const SUMMARY_TOAST_ID = 'quick-block-summary-toast';
    const SUMMARY_PLAYER_ID = 'qb-sum-player';
    const bridgeUrl = (path) => self.QuickBlockBridge.bridgeUrl(path);

    // Shared state so the masthead-mounted FAB and body-mounted drawer stay in sync
    // even though they live in different DOM subtrees.
    const summaryState = {
        videoId: null,
        running: false,
        summarized: false,
        outputRaw: '',
        outputHtml: '',
        statusText: '',
        toastTimer: null,
        ttsLoading: false,
        audio: null,
        audioToken: 0,
    };

    // Minimal markdown→HTML for summary output. Escapes HTML first to prevent
    // injection from transcript content or model output, then applies a small set
    // of block + inline transforms that cover what Claude typically produces.
    function mdToHtml(src) {
        const esc = (s) => s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        const inline = (s) => esc(s)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

        const lines = src.replace(/\r\n/g, '\n').split('\n');
        const out = [];
        let inUl = false, inOl = false, inBq = false;
        const closeLists = () => {
            if (inUl) { out.push('</ul>'); inUl = false; }
            if (inOl) { out.push('</ol>'); inOl = false; }
            if (inBq) { out.push('</blockquote>'); inBq = false; }
        };
        for (const raw of lines) {
            const line = raw.trimEnd();
            if (!line.trim()) { closeLists(); continue; }
            if (/^-{3,}$|^\*{3,}$/.test(line.trim())) { closeLists(); out.push('<hr>'); continue; }
            const h = line.match(/^(#{1,6})\s+(.*)$/);
            if (h) { closeLists(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
            const ul = line.match(/^\s*[-*]\s+(.*)$/);
            if (ul) {
                if (!inUl) { closeLists(); out.push('<ul>'); inUl = true; }
                out.push(`<li>${inline(ul[1])}</li>`);
                continue;
            }
            const ol = line.match(/^\s*\d+\.\s+(.*)$/);
            if (ol) {
                if (!inOl) { closeLists(); out.push('<ol>'); inOl = true; }
                out.push(`<li>${inline(ol[1])}</li>`);
                continue;
            }
            const bq = line.match(/^>\s?(.*)$/);
            if (bq) {
                if (!inBq) { closeLists(); out.push('<blockquote>'); inBq = true; }
                out.push(`<p>${inline(bq[1])}</p>`);
                continue;
            }
            closeLists();
            out.push(`<p>${inline(line)}</p>`);
        }
        closeLists();
        return out.join('\n');
    }

    function getSummaryFab() { return document.getElementById(SUMMARY_FAB_ID); }
    function getSummaryRoot() { return document.getElementById(SUMMARY_PANEL_ID); }
    function getSummaryDrawer() { return getSummaryRoot()?.querySelector('.qb-sum-drawer'); }

    function injectSummaryUI() {
        const vid = currentWatchVideoId();
        if (!vid) return;
        summaryState.videoId = vid;
        injectSummaryDrawer();
        injectSummaryFab();
        restoreCachedSummary(vid);
    }

    async function restoreCachedSummary(videoId) {
        let entry;
        try { entry = await Storage.getSummary(videoId); } catch { return; }
        if (!entry) return;
        // Stale-check: if user navigated to a different video while we waited,
        // don't paint the previous video's summary.
        if (summaryState.videoId !== videoId) return;

        summaryState.outputRaw = entry.raw || '';
        summaryState.outputHtml = entry.html || '';
        summaryState.statusText = entry.statusText || '';
        summaryState.summarized = true;

        // When the combined auto-summarize toggle is on, a cached entry should
        // still trigger TTS — user opened the page expecting it to play.
        try {
            const s = await Storage.getSettings();
            if (s.autoSummarize && autoReadTriggeredFor !== videoId) {
                autoReadTriggeredFor = videoId;
                const ok = await readSummary();
                if (!ok) autoReadTriggeredFor = null;  // allow retry on failure
            }
        } catch {}

        const drawer = getSummaryDrawer();
        const body = drawer?.querySelector('.qb-sum-body');
        const status = drawer?.querySelector('.qb-sum-status');
        const actions = drawer?.querySelector('.qb-sum-actions');
        if (body && summaryState.outputHtml) {
            body.dataset.raw = summaryState.outputRaw;
            body.innerHTML = summaryState.outputHtml;
            body.hidden = false;
        }
        if (status) status.textContent = summaryState.statusText;
        if (actions) actions.hidden = false;

        getSummaryFab()?.classList.add('qb-sum-fab-ready');
    }

    function injectSummaryDrawer() {
        if (getSummaryRoot()) return;

        const root = document.createElement('div');
        root.id = SUMMARY_PANEL_ID;
        root.className = 'qb-sum-root';
        root.innerHTML = `
            <aside class="qb-sum-drawer" aria-hidden="true">
                <header class="qb-sum-head">
                    <strong>Video summary</strong>
                    <div class="qb-sum-head-actions">
                        <button class="qb-sum-min" type="button" aria-label="Minimize panel (keeps generation running)" title="Slide closed — keeps generating">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <polyline points="9 18 15 12 9 6"/>
                            </svg>
                        </button>
                        <button class="qb-sum-close" type="button" aria-label="Close">✕</button>
                    </div>
                </header>
                <div class="qb-sum-status"></div>
                <div class="qb-sum-actions" hidden>
                    <button class="qb-sum-copy" type="button">Copy summary</button>
                    <button class="qb-sum-read" type="button">Read</button>
                </div>
                <div class="qb-sum-body" hidden></div>
            </aside>
        `;
        document.body.appendChild(root);

        root.querySelector('.qb-sum-min').addEventListener('click', closeDrawer);
        root.querySelector('.qb-sum-close').addEventListener('click', closeDrawer);
        root.querySelector('.qb-sum-copy').addEventListener('click', copySummary);
        root.querySelector('.qb-sum-read').addEventListener('click', () => readSummary());

        // Click anywhere outside the drawer + FAB + toast dismisses. Generation keeps running.
        document.addEventListener('mousedown', (e) => {
            const drawer = getSummaryDrawer();
            if (!drawer?.classList.contains('open')) return;
            if (root.contains(e.target)) return;
            if (getSummaryFab()?.contains(e.target)) return;
            const toast = document.getElementById(SUMMARY_TOAST_ID);
            if (toast?.contains(e.target)) return;
            closeDrawer();
        });

        root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeDrawer();
        });
    }

    function injectSummaryFab() {
        if (getSummaryFab()) return;

        // Find the YouTube top-right buttons container in the masthead.
        const end = document.querySelector('ytd-masthead #end')
            || document.querySelector('ytd-masthead #buttons')
            || document.querySelector('#masthead-container #end');
        if (!end) {
            setTimeout(injectSummaryFab, 300);
            return;
        }

        const fab = document.createElement('button');
        fab.id = SUMMARY_FAB_ID;
        fab.type = 'button';
        fab.className = 'qb-sum-fab qb-sum-fab-masthead';
        fab.title = 'Summarize this video';
        fab.setAttribute('aria-label', 'Summarize');
        fab.innerHTML = `
            <svg class="qb-sum-fab-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 3v4a1 1 0 001 1h4"/>
                <path d="M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z"/>
                <line x1="9" y1="13" x2="15" y2="13"/>
                <line x1="9" y1="17" x2="13" y2="17"/>
            </svg>
            <svg class="qb-sum-fab-spinner" viewBox="0 0 36 36" aria-hidden="true">
                <circle class="qb-sum-fab-spinner-track" cx="18" cy="18" r="15"/>
                <circle class="qb-sum-fab-spinner-arc" cx="18" cy="18" r="15"/>
            </svg>
        `;

        // Place FAB immediately before the avatar button so it sits right next to it.
        // Fall back to start of #end if the avatar isn't found yet.
        const avatar = end.querySelector('#avatar-btn')
            || end.querySelector('ytd-topbar-menu-button-renderer:last-of-type')
            || end.querySelector('yt-img-shadow');
        const anchor = avatar?.closest('ytd-topbar-menu-button-renderer, yt-button-shape, #avatar-btn') || avatar;
        if (anchor && anchor.parentElement === end) {
            end.insertBefore(fab, anchor);
        } else {
            end.insertBefore(fab, end.firstChild);
        }

        // FAB state machine:
        //   drawer open                 → close it
        //   generation in flight        → no-op (spinner shows progress)
        //   summary ready, drawer shut  → open drawer to read
        //   nothing yet                 → kick off generation in background
        fab.addEventListener('click', () => {
            const drawer = getSummaryDrawer();
            if (drawer?.classList.contains('open')) { closeDrawer(); return; }
            if (summaryState.running) return;
            if (summaryState.summarized) { openDrawer(); return; }
            runSummarize();
        });

        if (summaryState.running) fab.classList.add('qb-sum-fab-running');
    }

    function openDrawer() {
        const drawer = getSummaryDrawer();
        if (!drawer) return;
        drawer.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        dismissSummaryToast();
        // Green ready-badge stays on the FAB after open — it only clears on SPA nav
        // (via removeSummaryUI). User wanted a persistent "summary exists" indicator.
    }

    function closeDrawer() {
        const drawer = getSummaryDrawer();
        if (!drawer) return;
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
    }

    async function runSummarize() {
        if (summaryState.running) return;
        summaryState.running = true;
        summaryState.summarized = false;
        summaryState.outputRaw = '';
        summaryState.outputHtml = '';
        summaryState.statusText = 'Fetching transcript…';

        getSummaryFab()?.classList.add('qb-sum-fab-running');

        const drawer = getSummaryDrawer();
        const status = drawer?.querySelector('.qb-sum-status');
        const body = drawer?.querySelector('.qb-sum-body');
        const actions = drawer?.querySelector('.qb-sum-actions');
        if (status) status.textContent = summaryState.statusText;
        if (body) { body.hidden = false; body.textContent = ''; }
        if (actions) actions.hidden = true;

        const videoId = currentWatchVideoId();
        if (!videoId) {
            const msg = 'No video ID found on this page.';
            if (body) body.textContent = msg;
            summaryState.statusText = '';
            if (status) status.textContent = '';
            summaryState.running = false;
            getSummaryFab()?.classList.remove('qb-sum-fab-running');
            return;
        }

        let tr;
        try {
            const r = await fetch(await bridgeUrl('/transcript'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoId }),
            });
            const data = await r.json();
            if (data.ok) {
                tr = {
                    segments: data.segments,
                    language: data.language || '',
                    isAsr: !!data.isAsr,
                    videoId: data.videoId || videoId,
                    title: document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title')?.textContent?.trim() || document.title || '',
                    author: document.querySelector('ytd-channel-name a, #channel-name a')?.textContent?.trim() || '',
                };
            } else {
                if (body) body.textContent = `Transcript fetch failed: ${data.reason || 'unknown'}\n${data.message || ''}`;
                summaryState.statusText = '';
                if (status) status.textContent = '';
                summaryState.running = false;
                getSummaryFab()?.classList.remove('qb-sum-fab-running');
                return;
            }
        } catch (e) {
            if (body) body.textContent = `Bridge unreachable. Start it:\n  node scripts/claude-bridge.mjs\n\n${e.message}`;
            summaryState.statusText = '';
            if (status) status.textContent = '';
            summaryState.running = false;
            getSummaryFab()?.classList.remove('qb-sum-fab-running');
            return;
        }

        const settings = await Storage.getSettings();
        const model = settings.claudeModel || 'sonnet';

        const transcriptText = tr.segments.map(s => s.text).join(' ');

        const prompt = [
            `Here is a transcript from a ~20-minute video/podcast. Summarize it with:`,
            ``,
            `What it's about (2–3 sentences)`,
            `Main points covered (in order, as bullets)`,
            `Key insights, opinions, or recommendations worth remembering`,
            `Verdict or conclusion (if one is given)`,
            ``,
            `Be thorough but concise — I want the full value without watching/listening.`,
            ``,
            `Title: ${tr.title}`,
            ``,
            `Transcript:`,
            transcriptText,
        ].join('\n');

        summaryState.statusText = `Summarizing with ${model}…`;
        if (status) status.textContent = summaryState.statusText;

        try {
            const t0 = Date.now();
            const res = await fetch(await bridgeUrl('/run'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, model }),
            });
            const data = await res.json();
            if (data.ok) {
                summaryState.outputRaw = data.output;
                summaryState.outputHtml = mdToHtml(data.output);
                summaryState.statusText = `${model} · ${Math.round((Date.now() - t0) / 100) / 10}s · ${tr.segments.length} segments`;
                summaryState.summarized = true;

                const liveBody = getSummaryDrawer()?.querySelector('.qb-sum-body');
                const liveStatus = getSummaryDrawer()?.querySelector('.qb-sum-status');
                const liveActions = getSummaryDrawer()?.querySelector('.qb-sum-actions');
                if (liveBody) {
                    liveBody.dataset.raw = summaryState.outputRaw;
                    liveBody.innerHTML = summaryState.outputHtml;
                    liveBody.hidden = false;
                }
                if (liveStatus) liveStatus.textContent = summaryState.statusText;
                if (liveActions) liveActions.hidden = false;

                // Persist to cache so a page refresh restores this summary
                // without re-running generation. videoId may have changed mid-flight
                // (SPA nav) — write under the id we kicked off with.
                try {
                    await Storage.setSummary(videoId, {
                        raw: summaryState.outputRaw,
                        html: summaryState.outputHtml,
                        statusText: summaryState.statusText,
                        ts: Date.now(),
                        model,
                        title: tr.title || '',
                    });
                } catch {}

                // Toast + green ready badge on FAB only when drawer is closed.
                if (!getSummaryDrawer()?.classList.contains('open')) {
                    const label = tr.title ? `Summary ready · ${tr.title}` : 'Summary ready';
                    showSummaryToast(label);
                    getSummaryFab()?.classList.add('qb-sum-fab-ready');
                }

                // Auto-read the summary on fresh generation when the combined
                // auto-summarize + read toggle is on. Latched per videoId so
                // observer reentries don't restart TTS mid-playback.
                try {
                    const s = await Storage.getSettings();
                    if (s.autoSummarize && autoReadTriggeredFor !== videoId) {
                        autoReadTriggeredFor = videoId;
                        const ok = await readSummary();
                        if (!ok) autoReadTriggeredFor = null;  // allow retry on failure
                    }
                } catch {}
            } else {
                const liveBody = getSummaryDrawer()?.querySelector('.qb-sum-body');
                const liveStatus = getSummaryDrawer()?.querySelector('.qb-sum-status');
                if (liveBody) liveBody.textContent = `Error: ${data.error}`;
                summaryState.statusText = '';
                if (liveStatus) liveStatus.textContent = '';
            }
        } catch (e) {
            const liveBody = getSummaryDrawer()?.querySelector('.qb-sum-body');
            const liveStatus = getSummaryDrawer()?.querySelector('.qb-sum-status');
            if (liveBody) liveBody.textContent = `Bridge unreachable. Start it:\n  node scripts/claude-bridge.mjs`;
            summaryState.statusText = '';
            if (liveStatus) liveStatus.textContent = '';
        } finally {
            summaryState.running = false;
            getSummaryFab()?.classList.remove('qb-sum-fab-running');
        }
    }

    async function copySummary() {
        const text = summaryState.outputRaw;
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            const btn = getSummaryDrawer()?.querySelector('.qb-sum-copy');
            if (!btn) return;
            const orig = btn.textContent;
            btn.textContent = 'Copied ✓';
            setTimeout(() => { btn.textContent = orig; }, 1200);
        } catch {}
    }

    // ── TTS: read summary aloud via Kokoro (routed through background.js) ─────
    // Returns true if TTS produced an audio URL we handed to playAudio, false
    // on any failure or supersession. Callers can use this to roll back per-video
    // auto-read latches so a transient Kokoro outage doesn't pin the video as
    // "already attempted".
    async function readSummary() {
        const raw = summaryState.outputRaw;
        if (!raw) return false;
        if (summaryState.ttsLoading) return false;
        const text = self.QuickBlockMarkdown?.stripMarkdown(raw) || raw;
        if (!text.trim()) return false;

        // Invalidate any in-flight request from a previous read.
        const token = ++summaryState.audioToken;
        stopAudio();
        summaryState.ttsLoading = true;
        setReadButtonState(true);
        mountPlayer('loading', 'Generating audio…');

        let res;
        try {
            res = await chrome.runtime.sendMessage({ type: 'tts-generate', text });
        } catch (e) {
            res = { ok: false, error: e?.message || 'sendMessage failed' };
        }

        // A newer request (or cleanup) superseded this one — drop the result.
        if (token !== summaryState.audioToken) {
            summaryState.ttsLoading = false;
            setReadButtonState(false);
            return false;
        }

        summaryState.ttsLoading = false;
        setReadButtonState(false);

        if (!res?.ok || !res.dataUrl) {
            mountPlayer('error', `TTS failed: ${res?.error || 'unknown'}`);
            return false;
        }

        playAudio(res.dataUrl, token);
        return true;
    }

    function setReadButtonState(loading) {
        const btn = getSummaryDrawer()?.querySelector('.qb-sum-read');
        if (!btn) return;
        btn.disabled = !!loading;
        btn.textContent = loading ? 'Loading…' : 'Read';
    }

    function fmtTime(s) {
        if (!isFinite(s) || s < 0) s = 0;
        const m = Math.floor(s / 60);
        const r = Math.floor(s % 60);
        return `${m}:${r.toString().padStart(2, '0')}`;
    }

    function getPlayerEl() { return document.getElementById(SUMMARY_PLAYER_ID); }

    function mountPlayer(state, label) {
        let el = getPlayerEl();
        if (!el) {
            el = document.createElement('div');
            el.id = SUMMARY_PLAYER_ID;
            el.innerHTML = `
                <span class="qb-sum-player-dot"></span>
                <button class="qb-sum-player-btn qb-sum-player-play" type="button" aria-label="Play / pause" disabled>
                    <svg class="qb-sum-player-icon-play" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                    <svg class="qb-sum-player-icon-pause hidden" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                        <path d="M6 5h4v14H6zm8 0h4v14h-4z"/>
                    </svg>
                </button>
                <button class="qb-sum-player-btn qb-sum-player-speed" type="button" aria-label="Playback speed" disabled>1x</button>
                <span class="qb-sum-player-label"></span>
                <input class="qb-sum-player-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek" disabled>
                <span class="qb-sum-player-time">0:00 / 0:00</span>
                <button class="qb-sum-player-btn qb-sum-player-close" type="button" aria-label="Close player">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            `;
            document.body.appendChild(el);

            el.querySelector('.qb-sum-player-play').addEventListener('click', togglePlayPause);
            el.querySelector('.qb-sum-player-close').addEventListener('click', closePlayer);
            el.querySelector('.qb-sum-player-speed').addEventListener('click', cyclePlaybackSpeed);

            const seek = el.querySelector('.qb-sum-player-seek');
            seek.addEventListener('input', () => {
                const audio = summaryState.audio;
                if (!audio || !isFinite(audio.duration)) return;
                seek.dataset.seeking = '1';
                const t = (seek.value / 1000) * audio.duration;
                el.querySelector('.qb-sum-player-time').textContent =
                    `${fmtTime(t)} / ${fmtTime(audio.duration)}`;
            });
            seek.addEventListener('change', () => {
                const audio = summaryState.audio;
                seek.dataset.seeking = '';
                if (!audio || !isFinite(audio.duration)) return;
                audio.currentTime = (seek.value / 1000) * audio.duration;
            });

            requestAnimationFrame(() => el.classList.add('show'));
        }

        el.classList.remove('loading', 'error', 'playing', 'paused');
        if (state) el.classList.add(state);
        const labelEl = el.querySelector('.qb-sum-player-label');
        if (labelEl) labelEl.textContent = label || '';

        // Disable controls while not actually playable.
        const playBtn = el.querySelector('.qb-sum-player-play');
        const seek = el.querySelector('.qb-sum-player-seek');
        const speedBtn = el.querySelector('.qb-sum-player-speed');
        const playable = state === 'playing' || state === 'paused';
        if (playBtn) playBtn.disabled = !playable;
        if (seek) seek.disabled = !playable;
        if (speedBtn) {
            speedBtn.disabled = !playable;
            speedBtn.textContent = formatRate(savedPlaybackRate);
        }
    }

    function formatRate(r) {
        // Drop trailing zeros: 1.5 → "1.5x", 1 → "1x", 2 → "2x".
        return `${Number(r).toString()}x`;
    }

    function cyclePlaybackSpeed() {
        const idx = PLAYBACK_RATES.indexOf(savedPlaybackRate);
        savedPlaybackRate = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
        chrome.storage.local.set({ ttsPlaybackRate: savedPlaybackRate });
        if (summaryState.audio) summaryState.audio.playbackRate = savedPlaybackRate;
        const el = getPlayerEl();
        const btn = el?.querySelector('.qb-sum-player-speed');
        if (btn) btn.textContent = formatRate(savedPlaybackRate);
    }

    function setPlayPauseIcon(paused) {
        const el = getPlayerEl();
        if (!el) return;
        el.querySelector('.qb-sum-player-icon-play').classList.toggle('hidden', !paused);
        el.querySelector('.qb-sum-player-icon-pause').classList.toggle('hidden', paused);
    }

    function playAudio(dataUrl, token) {
        stopAudio();
        const audio = new Audio(dataUrl);
        audio.playbackRate = savedPlaybackRate;
        summaryState.audio = audio;
        mountPlayer('playing', '');
        setPlayPauseIcon(false);

        audio.addEventListener('loadedmetadata', () => {
            const el = getPlayerEl();
            if (!el) return;
            el.querySelector('.qb-sum-player-time').textContent =
                `0:00 / ${fmtTime(audio.duration)}`;
        });
        audio.addEventListener('timeupdate', () => {
            const el = getPlayerEl();
            if (!el) return;
            const seek = el.querySelector('.qb-sum-player-seek');
            if (seek.dataset.seeking !== '1' && isFinite(audio.duration) && audio.duration > 0) {
                seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
            }
            el.querySelector('.qb-sum-player-time').textContent =
                `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration || 0)}`;
        });
        audio.addEventListener('play', () => { mountPlayer('playing', ''); setPlayPauseIcon(false); });
        audio.addEventListener('pause', () => {
            // 'pause' also fires when the audio ends — keep the player visible but
            // flip the icon.
            if (!audio.ended) { mountPlayer('paused', ''); }
            setPlayPauseIcon(true);
        });
        audio.addEventListener('ended', () => {
            mountPlayer('paused', 'Finished');
            setPlayPauseIcon(true);
            const el = getPlayerEl();
            if (el && isFinite(audio.duration)) {
                el.querySelector('.qb-sum-player-seek').value = 1000;
            }
        });
        audio.addEventListener('error', () => {
            // Setting audio.src='' in stopAudio fires a synthetic 'error' on
            // some Chromium versions — ignore it so we don't flash a red error
            // label during a clean close/replace.
            if (audio._intentionalStop) return;
            mountPlayer('error', 'Audio playback failed');
        });

        audio.play().catch((e) => {
            // Autoplay can be blocked if the user hasn't interacted with the page yet.
            mountPlayer('paused', 'Click ▶ to play');
            setPlayPauseIcon(true);
            console.warn('[Quick Block] audio.play() rejected:', e?.message || e);
        });
    }

    function togglePlayPause() {
        const audio = summaryState.audio;
        if (!audio) return;
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    }

    function stopAudio() {
        const audio = summaryState.audio;
        if (!audio) return;
        audio._intentionalStop = true;
        try { audio.pause(); } catch {}
        try { audio.src = ''; } catch {}
        summaryState.audio = null;
    }

    function closePlayer() {
        summaryState.audioToken++;  // invalidate any in-flight TTS
        summaryState.ttsLoading = false;
        setReadButtonState(false);
        stopAudio();
        const el = getPlayerEl();
        if (!el) return;
        el.classList.remove('show');
        setTimeout(() => el.remove(), 250);
    }

    function showSummaryToast(label) {
        dismissSummaryToast();
        const toast = document.createElement('div');
        toast.id = SUMMARY_TOAST_ID;
        toast.className = 'qb-sum-toast';
        toast.setAttribute('role', 'button');
        toast.tabIndex = 0;
        toast.innerHTML = `<span class="qb-sum-toast-dot"></span><span class="qb-sum-toast-text"></span>`;
        toast.querySelector('.qb-sum-toast-text').textContent = label;
        const activate = () => { openDrawer(); };
        toast.addEventListener('click', activate);
        toast.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        summaryState.toastTimer = setTimeout(dismissSummaryToast, 6000);
    }

    function dismissSummaryToast() {
        if (summaryState.toastTimer) {
            clearTimeout(summaryState.toastTimer);
            summaryState.toastTimer = null;
        }
        const toast = document.getElementById(SUMMARY_TOAST_ID);
        if (!toast) return;
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    }

    function removeSummaryUI() {
        document.getElementById(SUMMARY_PANEL_ID)?.remove();
        document.getElementById(SUMMARY_FAB_ID)?.remove();
        dismissSummaryToast();
        closePlayer();
        summaryState.videoId = null;
        summaryState.running = false;
        summaryState.summarized = false;
        summaryState.outputRaw = '';
        summaryState.outputHtml = '';
        summaryState.statusText = '';
    }

    // YouTube SPA navigation event
    document.addEventListener('yt-navigate-finish', () => {
        // Clear per-video latches so a revisit re-evaluates state from scratch.
        // The latch is keyed by videoId so different videos already invalidate
        // it; this also covers same-video revisits and stale state from prev nav.
        commentsAutoOpenedFor = null;
        autoSummarizeTriggeredFor = null;
        autoReadTriggeredFor = null;
        applyOnWatchClass();
        applyWatchAutomations();
        removeSummaryUI();
        if (currentWatchVideoId()) {
            setTimeout(() => { injectSummaryUI(); tryAutoSummarize(); }, 400);
        }
    });
    // Also fire on initial load (event may have already passed)
    if (document.readyState === 'complete') {
        applyWatchAutomations();
        if (currentWatchVideoId()) { injectSummaryUI(); tryAutoSummarize(); }
    } else {
        window.addEventListener('load', () => {
            applyWatchAutomations();
            if (currentWatchVideoId()) { injectSummaryUI(); tryAutoSummarize(); }
        });
    }

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

        const observer = new MutationObserver(() => {
            processVideos();
            // Self-heal summary UI on SPA nav: yt-navigate-finish sometimes fires
            // before the masthead is ready, or doesn't fire at all on home→video
            // transitions. Both inject functions are idempotent and bail fast if
            // already mounted, so this is cheap.
            if (currentWatchVideoId() && !getSummaryFab()) injectSummaryUI();
            // Same self-heal for auto-open comments — the comments toggle often
            // mounts after yt-navigate-finish, leaving the original click attempt
            // with nothing to click. Latched per videoId so we don't spam clicks.
            tryAutoOpenComments();
            // Auto-summarize when the master toggle is on. Latched per videoId.
            tryAutoSummarize();
        });
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
