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
    let karaokeEnabled = true;
    let karaokeWordCount = 3;
    const sessionRestored = new Set(); // IDs user restored this session
    let lastMenuVideoElement = null;    // for capturing "Save to Watch later" clicks

    // ── Scheduled Focus Mode ───────────────────────────────────────────────────
    let focusModeEnabled = false;
    let focusDays = [];                  // 0=Sun..6=Sat
    let focusStart = '09:00';
    let focusEnd = '17:00';
    let focusHideNow = false;            // manual override: hide home feed now, ignore schedule
    let focusMessage = 'You are free, do something that matters';
    let focusBeam = true;
    let focusActive = false;
    let focusLockUntil = 0;              // epoch ms: timed FAB lock; 0 = not locked
    // Friction (not security): same password as the options-page schedule unlock.
    const FOCUS_UNLOCK = 'j5q8rqwp521c1';
    const FOCUS_LOCK_DURATIONS = [       // dropdown on the masthead focus FAB
        { min: 10,    label: '10 min' },
        { min: 15,    label: '15 min' },
        { min: 30,    label: '30 min' },
        { min: 60,    label: '1 hour' },
        { min: 'rest', label: 'Rest of day' },
    ];
    const FOCUS_MSG_ID = 'quick-block-focus-message';
    const FOCUS_FAB_ID = 'quick-block-focus-fab';
    const WATCH_STATS_ID = 'quick-block-watch-stats';

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
                const id = getVideoId(videoElement);
                item.click();
                if (id) hideVideo(videoElement, id);
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

    function applyTeaserCarouselToggle(on) {
        document.body.classList.toggle('quick-block-hide-teaser-carousel', !!on);
    }

    function applyMiniGuideToggle(on) {
        document.body.classList.toggle('quick-block-hide-mini-guide', !!on);
    }

    // Picture-in-picture: "p" toggles PiP on the video (keypress = user
    // gesture, so requestPictureInPicture is allowed). Coming back to the
    // tab exits PiP automatically.
    document.addEventListener('keydown', e => {
        if (e.key !== 'p' && e.key !== 'P') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t.closest?.('input, textarea, select, [contenteditable]')) return;
        const v = document.querySelector('video.html5-main-video')
            || document.querySelector('video');
        if (!v) return;
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        } else {
            v.requestPictureInPicture().catch(() => {});
        }
    });

    window.addEventListener('focus', () => {
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        }
    });

    // "c" toggles cinema mode (same as the player-bar button below). Overrides
    // YouTube's own "c" (subtitles) — subtitles still toggle from the player bar.
    document.addEventListener('keydown', async e => {
        if (e.key !== 'c' && e.key !== 'C') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
        if (!currentWatchVideoId()) return;
        e.stopPropagation();
        const s = await Storage.getSettings();
        Storage.setSettings({ cinemaMode: !s.cinemaMode });
    }, true);

    let autoHideMasthead = false;
    function applyAutoHideMastheadToggle(on) {
        autoHideMasthead = !!on;
        if (!autoHideMasthead) document.body.classList.remove('quick-block-masthead-hidden');
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

    const CINEMA_BTN_ID = 'quick-block-cinema-btn';

    function applyCinemaToggle(on) {
        const changed = document.body.classList.contains('quick-block-cinema') !== !!on;
        document.body.classList.toggle('quick-block-cinema', !!on);
        // Player controls size from JS-measured player width — nudge a recalc.
        if (changed) window.dispatchEvent(new Event('resize'));
        const btn = document.getElementById(CINEMA_BTN_ID);
        if (btn) {
            btn.classList.toggle('qb-cinema-btn-active', !!on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }

    // Player-bar cinema toggle — sits leftmost in .ytp-right-controls, next to
    // the theater/fullscreen buttons. Idempotent: bails if already mounted.
    function injectCinemaButton() {
        if (document.getElementById(CINEMA_BTN_ID)) return;
        const controls = document.querySelector('#movie_player .ytp-right-controls');
        if (!controls) return;
        const btn = document.createElement('button');
        btn.id = CINEMA_BTN_ID;
        btn.className = 'ytp-button';
        btn.title = 'Cinema mode (video only) — c';
        btn.setAttribute('aria-label', 'Cinema mode');
        btn.setAttribute('aria-pressed', document.body.classList.contains('quick-block-cinema') ? 'true' : 'false');
        btn.innerHTML = `
            <svg height="100%" width="100%" viewBox="0 0 36 36">
                <rect x="7" y="9" width="22" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>
                <rect class="qb-cinema-inner" x="11" y="13" width="14" height="10" rx="1" fill="currentColor"/>
            </svg>`;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const s = await Storage.getSettings();
            // setSettings fires storage.onChanged, which runs applyCinemaToggle
            // here and in every other YT tab — no direct class flip needed.
            Storage.setSettings({ cinemaMode: !s.cinemaMode });
        });
        if (document.body.classList.contains('quick-block-cinema')) btn.classList.add('qb-cinema-btn-active');
        controls.insertBefore(btn, controls.firstChild);
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
            applyDescriptionToggle(newSettings.hideDescription);
            applyWatchStatsToggle(newSettings.hideWatchStats);
            applyTeaserCarouselToggle(newSettings.hideTeaserCarousel);
            applyMiniGuideToggle(newSettings.hideMiniGuide);
            applyAutoHideMastheadToggle(newSettings.autoHideMasthead);
            applyCinemaToggle(newSettings.cinemaMode);

            // Karaoke settings can change while audio is playing — apply live.
            karaokeEnabled = newSettings.karaokeEnabled !== false;
            const newCount = normalizeWordCount(newSettings.karaokeWordCount);
            const countChanged = newCount !== karaokeWordCount;
            karaokeWordCount = newCount;
            if (typeof applyKaraokeSettings === 'function') {
                applyKaraokeSettings(countChanged);
            }

            // Scheduled Focus Mode — update vars + re-evaluate immediately.
            focusModeEnabled = !!newSettings.focusModeEnabled;
            focusDays = Array.isArray(newSettings.focusDays) ? newSettings.focusDays : [];
            focusStart = newSettings.focusStart || '09:00';
            focusEnd = newSettings.focusEnd || '17:00';
            focusHideNow = !!newSettings.focusHideNow;
            if (typeof newSettings.focusMessage === 'string') focusMessage = newSettings.focusMessage;
            focusBeam = newSettings.focusBeam !== false;
            focusLockUntil = Number(newSettings.focusLockUntil) || 0;
            applyFocusMode();

            // Keep the drawer's style picker in sync if the active profile was
            // changed elsewhere (options page, or the picker in another tab).
            populateProfileSelect();
        }
        // Profiles added/edited/removed in options → refresh the dropdown.
        if (changes[Storage.KEYS.SUMMARY_PROFILES]) {
            populateProfileSelect();
        }
        // Watch counter — our own tick writes land here too, as do other tabs'.
        if (changes[WATCH_STATS_KEY]) {
            updateWatchCounter(changes[WATCH_STATS_KEY].newValue);
        }
    });

    // ── Masthead watch counter — videos played + time watched today ──────────
    const WATCH_COUNTER_ID = 'quick-block-watch-counter';
    const WATCH_STATS_KEY = 'watchStatsToday';   // { date, seconds, ids: [videoId] }
    const WATCH_TICK_MS = 5000;

    function fmtWatchTime(seconds) {
        const m = Math.floor(seconds / 60);
        return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
    }

    function updateWatchCounter(stats) {
        const el = document.getElementById(WATCH_COUNTER_ID);
        if (!el) return;
        const today = new Date().toISOString().slice(0, 10);
        const fresh = stats && stats.date === today ? stats : { seconds: 0, ids: [] };
        el.querySelector('[data-role="count"]').textContent = fresh.ids.length;
        el.querySelector('[data-role="time"]').textContent = fmtWatchTime(fresh.seconds);
    }

    // Two circles next to the hide-description toggle: videos played + time
    // watched today. Same 36px chip language as the description button.
    function injectWatchCounter() {
        if (document.getElementById(WATCH_COUNTER_ID)) return;
        const descBtn = document.getElementById(DESC_TOGGLE_ID);
        if (!descBtn) return;
        const wrap = document.createElement('span');
        wrap.id = WATCH_COUNTER_ID;
        wrap.title = 'Videos played · time watched today';
        wrap.innerHTML = `
            <span class="qb-watch-pill" data-role="count"></span>
            <span class="qb-watch-pill" data-role="time"></span>`;
        descBtn.insertAdjacentElement('afterend', wrap);
        chrome.storage.local.get(WATCH_STATS_KEY, (r) => updateWatchCounter(r?.[WATCH_STATS_KEY]));
    }

    // Accrue while a watch-page video is actually playing. Read-modify-write
    // every tick; day rollover just starts a fresh record.
    // ponytail: two tabs playing at once can drop a tick to a lost update —
    // per-tab buckets if that ever matters.
    setInterval(async () => {
        const v = document.querySelector('#movie_player video');
        const id = currentWatchVideoId();
        if (!v || !id || v.paused || v.ended) return;
        const today = new Date().toISOString().slice(0, 10);
        const { [WATCH_STATS_KEY]: rec } = await chrome.storage.local.get(WATCH_STATS_KEY);
        const stats = rec && rec.date === today ? rec : { date: today, seconds: 0, ids: [] };
        stats.seconds += WATCH_TICK_MS / 1000;
        if (!stats.ids.includes(id)) stats.ids.push(id);
        await chrome.storage.local.set({ [WATCH_STATS_KEY]: stats });
    }, WATCH_TICK_MS);

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
    const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2];
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

    // ── Watch stats (views · time ago) ──────────────────────────────────────────
    // The watch description header holds them in <yt-formatted-string id="info">
    // as spans: [0]=views, [1]=spacer, [2]=time ago. Fall back to a regex over the
    // full text if YouTube shifts the span layout.
    function extractWatchStats() {
        const info = document.querySelector('yt-formatted-string#info.ytd-watch-info-text');
        if (!info) return null;
        const spans = [...info.querySelectorAll('span')];
        let views = spans[0]?.textContent.trim() || '';
        let timeAgo = spans[2]?.textContent.trim() || '';
        if (!/view/i.test(views) || !/ago/i.test(timeAgo)) {
            const full = info.textContent.replace(/\s+/g, ' ').trim();
            const m = full.match(/([\d.,]+\s*[KMB]?\s*views?)\s+(.+?ago)/i);
            if (m) { views = m[1].trim(); timeAgo = m[2].trim(); }
        }
        if (!views && !timeAgo) return null;
        return { views, timeAgo };
    }

    // Mirror views · time ago into the #actions row (next to like/share). Idempotent:
    // updates text in place, only writes DOM when the label actually changes.
    function injectWatchStats() {
        if (!currentWatchVideoId()) return;
        const stats = extractWatchStats();
        if (!stats) return;
        const actions = document.querySelector('ytd-watch-metadata #actions');
        if (!actions) return;
        const parts = [stats.views, stats.timeAgo].filter(Boolean);
        const label = parts.join(' · ');
        const pills = parts.map(p => {
            const s = document.createElement('span');
            s.className = 'qb-watch-pill';
            s.textContent = p;
            return s;
        });
        let el = document.getElementById(WATCH_STATS_ID);
        if (el) {
            if (el.dataset.label !== label) { el.replaceChildren(...pills); el.dataset.label = label; }
            return;
        }
        el = document.createElement('div');
        el.id = WATCH_STATS_ID;
        el.className = 'quick-block-watch-stats';
        el.replaceChildren(...pills);
        el.dataset.label = label;
        actions.appendChild(el);
    }

    // ── Scheduled Focus Mode ───────────────────────────────────────────────────
    // days: int[] 0=Sun..6=Sat. start/end: 'HH:MM' (local). Handles same-day and
    // overnight (wrap-around) windows; malformed/empty input → off.
    function isInFocusWindow(now, days, start, end) {
        if (!Array.isArray(days) || days.length === 0) return false;
        const toMin = (s) => {
            const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
            return m ? (+m[1]) * 60 + (+m[2]) : null;
        };
        const s = toMin(start), e = toMin(end);
        if (s === null || e === null || s === e) return false;
        const cur = now.getHours() * 60 + now.getMinutes();
        const today = now.getDay();
        if (s < e) return days.includes(today) && cur >= s && cur < e;   // same-day
        // Overnight wrap: selected day = the evening the window OPENS.
        if (cur >= s) return days.includes(today);                        // opens tonight
        if (cur < e)  return days.includes((today + 6) % 7);             // spillover into morning
        return false;
    }

    function focusLocked() { return focusLockUntil > Date.now(); }

    // Minutes left on the timed FAB lock (0 if not locked / expired).
    function focusLockMinutesLeft() {
        return focusLocked() ? Math.ceil((focusLockUntil - Date.now()) / 60000) : 0;
    }

    function focusShouldBeOn() {
        if (focusLocked()) return true; // timed lock forces focus on
        if (focusHideNow) return true;  // manual override
        return focusModeEnabled && isInFocusWindow(new Date(), focusDays, focusStart, focusEnd);
    }

    // Minutes from now until the active window's end boundary.
    function focusMinutesLeft(now) {
        const toMin = (s) => {
            const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
            return m ? (+m[1]) * 60 + (+m[2]) : null;
        };
        const s = toMin(focusStart), e = toMin(focusEnd);
        if (s === null || e === null) return 0;
        const cur = now.getHours() * 60 + now.getMinutes();
        if (s < e) return Math.max(0, e - cur);          // same-day window
        if (cur >= s) return (1440 - cur) + e;           // overnight, evening → tomorrow morning
        return Math.max(0, e - cur);                     // overnight, early morning → today's end
    }

    // "1h33min" / "33min" / "less than a minute"
    function fmtFocusLeft(min) {
        if (min <= 0) return 'less than a minute';
        const h = Math.floor(min / 60), m = min % 60;
        if (h > 0) return m > 0 ? `${h}h${m}min` : `${h}h`;
        return `${m}min`;
    }

    function applyFocusMode() {
        // Timed lock expired → clear it once so focus can fall back to schedule.
        if (focusLockUntil && focusLockUntil <= Date.now()) {
            focusLockUntil = 0;
            Storage.setSettings({ focusLockUntil: 0 });
        }
        const on = focusShouldBeOn();
        document.body.classList.toggle('quick-block-focus-mode', on);
        focusActive = on;
        if (on) injectFocusMessage();
        else removeFocusMessage();
        syncFocusFabState();
    }

    function injectFocusMessage() {
        const home = document.querySelector('ytd-browse[page-subtype="home"]');
        if (!home) return;  // not on home yet — observer/nav retries
        // Manual hide has no end boundary → no countdown line.
        const left = focusHideNow ? '' : fmtFocusLeft(focusMinutesLeft(new Date()));
        let el = document.getElementById(FOCUS_MSG_ID);
        if (el) {
            if (el.classList.contains('qb-no-beam') === focusBeam) el.classList.toggle('qb-no-beam', !focusBeam);
            // CRITICAL: only touch the DOM when something actually changed.
            // The MutationObserver fires on any mutation, so an unconditional
            // textContent write here would retrigger the observer → infinite
            // loop → page freeze.
            const titleEl = el.querySelector('.qb-focus-title');
            if (titleEl && titleEl.textContent !== focusMessage) titleEl.textContent = focusMessage;
            const leftEl = el.querySelector('.qb-focus-left');
            if (leftEl && leftEl.textContent !== left) leftEl.textContent = left;
            const subEl = el.querySelector('.qb-focus-sub');
            const wantSub = focusHideNow ? 'none' : '';
            if (subEl && subEl.style.display !== wantSub) subEl.style.display = wantSub;
            if (!home.contains(el)) home.prepend(el);
            return;
        }
        el = document.createElement('div');
        el.id = FOCUS_MSG_ID;
        el.className = 'qb-focus-msg' + (focusBeam ? '' : ' qb-no-beam');
        el.innerHTML = `<div class="qb-focus-card">
            <span class="qb-beam-bloom"></span>
            <div class="qb-focus-textwrap">
                <div class="qb-focus-title"></div>
                <div class="qb-focus-sub">Home feed back in <span class="qb-focus-left"></span></div>
            </div>
        </div>`;
        el.querySelector('.qb-focus-title').textContent = focusMessage;
        el.querySelector('.qb-focus-left').textContent = left;
        if (focusHideNow) el.querySelector('.qb-focus-sub').style.display = 'none';
        home.prepend(el);
    }

    function removeFocusMessage() {
        document.getElementById(FOCUS_MSG_ID)?.remove();
    }

    function getFocusFab() { return document.getElementById(FOCUS_FAB_ID); }

    // Masthead toggle next to the avatar — flip the manual "hide home feed now"
    // override so you can start focusing without opening the options page. This
    // only touches focusHideNow (the free override), never focusModeEnabled (the
    // password-gated schedule), so it can't be used to dodge a scheduled window.
    function injectFocusFab() {
        if (getFocusFab()) return;

        const end = document.querySelector('ytd-masthead #end')
            || document.querySelector('ytd-masthead #buttons')
            || document.querySelector('#masthead-container #end');
        if (!end) {
            setTimeout(injectFocusFab, 300);
            return;
        }

        // Wrapper keeps the FAB and its hover dropdown together so the menu stays
        // open while the pointer travels from button to menu.
        const wrap = document.createElement('div');
        wrap.className = 'qb-focus-fab-wrap';

        const fab = document.createElement('button');
        fab.id = FOCUS_FAB_ID;
        fab.type = 'button';
        fab.className = 'qb-sum-fab qb-sum-fab-masthead qb-focus-fab';
        fab.setAttribute('aria-label', 'Toggle focus mode');
        fab.innerHTML = `
            <svg class="qb-focus-fab-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
        `;

        // Hover dropdown — start a timed locked focus session.
        const menu = document.createElement('div');
        menu.className = 'qb-focus-menu';
        menu.innerHTML = `<div class="qb-focus-menu-head">Lock focus for…</div>`
            + FOCUS_LOCK_DURATIONS
                .map((d) => `<button type="button" class="qb-focus-menu-item" data-min="${d.min}">${d.label}</button>`)
                .join('');
        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.qb-focus-menu-item');
            if (!item) return;
            e.preventDefault();
            e.stopPropagation();
            const raw = item.dataset.min;
            startLockedFocus(raw === 'rest' ? 'rest' : Number(raw));
            wrap.classList.remove('qb-focus-menu-open');
        });

        wrap.appendChild(fab);
        wrap.appendChild(menu);

        // Place immediately before the avatar button so it sits right next to it.
        const avatar = end.querySelector('#avatar-btn')
            || end.querySelector('ytd-topbar-menu-button-renderer:last-of-type')
            || end.querySelector('yt-img-shadow');
        const anchor = avatar?.closest('ytd-topbar-menu-button-renderer, yt-button-shape, #avatar-btn') || avatar;
        if (anchor && anchor.parentElement === end) {
            end.insertBefore(wrap, anchor);
        } else {
            end.insertBefore(wrap, end.firstChild);
        }

        fab.addEventListener('click', () => {
            if (focusLocked()) {                             // locked → password to exit early
                const pw = prompt(`Focus locked for ${fmtFocusLeft(focusLockMinutesLeft())}. Enter password to unlock early:`);
                if (pw === null) return;
                if (pw !== FOCUS_UNLOCK) { syncFocusFabState(); return; }
                Storage.setSettings({ focusLockUntil: 0, focusHideNow: false });
                return;
            }
            // Toggle the manual override against whatever's showing right now: if
            // the home feed is hidden, reveal it; otherwise hide it and focus.
            Storage.setSettings({ focusHideNow: !focusActive });
        });

        syncFocusFabState();
    }

    // Begin a timed locked focus session. minutes is a number or 'rest' (until
    // local midnight). focusHideNow forces focus on; focusLockUntil pins it there
    // until the timer expires or the password is entered on the FAB.
    function startLockedFocus(minutes) {
        let until;
        if (minutes === 'rest') {
            const d = new Date();
            d.setHours(23, 59, 59, 999);
            until = d.getTime();
        } else {
            until = Date.now() + minutes * 60000;
        }
        Storage.setSettings({ focusHideNow: true, focusLockUntil: until });
    }

    function syncFocusFabState() {
        const fab = getFocusFab();
        if (!fab) return;
        const locked = focusLocked();
        fab.classList.toggle('qb-focus-fab-active', focusActive);
        fab.classList.toggle('qb-focus-fab-locked', locked);
        fab.closest('.qb-focus-fab-wrap')?.classList.toggle('qb-focus-locked', locked);
        fab.title = locked
            ? `Focus locked — ${fmtFocusLeft(focusLockMinutesLeft())} left (click to unlock)`
            : (focusActive ? 'Focus mode on — show home feed' : 'Start focusing — hide home feed · hover to lock');
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
        // Two flavours: "+ read on open" reads aloud (auto-read blocks below);
        // "silent" only generates + auto-opens the panel (no read).
        if (!settings.autoSummarize && !settings.autoSummarizeSilent) return;
        // Never regenerate a summary that's already cached. A spurious same-page
        // yt-navigate-finish can wipe in-memory state and re-trigger this; the
        // restore path repaints (and auto-opens) the cached summary instead.
        try { if (await Storage.getSummary(id)) return; } catch {}
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
        clickCommentsButtonWithoutJump(btn);
    }

    // YT's own click handler both steals focus onto the button and scrolls it
    // into view. On narrow/half-screen widths YT stacks the comments panel
    // above the metadata, so that scrollIntoView drags the whole page down.
    // We only ever fire this right after landing on a watch page, so the top
    // is always the right place to be — just force it back there.
    // On a cold reload YT re-scrolls whenever the panel re-renders, which can
    // land seconds after the click — fixed nudges lose that race. Instead snap
    // back on every scroll until the user scrolls themselves (or 4s passes).
    const COMMENTS_SNAP_MS = 4000;
    function clickCommentsButtonWithoutJump(btn) {
        btn.click();
        btn.blur();   // don't leave keyboard focus parked on the toggle
        const USER_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown'];
        const snap = () => {
            // YT also parks focus inside the panel ("Add a comment…"), which the
            // browser scrolls to on its own — drop that too.
            const ae = document.activeElement;
            if (ae?.closest?.('#comments')) ae.blur();
            if (window.scrollY) window.scrollTo(0, 0);
        };
        const stop = () => {
            clearTimeout(timer);
            window.removeEventListener('scroll', snap);
            USER_EVENTS.forEach(t => window.removeEventListener(t, stop, true));
        };
        window.addEventListener('scroll', snap);
        USER_EVENTS.forEach(t => window.addEventListener(t, stop, true));
        const timer = setTimeout(stop, COMMENTS_SNAP_MS);
        snap();
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
            clickCommentsButtonWithoutJump(commentsBtn);
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
    const DESC_TOGGLE_ID = 'quick-block-desc-toggle';
    let hideDescription = false;   // persisted pref: hide the watch description box

    // Playlist watch pages stack the playlist panel + comments in the same column.
    // This segmented pill shows exactly one at a time. 'playlist' = hide comments,
    // 'comments' = hide playlist panel. Body-class driven so it survives SPA rebuilds.
    const PLAYLIST_TOGGLE_ID = 'quick-block-playlist-toggle';
    let playlistPanelMode = 'comments';   // per-video state (no memory): 'playlist' | 'comments' | 'chapters'
    const SUMMARY_TOAST_ID = 'quick-block-summary-toast';
    const SUMMARY_PLAYER_ID = 'qb-sum-player';
    const KARAOKE_ID = 'qb-karaoke';
    const CLUSTER_TOGGLE_ID = 'qb-cluster-toggle';
    const SUMMARY_TTS_FAB_ID = 'quick-block-tts-fab';
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
        timestamps: null,    // raw [{word,start_time,end_time}] from Kokoro
        words: [],           // normalized [{text,start,end}] for karaoke
        curWordIdx: -1,
        clusterHidden: false, // chip: player + karaoke hidden (audio plays on)
        karaokeHidden: false, // "A" button: karaoke box only hidden
        karaokeEnabled: true, // from settings
        karaokeWordCount: 3,  // from settings (odd → balanced sides)
        _playerRO: null,      // ResizeObserver keeping karaoke at 70% of player
        karaokeRaf: null,     // rAF handle for word sync loop
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
    function getTtsFab()     { return document.getElementById(SUMMARY_TTS_FAB_ID); }
    function getSummaryRoot() { return document.getElementById(SUMMARY_PANEL_ID); }
    function getSummaryDrawer() { return getSummaryRoot()?.querySelector('.qb-sum-drawer'); }

    function injectSummaryUI() {
        const vid = currentWatchVideoId();
        if (!vid) return;
        summaryState.videoId = vid;
        injectSummaryDrawer();
        injectSummaryFab();
        injectDescriptionToggle();
        injectPlaylistToggle();
        injectTtsFab();
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
        syncTtsFabState();
        syncSummaryControls();

        // Auto behaviours apply to cached entries too — the user opened the page
        // expecting them. Silent → open the panel; "+ read"/autoTts → read aloud.
        try {
            const s = await Storage.getSettings();
            if (s.autoSummarizeSilent) openDrawer();
            if ((s.autoSummarize || s.autoTts) && autoReadTriggeredFor !== videoId) {
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
                <div class="qb-sum-controls">
                    <label class="qb-sum-profile-wrap">
                        <span class="qb-sum-profile-cap">Style</span>
                        <select class="qb-sum-profile" aria-label="Summary style" title="Which system prompt to summarize with"></select>
                    </label>
                    <button class="qb-sum-regen" type="button" title="Generate a fresh summary with the selected style">
                        <svg class="qb-sum-regen-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <polyline points="23 4 23 10 17 10"/>
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                        </svg>
                        <span class="qb-sum-regen-label">Generate</span>
                    </button>
                </div>
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

        // Pick the summary style (= which system prompt) right from the drawer.
        // Saved to settings so it persists and matches the options page.
        root.querySelector('.qb-sum-profile').addEventListener('change', (e) => {
            Storage.setSettings({ activeSummaryProfileId: e.target.value });
        });
        // Regenerate: re-run with the currently selected style, overwriting cache.
        root.querySelector('.qb-sum-regen').addEventListener('click', () => {
            if (summaryState.running) return;
            runSummarize();
        });
        populateProfileSelect();
        syncSummaryControls();

        // Click-outside dismissal — installed once per page load (not per inject call).
        // Uses live getElementById so SPA re-injections don't accumulate stale closures.
        if (!injectSummaryDrawer._mousedownInstalled) {
            injectSummaryDrawer._mousedownInstalled = true;
            document.addEventListener('mousedown', (e) => {
                const drawer = getSummaryDrawer();
                if (!drawer?.classList.contains('open')) return;
                const liveRoot = document.getElementById(SUMMARY_PANEL_ID);
                if (liveRoot?.contains(e.target)) return;
                if (getSummaryFab()?.contains(e.target)) return;
                const toast = document.getElementById(SUMMARY_TOAST_ID);
                if (toast?.contains(e.target)) return;
                // Don't close when interacting with the TTS mini-player
                const player = document.getElementById(SUMMARY_PLAYER_ID);
                if (player?.contains(e.target)) return;
                closeDrawer();
            });
        }

        root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeDrawer();
        });
    }

    // Fill the style dropdown from saved profiles + select the active one. Built
    // via DOM nodes (not innerHTML) so custom profile names can't inject markup.
    async function populateProfileSelect() {
        const sel = getSummaryDrawer()?.querySelector('.qb-sum-profile');
        if (!sel) return;
        let profiles, settings;
        try {
            [profiles, settings] = await Promise.all([
                Storage.getSummaryProfiles(),
                Storage.getSettings(),
            ]);
        } catch { return; }
        const active = settings.activeSummaryProfileId || 'standard';
        const sig = profiles.map(p => `${p.id}:${p.name}`).join('|');
        if (sel.dataset.sig !== sig) {  // skip rebuild if unchanged (don't clobber open dropdown)
            sel.dataset.sig = sig;
            sel.replaceChildren(...profiles.map(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                return opt;
            }));
        }
        sel.value = profiles.some(p => p.id === active) ? active : (profiles[0]?.id || '');
    }

    // Reflect run state on the drawer controls: lock the picker + button while a
    // summary is generating, and label the button for what a click will do.
    function syncSummaryControls() {
        const drawer = getSummaryDrawer();
        if (!drawer) return;
        const running = summaryState.running;
        const sel = drawer.querySelector('.qb-sum-profile');
        if (sel) sel.disabled = running;
        const regen = drawer.querySelector('.qb-sum-regen');
        if (regen) {
            regen.disabled = running;
            const label = regen.querySelector('.qb-sum-regen-label');
            if (label) label.textContent = running ? 'Generating…' : (summaryState.summarized ? 'Regenerate' : 'Generate');
        }
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
            <span class="qb-beam-bloom" aria-hidden="true"></span>
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
            if (summaryState.running) { openDrawer(); return; }  // click while streaming → watch it
            if (summaryState.summarized) { openDrawer(); return; }
            runSummarize();
        });

        if (summaryState.running) fab.classList.add('qb-sum-fab-running');
    }

    // Feather icons (same lib as the summary FAB / regen button).
    const EYE_OFF_SVG = `<svg class="qb-sum-toggle-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    const EYE_SVG = `<svg class="qb-sum-toggle-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

    // Body-class hide, same mechanism as the share/thanks/comments toggles — CSS
    // hides #description via a body-scoped selector, so it survives the description
    // box rebuilding on SPA nav without any per-element reapply.
    // Hide our injected views · time-ago pills (YouTube still shows them in the
    // description box). Body class so it survives the #actions row rebuilding.
    function applyWatchStatsToggle(on) {
        document.body.classList.toggle('quick-block-hide-watch-stats', !!on);
    }

    function applyDescriptionToggle(on) {
        hideDescription = !!on;
        document.body.classList.toggle('quick-block-hide-description', hideDescription);
        syncDescriptionToggle();
    }

    // Playlist detection is URL-based (KISS). Two cases that show the side panel:
    //   • Regular playlist — carries an `index=` param, e.g. ?v=…&list=…&index=1
    //   • Mix / radio — `start_radio=1` and/or a `list=RD…` id (auto-mix ids all
    //     start with "RD"; e.g. ?v=…&list=RDMqc37ItMefM&start_radio=1). No `index`.
    // DOM probing was unreliable, so we stick to the URL.
    function isPlaylistUrl() {
        const p = new URLSearchParams(location.search);
        if (p.has('index') || p.has('start_radio')) return true;
        return (p.get('list') || '').startsWith('RD');
    }

    // Chapters is opt-in per video: the chapters button only appears after the user
    // clicks the player's chapter title (.ytp-chapter-title.ytp-button), which is what
    // opens YouTube's chapters panel. Reset to false on every navigation.
    let chaptersActivated = false;

    // Feather-style icons, one per mode.
    const PL_ICON_PLAYLIST = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="14" y2="18"/><polygon points="3 5 3 19 6 12"/></svg>`;
    const PL_ICON_COMMENTS = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
    const PL_ICON_CHAPTERS = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.4"/><circle cx="4" cy="12" r="1.4"/><circle cx="4" cy="18" r="1.4"/></svg>`;

    // Ordered mode table: key → body class, button label/icon. Priority is table order.
    const PLAYLIST_MODES = [
        { key: 'playlist', cls: 'quick-block-pl-only', label: 'Show playlist', icon: PL_ICON_PLAYLIST },
        { key: 'comments', cls: 'quick-block-cm-only', label: 'Show comments', icon: PL_ICON_COMMENTS },
        { key: 'chapters', cls: 'quick-block-ch-only', label: 'Show chapters', icon: PL_ICON_CHAPTERS },
    ];

    // Which modes are offered on this page: comments always; playlist only on a
    // playlist URL; chapters only once the user has opened it. Table order = priority.
    function availablePlaylistModes() {
        const out = [];
        if (isPlaylistUrl()) out.push('playlist');
        out.push('comments');
        if (chaptersActivated) out.push('chapters');
        return out;
    }

    // Per-video default: playlist if the URL is a playlist, else comments. No memory —
    // reset on every nav (see yt-navigate-finish / resetPlaylistPanelState).
    function defaultPlaylistMode() {
        return isPlaylistUrl() ? 'playlist' : 'comments';
    }

    function resetPlaylistPanelState() {
        chaptersActivated = false;
        playlistPanelMode = defaultPlaylistMode();
    }

    // Toggle the mutually-exclusive body classes — show the current panel, hide the
    // others. Active only when there's a choice (≥2 modes), so untouched normal videos
    // are never altered. Classes persist across SPA nav, so clear them otherwise.
    // Passing `mode` switches the panel (an explicit user click).
    function applyPlaylistPanelMode(mode) {
        const present = availablePlaylistModes();
        if (mode && present.includes(mode)) playlistPanelMode = mode;
        if (!present.includes(playlistPanelMode)) playlistPanelMode = present[0] || 'comments';
        const active = present.length >= 2;                  // gate: only when there's a choice
        const body = document.body.classList;
        for (const m of PLAYLIST_MODES) {
            body.toggle(m.cls, active && playlistPanelMode === m.key);
        }
        syncPlaylistToggle();
    }

    // Row of circular buttons anchored at the right edge of the watch-title row.
    // Re-renders when the offered set of modes changes (playlist URL / chapters opened).
    function injectPlaylistToggle() {
        const present = availablePlaylistModes();
        if (present.length < 2) {                            // nothing to switch between → no buttons
            document.getElementById(PLAYLIST_TOGGLE_ID)?.remove();
            applyPlaylistPanelMode();                        // clears the body classes
            return;
        }
        applyPlaylistPanelMode();                            // reflect current mode

        const sig = present.join(',');                       // changes when offered modes change
        let pill = document.getElementById(PLAYLIST_TOGGLE_ID);
        if (pill && pill.dataset.modes === sig) { syncPlaylistToggle(); return; }

        if (!pill) {
            // Live in the #actions row next to the views · time-ago pills — the title
            // row is too narrow and the buttons overlapped long titles.
            const anchor = document.querySelector('ytd-watch-metadata #actions');
            if (!anchor) return;
            pill = document.createElement('div');
            pill.id = PLAYLIST_TOGGLE_ID;
            pill.className = 'qb-pl-pill';
            pill.addEventListener('click', (e) => {
                const seg = e.target.closest('.qb-pl-seg');
                if (!seg) return;
                e.preventDefault();
                e.stopPropagation();
                applyPlaylistPanelMode(seg.dataset.mode);    // switch (no persistence)
            });
            // Sit right after the views · time-ago pills when they're already mounted.
            const stats = document.getElementById(WATCH_STATS_ID);
            if (stats?.parentElement === anchor) stats.insertAdjacentElement('afterend', pill);
            else anchor.appendChild(pill);
        }

        // (Re)build buttons for the currently-offered modes.
        pill.dataset.modes = sig;
        pill.innerHTML = PLAYLIST_MODES
            .filter((m) => present.includes(m.key))
            .map((m) => `<button type="button" class="qb-pl-seg" data-mode="${m.key}" title="${m.label}" aria-label="${m.label}">${m.icon}</button>`)
            .join('');
        syncPlaylistToggle();
    }

    function syncPlaylistToggle() {
        const pill = document.getElementById(PLAYLIST_TOGGLE_ID);
        if (!pill) return;
        pill.querySelectorAll('.qb-pl-seg').forEach((seg) => {
            const active = seg.dataset.mode === playlistPanelMode;
            seg.classList.toggle('qb-pl-seg-active', active);
            seg.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    // Reveal the chapters switch button once the user opens chapters via the player's
    // chapter-title control. Capture phase so YouTube's own handler still runs too.
    document.addEventListener('click', (e) => {
        if (e.target?.closest?.('.ytp-chapter-title.ytp-button')) {
            if (!chaptersActivated) {
                chaptersActivated = true;
                injectPlaylistToggle();
            }
            applyPlaylistPanelMode('chapters');   // switch toggle to chapters on open
        }
    }, true);

    // Inline "hide description" toggle, placed inside #subscribe-button next to the
    // channel controls for fast access. Persists like focusHideNow.
    function injectDescriptionToggle() {
        if (!currentWatchVideoId()) return;
        if (document.getElementById(DESC_TOGGLE_ID)) { syncDescriptionToggle(); return; }
        const sub = document.querySelector('#subscribe-button');
        if (!sub) return;
        const anchor = sub.querySelector('[data-channel-external-id]');
        if (!anchor) return;

        const btn = document.createElement('button');
        btn.id = DESC_TOGGLE_ID;
        btn.type = 'button';
        btn.className = 'qb-sum-toggle';
        btn.addEventListener('click', (e) => {
            // Stop the event reaching YouTube's polymer gesture handlers on the
            // surrounding subscribe renderer, which otherwise eat the interaction.
            e.preventDefault();
            e.stopPropagation();
            const next = !hideDescription;
            applyDescriptionToggle(next);                    // instant feedback
            Storage.setSettings({ hideDescription: next });  // persist (onChanged re-applies, idempotent)
        });
        anchor.insertAdjacentElement('afterend', btn);
        syncDescriptionToggle();
    }

    function syncDescriptionToggle() {
        const btn = document.getElementById(DESC_TOGGLE_ID);
        if (!btn) return;
        btn.innerHTML = hideDescription ? EYE_SVG : EYE_OFF_SVG;
        btn.title = hideDescription ? 'Show description' : 'Hide description';
        btn.setAttribute('aria-label', btn.title);
    }

    function injectTtsFab() {
        if (getTtsFab()) return;
        const summaryFab = getSummaryFab();
        if (!summaryFab?.parentElement) return;

        const fab = document.createElement('button');
        fab.id = SUMMARY_TTS_FAB_ID;
        fab.type = 'button';
        fab.className = 'qb-tts-fab';
        fab.title = 'Read summary aloud';
        fab.setAttribute('aria-label', 'Read summary');
        fab.innerHTML = `
            <svg class="qb-tts-fab-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M11 5L6 9H2v6h4l5 4V5z"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
            <svg class="qb-sum-fab-spinner" viewBox="0 0 36 36" aria-hidden="true">
                <circle class="qb-sum-fab-spinner-track" cx="18" cy="18" r="15"/>
                <circle class="qb-sum-fab-spinner-arc" cx="18" cy="18" r="15"/>
            </svg>
            <span class="qb-beam-bloom" aria-hidden="true"></span>
        `;

        // Insert immediately left of the summary FAB
        summaryFab.parentElement.insertBefore(fab, summaryFab);
        syncTtsFabState();

        fab.addEventListener('click', () => {
            if (summaryState.ttsLoading) return;
            if (!summaryState.summarized) return;
            const audio = summaryState.audio;
            if (audio && !audio.ended) {
                togglePlayPause();
                return;
            }
            readSummary();
        });
    }

    function syncTtsFabState() {
        const fab = getTtsFab();
        if (!fab) return;
        fab.classList.toggle('qb-tts-fab-disabled', !summaryState.summarized);
        fab.classList.toggle('qb-tts-fab-loading', !!summaryState.ttsLoading);
        const audio = summaryState.audio;
        fab.classList.toggle('qb-tts-fab-playing', !!(audio && !audio.paused && !audio.ended));
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

    // Map a raw transcript-fetch failure to a short, human toast line. The full
    // raw message (e.g. the multi-line IpBlocked dump) still goes in the drawer.
    function friendlyTranscriptError(reason, message) {
        switch (reason) {
            case 'IpBlocked':
            case 'RequestBlocked':
                return 'YouTube blocked this IP — switch network or set a proxy';
            case 'RateLimitCooldown':
                return message || 'Rate-limited — cooling down a moment';
            case 'TranscriptsDisabled':
                return 'Transcripts are disabled for this video';
            case 'NoTranscriptFound':
            case 'NoTranscriptAvailable':
            case 'NotTranslatable':
                return 'No transcript available for this video';
            case 'VideoUnavailable':
                return 'Video unavailable';
            case 'python-spawn':
            case 'python-exit':
                return 'Transcript helper not running — check the bridge';
            default:
                return `Transcript failed: ${reason || 'unknown'}`;
        }
    }

    async function runSummarize() {
        if (summaryState.running) return;
        summaryState.running = true;
        summaryState.summarized = false;
        summaryState.outputRaw = '';
        summaryState.outputHtml = '';
        summaryState.statusText = 'Fetching transcript…';

        getSummaryFab()?.classList.add('qb-sum-fab-running');
        syncSummaryControls();

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
            syncSummaryControls();
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
                // Surface a SHORT line on-page so failures aren't silent (esp.
                // with the drawer closed during auto-summarize). The full raw
                // message stays in the drawer body above for detail.
                showSummaryToast(friendlyTranscriptError(data.reason, data.message), { error: true });
                summaryState.statusText = '';
                if (status) status.textContent = '';
                summaryState.running = false;
                getSummaryFab()?.classList.remove('qb-sum-fab-running');
                syncSummaryControls();
                return;
            }
        } catch (e) {
            if (body) body.textContent = `Bridge unreachable. Start it:\n  node scripts/claude-bridge.mjs\n\n${e.message}`;
            showSummaryToast('Summary bridge offline — start claude-bridge', { error: true });
            summaryState.statusText = '';
            if (status) status.textContent = '';
            summaryState.running = false;
            getSummaryFab()?.classList.remove('qb-sum-fab-running');
            syncSummaryControls();
            return;
        }

        const settings = await Storage.getSettings();
        const model = settings.claudeModel || 'sonnet';

        const transcriptText = tr.segments.map(s => s.text).join(' ');

        // Compute duration from last segment timestamp
        const lastSegMs = tr.segments.length ? (tr.segments[tr.segments.length - 1].t || 0) : 0;
        const totalSec = Math.round(lastSegMs / 1000);
        const durMin = Math.floor(totalSec / 60);
        const durSec = totalSec % 60;
        const duration = durMin > 0
            ? (durSec > 0 ? `${durMin} min ${durSec} sec` : `${durMin} min`)
            : `${durSec} sec`;

        const profiles = await Storage.getSummaryProfiles();
        const activeProfileId = settings.activeSummaryProfileId || 'standard';
        const activeProfile = profiles.find(p => p.id === activeProfileId) || profiles[0];

        const prompt = (activeProfile.prompt || '')
            .replace('{{title}}', tr.title || '')
            .replace('{{duration}}', duration)
            .replace('{{transcript}}', transcriptText);

        summaryState.statusText = `Summarizing with ${model}…`;
        summaryState.outputRaw = '';
        if (status) status.textContent = summaryState.statusText;
        // Placeholder until the full summary returns (no streaming).
        if (body) { body.hidden = false; body.textContent = 'Summarizing…'; }

        try {
            const t0 = Date.now();
            const res = await fetch(await bridgeUrl('/run'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, model }),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }

            summaryState.outputRaw = data.output || '';
            summaryState.outputHtml = mdToHtml(summaryState.outputRaw);
            summaryState.statusText = `${model} · ${Math.round((data.elapsedMs ?? (Date.now() - t0)) / 100) / 10}s · ${tr.segments.length} segments`;
            summaryState.summarized = true;
            syncTtsFabState();
            playSummaryDoneSound();

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

            // Persist to cache
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

            const s = await Storage.getSettings();

            // Silent auto-summarize: open the panel the moment it's ready, no
            // click needed (it doesn't read aloud — that's the "+ read" toggle).
            if (s.autoSummarizeSilent) openDrawer();

            // Toast + green badge only when drawer is closed
            if (!getSummaryDrawer()?.classList.contains('open')) {
                const label = tr.title ? `Summary ready · ${tr.title}` : 'Summary ready';
                showSummaryToast(label);
                getSummaryFab()?.classList.add('qb-sum-fab-ready');
            }

            // Auto-read when either toggle is on — behaves exactly like clicking
            // "Read summary aloud": shows the generating state, then plays.
            try {
                if ((s.autoSummarize || s.autoTts) && autoReadTriggeredFor !== videoId) {
                    autoReadTriggeredFor = videoId;
                    const ok = await readSummary();
                    if (!ok) autoReadTriggeredFor = null;
                }
            } catch {}
        } catch (e) {
            const liveBody = getSummaryDrawer()?.querySelector('.qb-sum-body');
            const liveStatus = getSummaryDrawer()?.querySelector('.qb-sum-status');
            if (liveBody) liveBody.textContent = `Summary failed: ${e.message}\n\nIf the bridge isn't running, start it:\n  node scripts/claude-bridge.mjs`;
            showSummaryToast(`Summary failed: ${e.message}`, { error: true });
            summaryState.statusText = '';
            if (liveStatus) liveStatus.textContent = '';
        } finally {
            summaryState.running = false;
            getSummaryFab()?.classList.remove('qb-sum-fab-running');
            syncSummaryControls();
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

    // sendMessage to the MV3 service worker, retrying the cold-start race where a
    // sleeping worker drops the first message with "Could not establish
    // connection. Receiving end does not exist." Each attempt also wakes it, so
    // the retry usually lands on a live worker.
    async function sendMessageWithWake(msg, attempts = 4) {
        for (let i = 0; i < attempts; i++) {
            try {
                return await chrome.runtime.sendMessage(msg);
            } catch (e) {
                const m = e?.message || '';
                const transient = m.includes('Receiving end does not exist')
                    || m.includes('Could not establish connection')
                    || m.includes('message port closed');
                if (!transient || i === attempts - 1) {
                    return { ok: false, error: m || 'sendMessage failed' };
                }
                await new Promise(r => setTimeout(r, 150 * (i + 1)));
            }
        }
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
        const text = self.QuickBlockMarkdown?.prepForTts(raw) || raw;
        if (!text.trim()) return false;

        // Invalidate any in-flight request from a previous read.
        const token = ++summaryState.audioToken;
        stopAudio();
        summaryState.ttsLoading = true;
        setReadButtonState(true);
        syncTtsFabState();

        // Check TTS audio cache (3-day TTL, up to 5 videos).
        let cached = null;
        try { cached = await Storage.getTtsAudio(summaryState.videoId); } catch { /* ignore */ }
        if (cached?.dataUrl) {
            if (token !== summaryState.audioToken) {
                summaryState.ttsLoading = false;
                setReadButtonState(false);
                syncTtsFabState();
                return false;
            }
            summaryState.ttsLoading = false;
            setReadButtonState(false);
            syncTtsFabState();
            summaryState.timestamps = cached.timestamps || null;
            playAudio(cached.dataUrl, token);
            return true;
        }

        mountPlayer('loading', 'Generating audio…');

        let res;
        res = await sendMessageWithWake({ type: 'tts-generate', text });

        // A newer request (or cleanup) superseded this one — drop the result.
        if (token !== summaryState.audioToken) {
            summaryState.ttsLoading = false;
            setReadButtonState(false);
            syncTtsFabState();
            return false;
        }

        summaryState.ttsLoading = false;
        setReadButtonState(false);
        syncTtsFabState();

        if (!res?.ok || !res.dataUrl) {
            mountPlayer('error', `TTS failed: ${res?.error || 'unknown'}`);
            return false;
        }

        summaryState.timestamps = res.timestamps || null;

        // Persist audio + timestamps for 3 days so re-reads skip Kokoro.
        Storage.setTtsAudio(summaryState.videoId, res.dataUrl, res.timestamps).catch(() => {});

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
        // Player and the summary-ready toast share the bottom-center slot — clear
        // the toast so they don't stack. The player now carries the status.
        dismissSummaryToast();
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
                <div class="qb-sum-player-speed-wrap">
                    <button class="qb-sum-player-btn qb-sum-player-speed" type="button" aria-label="Playback speed" disabled>1x</button>
                    <div class="qb-sum-player-speed-menu" hidden>
                        <button class="qb-sum-player-speed-option" data-rate="1">1x</button>
                        <button class="qb-sum-player-speed-option" data-rate="1.25">1.25x</button>
                        <button class="qb-sum-player-speed-option" data-rate="1.5">1.5x</button>
                        <button class="qb-sum-player-speed-option" data-rate="1.75">1.75x</button>
                        <button class="qb-sum-player-speed-option" data-rate="2">2x</button>
                    </div>
                </div>
                <button class="qb-sum-player-btn qb-sum-player-kara" type="button" aria-label="Toggle karaoke" title="Hide karaoke" style="display:none">A</button>
                <span class="qb-sum-player-label"></span>
                <input class="qb-sum-player-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek" disabled>
                <span class="qb-sum-player-time">0:00 / 0:00</span>
                <button class="qb-sum-player-btn qb-sum-player-close" type="button" aria-label="Close player">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
                <span class="qb-beam-bloom" aria-hidden="true"></span>
            `;
            document.body.appendChild(el);

            el.querySelector('.qb-sum-player-play').addEventListener('click', togglePlayPause);
            el.querySelector('.qb-sum-player-close').addEventListener('click', closePlayer);
            el.querySelector('.qb-sum-player-speed').addEventListener('click', toggleSpeedMenu);
            el.querySelectorAll('.qb-sum-player-speed-option').forEach(opt => {
                opt.addEventListener('click', () => selectPlaybackSpeed(parseFloat(opt.dataset.rate)));
            });
            el.querySelector('.qb-sum-player-kara').addEventListener('click', toggleKaraokeBox);
            document.addEventListener('click', closeSpeedMenuOutside);

            const seek = el.querySelector('.qb-sum-player-seek');
            seek.addEventListener('input', () => {
                const audio = summaryState.audio;
                if (!audio || !isFinite(audio.duration)) return;
                seek.dataset.seeking = '1';
                const t = (seek.value / 1000) * audio.duration;
                const spd = savedPlaybackRate;
                el.querySelector('.qb-sum-player-time').textContent =
                    `${fmtTime(t / spd)} / ${fmtTime(audio.duration / spd)}`;
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

    function toggleSpeedMenu(e) {
        e.stopPropagation();
        const el = getPlayerEl();
        if (!el) return;
        const menu = el.querySelector('.qb-sum-player-speed-menu');
        if (!menu) return;
        menu.hidden = !menu.hidden;
        if (!menu.hidden) {
            menu.querySelectorAll('.qb-sum-player-speed-option').forEach(opt => {
                opt.classList.toggle('active', parseFloat(opt.dataset.rate) === savedPlaybackRate);
            });
        }
    }

    function closeSpeedMenuOutside(e) {
        const el = getPlayerEl();
        if (!el) return;
        const wrap = el.querySelector('.qb-sum-player-speed-wrap');
        if (wrap && wrap.contains(e.target)) return;
        const menu = el.querySelector('.qb-sum-player-speed-menu');
        if (menu) menu.hidden = true;
    }

    function selectPlaybackSpeed(rate) {
        savedPlaybackRate = rate;
        chrome.storage.local.set({ ttsPlaybackRate: rate });
        if (summaryState.audio) summaryState.audio.playbackRate = rate;
        const el = getPlayerEl();
        if (!el) return;
        const btn = el.querySelector('.qb-sum-player-speed');
        if (btn) btn.textContent = formatRate(rate);
        // Update time display for new speed
        const audio = summaryState.audio;
        if (audio) {
            const spd = rate;
            el.querySelector('.qb-sum-player-time').textContent =
                `${fmtTime(audio.currentTime / spd)} / ${fmtTime((audio.duration || 0) / spd)}`;
        }
        // Close menu
        const menu = el.querySelector('.qb-sum-player-speed-menu');
        if (menu) menu.hidden = true;
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

        // Karaoke: build the word list from timestamps (if Kokoro returned any)
        // and mount the pill above the player. The cluster toggle mounts either
        // way so the player can still be hidden without timestamps.
        summaryState.karaokeEnabled = karaokeEnabled;
        summaryState.karaokeWordCount = karaokeWordCount;
        summaryState.karaokeHidden = false;
        summaryState.words = buildKaraokeWords(summaryState.timestamps);
        summaryState.curWordIdx = -1;
        if (summaryState.words.length && karaokeEnabled) mountKaraoke();
        else removeKaraokeEl();
        mountClusterToggle();

        audio.addEventListener('loadedmetadata', () => {
            const el = getPlayerEl();
            if (!el) return;
            const spd = savedPlaybackRate;
            el.querySelector('.qb-sum-player-time').textContent =
                `0:00 / ${fmtTime(audio.duration / spd)}`;
        });
        audio.addEventListener('timeupdate', () => {
            const el = getPlayerEl();
            if (!el) return;
            const seek = el.querySelector('.qb-sum-player-seek');
            if (seek.dataset.seeking !== '1' && isFinite(audio.duration) && audio.duration > 0) {
                seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
            }
            const spd = savedPlaybackRate;
            el.querySelector('.qb-sum-player-time').textContent =
                `${fmtTime(audio.currentTime / spd)} / ${fmtTime((audio.duration || 0) / spd)}`;
        });
        // Karaoke runs on rAF (not timeupdate which only fires ~4x/sec) so short
        // words don't get skipped. Loop self-stops when audio pauses/ends.
        function startKaraokeRaf() {
            if (summaryState.karaokeRaf) return;
            function tick() {
                const a = summaryState.audio;
                if (!a || a.paused || a.ended) { summaryState.karaokeRaf = null; return; }
                if (summaryState.words.length) updateKaraoke(a.currentTime);
                summaryState.karaokeRaf = requestAnimationFrame(tick);
            }
            summaryState.karaokeRaf = requestAnimationFrame(tick);
        }
        audio.addEventListener('play', startKaraokeRaf);
        audio.addEventListener('pause', () => {
            if (summaryState.karaokeRaf) { cancelAnimationFrame(summaryState.karaokeRaf); summaryState.karaokeRaf = null; }
        });
        audio.addEventListener('play', () => { mountPlayer('playing', ''); setPlayPauseIcon(false); syncTtsFabState(); });
        audio.addEventListener('pause', () => {
            // 'pause' also fires when the audio ends — keep the player visible but
            // flip the icon.
            if (!audio.ended) { mountPlayer('paused', ''); }
            setPlayPauseIcon(true);
            syncTtsFabState();
        });
        audio.addEventListener('ended', () => {
            mountPlayer('paused', 'Finished');
            setPlayPauseIcon(true);
            syncTtsFabState();
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
        if (summaryState.karaokeRaf) { cancelAnimationFrame(summaryState.karaokeRaf); summaryState.karaokeRaf = null; }
        audio._intentionalStop = true;
        try { audio.pause(); } catch {}
        try { audio.src = ''; } catch {}
        summaryState.audio = null;
        syncTtsFabState();
    }

    function closePlayer() {
        summaryState.audioToken++;  // invalidate any in-flight TTS
        summaryState.ttsLoading = false;
        setReadButtonState(false);
        stopAudio();
        closeKaraoke();
        closeClusterToggle();
        const el = getPlayerEl();
        if (!el) return;
        el.classList.remove('show');
        setTimeout(() => el.remove(), 250);
    }

    // ── Karaoke pill: N rolling words centered on the current one (pastel red),
    // word-level sync to Kokoro timestamps. Fixed width (~70% of player). Word
    // count + on/off come from settings. ─────────────────────────────────────

    function getKaraokeEl() { return document.getElementById(KARAOKE_ID); }
    function getClusterToggleEl() { return document.getElementById(CLUSTER_TOGGLE_ID); }

    // Clamp word count to an odd number in [1,9] so the current word stays
    // centered with balanced sides.
    function normalizeWordCount(n) {
        let v = Math.floor(Number(n));
        if (!Number.isFinite(v) || v < 1) v = 3;
        if (v > 9) v = 9;
        if (v % 2 === 0) v += 1;
        return v;
    }

    function karaokeSideCount() {
        return Math.max(0, (normalizeWordCount(summaryState.karaokeWordCount) - 1) / 2);
    }

    // Normalize Kokoro timestamps into display words: standalone punctuation
    // tokens (",", ".", "?"…) are glued onto the previous word so the karaoke
    // shows real words, not lone punctuation.
    function buildKaraokeWords(timestamps) {
        if (!Array.isArray(timestamps)) return [];
        const out = [];
        const isPunct = (s) => /^[^\p{L}\p{N}]+$/u.test(s);
        for (const t of timestamps) {
            const w = (t?.word ?? '').trim();
            if (!w) continue;
            const start = Number(t.start_time) || 0;
            const end = Number(t.end_time) || start;
            if (isPunct(w) && out.length) {
                out[out.length - 1].text += w;
                out[out.length - 1].end = end;
            } else {
                out.push({ text: w, start, end });
            }
        }
        return out;
    }

    // First word whose end time is past t (i.e. the one being / about to be
    // spoken). Clamps to the first word before audio reaches it.
    function findWordIdx(words, t) {
        if (!words.length) return -1;
        if (t < words[0].start) return 0;
        for (let i = 0; i < words.length; i++) {
            if (t < words[i].end) return i;
        }
        return words.length - 1;
    }

    function mountKaraoke() {
        if (!summaryState.words.length || !summaryState.karaokeEnabled) return;
        let el = getKaraokeEl();
        if (!el) {
            el = document.createElement('div');
            el.id = KARAOKE_ID;
            document.body.appendChild(el);
            requestAnimationFrame(() => el.classList.add('show'));
        }
        // (Re)build slots for the configured word count; middle slot = current.
        const side = karaokeSideCount();
        let html = '';
        for (let off = -side; off <= side; off++) {
            const cls = off === 0 ? 'qb-kara-word qb-kara-cur' : 'qb-kara-word qb-kara-side';
            html += `<span class="${cls}" data-off="${off}"></span>`;
        }
        el.innerHTML = html;
        summaryState.curWordIdx = -1;
        sizeKaraoke();
        updateKaraoke(summaryState.audio?.currentTime || 0);
        applyClusterVisibility();
    }

    // Pin width to ~70% of the player so words don't grow/shrink the box.
    function sizeKaraoke() {
        const el = getKaraokeEl();
        const player = getPlayerEl();
        if (!el || !player) return;
        const pw = player.getBoundingClientRect().width;
        if (pw > 0) el.style.width = Math.round(pw * 0.7) + 'px';
        if (!summaryState._playerRO && 'ResizeObserver' in window) {
            summaryState._playerRO = new ResizeObserver(() => sizeKaraoke());
            summaryState._playerRO.observe(player);
        }
    }

    function updateKaraoke(t) {
        const words = summaryState.words;
        const el = getKaraokeEl();
        if (!words.length || !el) return;
        const idx = findWordIdx(words, t);
        if (idx === summaryState.curWordIdx) return;   // word-level: change only
        summaryState.curWordIdx = idx;
        el.querySelectorAll('.qb-kara-word').forEach(span => {
            const wi = idx + (Number(span.dataset.off) || 0);
            span.textContent = (wi >= 0 && wi < words.length) ? words[wi].text : '';
        });
    }

    // Remove the karaoke DOM element + resize observer but KEEP the word list,
    // so toggling the feature back on can re-render without a re-fetch.
    function removeKaraokeEl() {
        const el = getKaraokeEl();
        if (el) {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 200);
        }
        if (summaryState._playerRO) {
            summaryState._playerRO.disconnect();
            summaryState._playerRO = null;
        }
        summaryState.curWordIdx = -1;
    }

    // Full teardown when the player itself closes.
    function closeKaraoke() {
        removeKaraokeEl();
        summaryState.words = [];
        summaryState.karaokeHidden = false;
    }

    // Re-apply enable/word-count live (settings changed mid-playback).
    function applyKaraokeSettings() {
        summaryState.karaokeEnabled = karaokeEnabled;
        summaryState.karaokeWordCount = karaokeWordCount;
        if (!summaryState.audio) return;
        if (karaokeEnabled && summaryState.words.length) mountKaraoke();
        else removeKaraokeEl();
        applyClusterVisibility();
    }

    // ── Hide/show controls ───────────────────────────────────────────────────
    // Chip  → clusterHidden: hides BOTH player + karaoke (audio plays on).
    // "A"   → karaokeHidden: hides ONLY the karaoke box.

    function mountClusterToggle() {
        if (getClusterToggleEl()) { applyClusterVisibility(); return; }
        const btn = document.createElement('button');
        btn.id = CLUSTER_TOGGLE_ID;
        btn.type = 'button';
        btn.className = 'qb-cluster-toggle';
        btn.innerHTML = `
            <svg class="qb-cluster-toggle-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
        `;
        document.body.appendChild(btn);
        btn.addEventListener('click', toggleCluster);
        requestAnimationFrame(() => btn.classList.add('show'));
        applyClusterVisibility();
    }

    function toggleCluster() {
        summaryState.clusterHidden = !summaryState.clusterHidden;
        applyClusterVisibility();
    }

    function toggleKaraokeBox() {
        summaryState.karaokeHidden = !summaryState.karaokeHidden;
        applyClusterVisibility();
    }

    // Single source of truth for player + karaoke + chip + "A" button states.
    function applyClusterVisibility() {
        const hideAll = summaryState.clusterHidden;
        getPlayerEl()?.classList.toggle('qb-cluster-hidden', hideAll);

        const showKara = summaryState.karaokeEnabled
            && summaryState.words.length > 0
            && !hideAll
            && !summaryState.karaokeHidden;
        getKaraokeEl()?.classList.toggle('qb-kara-off', !showKara);

        const chip = getClusterToggleEl();
        if (chip) {
            chip.classList.toggle('collapsed', hideAll);
            const label = hideAll ? 'Show player' : 'Hide player';
            chip.setAttribute('aria-label', label);
            chip.title = label;
        }

        const aBtn = getPlayerEl()?.querySelector('.qb-sum-player-kara');
        if (aBtn) {
            const available = summaryState.karaokeEnabled && summaryState.words.length > 0;
            aBtn.style.display = available ? '' : 'none';
            aBtn.classList.toggle('active', available && !summaryState.karaokeHidden);
            const label = summaryState.karaokeHidden ? 'Show karaoke' : 'Hide karaoke';
            aBtn.setAttribute('aria-label', label);
            aBtn.title = label;
        }
    }

    function closeClusterToggle() {
        const btn = getClusterToggleEl();
        if (btn) {
            btn.classList.remove('show');
            setTimeout(() => btn.remove(), 200);
        }
        summaryState.clusterHidden = false;
    }

    // Pleasant "summary done" chime — ascending C-E-G-C major arpeggio with a
    // soft bell timbre. Synthesized inline via Web Audio (no asset needed),
    // styled after the browser-sounds presets.
    let summaryAudioCtx = null;
    function playSummaryDoneSound() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            if (!summaryAudioCtx) summaryAudioCtx = new Ctx();
            const ctx = summaryAudioCtx;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});

            const t0 = ctx.currentTime;
            const master = ctx.createGain();
            master.gain.value = 0.22;
            master.connect(ctx.destination);

            const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
            notes.forEach((freq, i) => {
                const t = t0 + i * 0.09;
                const g = ctx.createGain();
                g.connect(master);
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
                g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);

                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = freq;
                osc.connect(g);

                // Shimmer overtone an octave up, quieter.
                const oscHi = ctx.createOscillator();
                const gHi = ctx.createGain();
                oscHi.type = 'triangle';
                oscHi.frequency.value = freq * 2;
                gHi.gain.value = 0.18;
                oscHi.connect(gHi);
                gHi.connect(g);

                osc.start(t); oscHi.start(t);
                osc.stop(t + 0.6); oscHi.stop(t + 0.6);
            });
        } catch {}
    }

    function showSummaryToast(label, opts = {}) {
        dismissSummaryToast();
        const toast = document.createElement('div');
        toast.id = SUMMARY_TOAST_ID;
        toast.className = 'qb-sum-toast' + (opts.error ? ' qb-sum-toast-error' : '');
        toast.setAttribute('role', 'button');
        toast.tabIndex = 0;
        toast.innerHTML = `<span class="qb-sum-toast-dot"></span><span class="qb-sum-toast-text"></span><span class="qb-beam-bloom" aria-hidden="true"></span>`;
        toast.querySelector('.qb-sum-toast-text').textContent = label;
        const activate = () => { openDrawer(); };
        toast.addEventListener('click', activate);
        toast.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        // Errors linger a little longer so they're readable.
        summaryState.toastTimer = setTimeout(dismissSummaryToast, opts.error ? 9000 : 6000);
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
        document.getElementById(DESC_TOGGLE_ID)?.remove();
        document.getElementById(PLAYLIST_TOGGLE_ID)?.remove();
        document.getElementById(SUMMARY_TTS_FAB_ID)?.remove();
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
        resetPlaylistPanelState();   // new video → forget chapters/mode, re-derive from URL
        applyPlaylistPanelMode();
        applyOnWatchClass();
        applyWatchAutomations();
        applyFocusMode();
        injectFocusFab();
        removeSummaryUI();
        if (currentWatchVideoId()) {
            setTimeout(() => { injectSummaryUI(); tryAutoSummarize(); injectWatchStats(); }, 400);
        } else {
            // Landing on a feed page (home/subscriptions). YouTube's SPA restores
            // cached feed nodes that still carry the HIDE_CHECKED_ATTR latch from a
            // previous visit, so videos added to Watch Later this session never get
            // re-evaluated — looked like the page needed a manual refresh. rescanAll()
            // clears the latch and re-checks. Re-run because the feed mounts async.
            rescanAll();
            setTimeout(rescanAll, 300);
            setTimeout(rescanAll, 1000);
        }
    });
    // Also fire on initial load (event may have already passed)
    if (document.readyState === 'complete') {
        applyWatchAutomations();
        if (currentWatchVideoId()) { injectSummaryUI(); tryAutoSummarize(); injectWatchStats(); }
    } else {
        window.addEventListener('load', () => {
            applyWatchAutomations();
            if (currentWatchVideoId()) { injectSummaryUI(); tryAutoSummarize(); injectWatchStats(); }
        });
    }

    // ── Init ───────────────────────────────────────────────────────────────────
    async function loadStateAndRescan() {
        wlIds = await Storage.getWlIds();
        const settings = await Storage.getSettings();
        hideEnabled = settings.hideEnabled !== false;
        karaokeEnabled = settings.karaokeEnabled !== false;
        karaokeWordCount = normalizeWordCount(settings.karaokeWordCount);
        applyBottomCommentsToggle(settings.hideBottomComments);
        applyShareToggle(settings.hideShareButton);
        applyThanksToggle(settings.hideThanksButton);
        applySearchOnWatchToggle(settings.hideSearchOnWatch);
        applyDescriptionToggle(settings.hideDescription);
        applyWatchStatsToggle(settings.hideWatchStats);
        applyTeaserCarouselToggle(settings.hideTeaserCarousel);
        applyMiniGuideToggle(settings.hideMiniGuide);
        applyAutoHideMastheadToggle(settings.autoHideMasthead);
        applyCinemaToggle(settings.cinemaMode);
        resetPlaylistPanelState();   // no memory — derive from current URL
        applyPlaylistPanelMode();
        focusModeEnabled = !!settings.focusModeEnabled;
        focusDays = Array.isArray(settings.focusDays) ? settings.focusDays : [];
        focusStart = settings.focusStart || '09:00';
        focusEnd = settings.focusEnd || '17:00';
        focusHideNow = !!settings.focusHideNow;
        if (typeof settings.focusMessage === 'string') focusMessage = settings.focusMessage;
        focusBeam = settings.focusBeam !== false;
        focusLockUntil = Number(settings.focusLockUntil) || 0;
        applyOnWatchClass();
        applyFocusMode();
        rescanAll();
    }

    // ── Auto-hide masthead on scroll (home feed only) ───────────────────────────
    // Slide the top bar up when scrolling down, back on scroll up. Home only —
    // watch/search pages keep the header put. rAF-throttled read of scrollY.
    function setupMastheadAutoHide() {
        let lastY = window.scrollY;
        let ticking = false;
        const REVEAL_AT_TOP = 80;   // always show near the top

        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                ticking = false;
                const onHome = autoHideMasthead && location.pathname === '/';
                if (!onHome) {
                    document.body.classList.remove('quick-block-masthead-hidden');
                    lastY = window.scrollY;
                    return;
                }
                const y = window.scrollY;
                const hide = y > REVEAL_AT_TOP && y > lastY;
                document.body.classList.toggle('quick-block-masthead-hidden', hide);
                lastY = y;
            });
        }
        window.addEventListener('scroll', onScroll, { passive: true });
    }

    async function init() {
        await loadStateAndRescan();
        setupMastheadAutoHide();
        injectFocusFab();
        injectWatchCounter();
        processVideos();
        setTimeout(processVideos, 500);
        setTimeout(processVideos, 1500);

        const observer = new MutationObserver(() => {
            // Extension reloaded/updated → this script is orphaned. Every chrome.*
            // call below throws "Extension context invalidated" forever. Stop.
            if (!extensionAlive()) { observer.disconnect(); return; }
            processVideos();
            // Self-heal summary UI on SPA nav: yt-navigate-finish sometimes fires
            // before the masthead is ready, or doesn't fire at all on home→video
            // transitions. Both inject functions are idempotent and bail fast if
            // already mounted, so this is cheap.
            if (currentWatchVideoId() && !getSummaryFab()) injectSummaryUI();
            // Mirror views · time ago into #actions. Self-heals: the info text and
            // #actions row mount async after nav. Idempotent, bails fast once set.
            if (currentWatchVideoId()) injectWatchStats();
            // Inline "hide description" toggle lives inside YT's subscribe button,
            // which rebuilds on nav — re-inject only when missing (idempotent, bails
            // fast once set). The hide state itself is a body class, so CSS reapplies
            // it to the rebuilt description box with no extra work here.
            if (currentWatchVideoId() && !document.getElementById(DESC_TOGGLE_ID)) injectDescriptionToggle();
            // Cinema toggle lives in the player bar, which mounts async and can
            // rebuild — re-inject only when missing (idempotent, bails fast).
            if (currentWatchVideoId() && !document.getElementById(CINEMA_BTN_ID)) injectCinemaButton();
            // Playlist panel mounts async after nav and is absent on non-playlist
            // pages. Reconcile every tick (not just when missing): the pill must
            // also disappear if the playlist panel is closed while it's mounted.
            // injectPlaylistToggle is idempotent — bails fast when state is settled,
            // removes the pill + clears the body classes when no panel is present.
            if (currentWatchVideoId()) injectPlaylistToggle();
            // Same self-heal for auto-open comments — the comments toggle often
            // mounts after yt-navigate-finish, leaving the original click attempt
            // with nothing to click. Latched per videoId so we don't spam clicks.
            tryAutoOpenComments();
            // Auto-summarize when the master toggle is on. Latched per videoId.
            tryAutoSummarize();
            // Focus mode: the home browse element rebuilds on nav — re-inject the
            // message only when it's actually missing. Re-injecting every tick
            // would write the DOM and retrigger this observer → freeze.
            if (focusActive && !document.getElementById(FOCUS_MSG_ID)) injectFocusMessage();
            // Masthead focus toggle: re-inject only when missing (idempotent,
            // bails fast once mounted so it can't loop the observer).
            if (!getFocusFab()) injectFocusFab();
            // Watch counter sits after the hide-description toggle, so it can
            // only mount once that button exists (both self-heal here).
            if (currentWatchVideoId() && !document.getElementById(WATCH_COUNTER_ID)) injectWatchCounter();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Focus mode window can start/end while the tab sits open — re-check.
        applyFocusMode();
        setInterval(applyFocusMode, 30000);

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
