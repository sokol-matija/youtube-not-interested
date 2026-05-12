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

    // Hide summary FAB / drawer while a YouTube element is in fullscreen.
    function applyFullscreenClass() {
        document.body.classList.toggle('quick-block-fullscreen', !!document.fullscreenElement);
    }
    document.addEventListener('fullscreenchange', applyFullscreenClass);

    // ── Summary panel ──────────────────────────────────────────────────────────
    const SUMMARY_PANEL_ID = 'quick-block-summary-panel';
    const SUMMARY_FAB_ID = 'quick-block-summary-fab';
    const SUMMARY_TOAST_ID = 'quick-block-summary-toast';
    const BRIDGE_URL = 'http://localhost:7777/run';

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
        if (!currentWatchVideoId()) return;
        summaryState.videoId = currentWatchVideoId();
        injectSummaryDrawer();
        injectSummaryFab();
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
                </div>
                <div class="qb-sum-body" hidden></div>
            </aside>
        `;
        document.body.appendChild(root);

        root.querySelector('.qb-sum-min').addEventListener('click', closeDrawer);
        root.querySelector('.qb-sum-close').addEventListener('click', closeDrawer);
        root.querySelector('.qb-sum-copy').addEventListener('click', copySummary);

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
            const r = await fetch('http://localhost:7777/transcript', {
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
            const res = await fetch(BRIDGE_URL, {
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

                // Toast + green ready badge on FAB only when drawer is closed.
                if (!getSummaryDrawer()?.classList.contains('open')) {
                    const label = tr.title ? `Summary ready · ${tr.title}` : 'Summary ready';
                    showSummaryToast(label);
                    getSummaryFab()?.classList.add('qb-sum-fab-ready');
                }
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
        summaryState.videoId = null;
        summaryState.running = false;
        summaryState.summarized = false;
        summaryState.outputRaw = '';
        summaryState.outputHtml = '';
        summaryState.statusText = '';
    }

    // YouTube SPA navigation event
    document.addEventListener('yt-navigate-finish', () => {
        applyOnWatchClass();
        applyWatchAutomations();
        removeSummaryUI();
        if (currentWatchVideoId()) {
            setTimeout(injectSummaryUI, 400);
        }
    });
    // Also fire on initial load (event may have already passed)
    if (document.readyState === 'complete') {
        applyWatchAutomations();
        if (currentWatchVideoId()) injectSummaryUI();
    } else {
        window.addEventListener('load', () => {
            applyWatchAutomations();
            if (currentWatchVideoId()) injectSummaryUI();
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
