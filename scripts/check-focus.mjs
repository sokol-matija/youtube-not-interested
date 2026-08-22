// Mirrors focusPageEl() in content.js. The one bit that can go badly wrong is
// the Watch Later test — too loose and it blanks every playlist you open.
import assert from 'node:assert/strict';

const FOCUS_SUBTYPES = ['home', 'subscriptions', 'history', 'library', 'you'];
const isWatchLater = (search) => /[?&]list=WL(&|$)/.test(search);
const blocks = (subtype, search = '') =>
    FOCUS_SUBTYPES.includes(subtype) || (subtype === 'playlist' && isWatchLater(search));

assert.ok(blocks('home'));
assert.ok(blocks('subscriptions'));
assert.ok(blocks('history'));
assert.ok(blocks('library'));
assert.ok(blocks('you'));   // YouTube renamed Library -> You
assert.ok(blocks('playlist', '?list=WL'));
assert.ok(blocks('playlist', '?foo=1&list=WL&bar=2'));

assert.ok(!blocks('playlist', '?list=WLabc'));   // must not match a WL-prefixed id
assert.ok(!blocks('playlist', '?list=PL123'));   // a playlist you chose stays visible
assert.ok(!blocks('playlist', ''));
assert.ok(!blocks('watch'));
assert.ok(!blocks('search'));
assert.ok(!blocks('channels'));


// ── Preset detection (mirrors detectFocusPreset in options.js) ────────────────
// The trap: focusDays comes back from storage in whatever order it was written,
// so a raw array compare would report "Custom" for a preset that is actually on.
const PRESETS = {
    workday: { focusDays: [1, 2, 3, 4, 5], focusStart: '07:00', focusEnd: '12:00' },
    exam: { focusDays: [0, 1, 2, 3, 4, 5, 6], focusStart: '00:00', focusEnd: '23:59' },
};
const dayKey = (d) => (Array.isArray(d) ? d : []).slice().sort((a, b) => a - b).join(',');
const detect = (s) => Object.entries(PRESETS).find(([, p]) =>
    dayKey(p.focusDays) === dayKey(s.focusDays)
    && p.focusStart === s.focusStart && p.focusEnd === s.focusEnd)?.[0] ?? 'custom';

assert.equal(detect({ focusDays: [1, 2, 3, 4, 5], focusStart: '07:00', focusEnd: '12:00' }), 'workday');
assert.equal(detect({ focusDays: [5, 1, 3, 2, 4], focusStart: '07:00', focusEnd: '12:00' }), 'workday'); // order must not matter
assert.equal(detect({ focusDays: [0, 1, 2, 3, 4, 5, 6], focusStart: '00:00', focusEnd: '23:59' }), 'exam');
assert.equal(detect({ focusDays: [1, 2, 3, 4, 5], focusStart: '06:00', focusEnd: '12:00' }), 'custom');
assert.equal(detect({ focusDays: [1, 2, 3], focusStart: '07:00', focusEnd: '12:00' }), 'custom');
assert.equal(detect({}), 'custom');


// ── End date (mirrors focusUntilMs in content.js) ─────────────────────────────
// Off by one day here either lifts the block the night before the exam or keeps
// it on past the day you were promised, so both boundaries are pinned.
const untilMs = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    if (!m) return 0;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
};
const expired = (v, now) => { const u = untilMs(v); return !!u && now >= u; };

const sep3 = untilMs('2026-09-03');
assert.equal(new Date(sep3).getDate(), 3);
assert.equal(new Date(sep3).getHours(), 0);            // start of the day, not the end

assert.ok(!expired('2026-09-03', new Date(2026, 8, 2, 23, 59).getTime()));  // exam evening: still blocked
assert.ok(expired('2026-09-03', new Date(2026, 8, 3, 0, 0).getTime()));     // free the moment the 3rd starts

assert.equal(untilMs(''), 0);
assert.equal(untilMs('2026-9-3'), 0);                  // unpadded is not a date we accept
assert.equal(untilMs('nonsense'), 0);
assert.ok(!expired('', Date.now()));                   // no end date never expires


// ── All-day detection (mirrors focusWindowMinutes in content.js) ──────────────
const winMin = (a, b) => {
    const toMin = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };
    const x = toMin(a), y = toMin(b);
    if (x === null || y === null || x === y) return 0;
    return y > x ? y - x : 1440 - (x - y);
};
const allDay = (a, b) => winMin(a, b) >= 1435;

assert.equal(winMin('00:00', '23:59'), 1439);
assert.equal(winMin('07:00', '12:00'), 300);
assert.equal(winMin('22:00', '06:00'), 480);   // overnight
assert.equal(winMin('09:00', '09:00'), 0);     // start === end is not a window

assert.ok(allDay('00:00', '23:59'));           // exam preset: no countdown
assert.ok(!allDay('07:00', '12:00'));          // workday: countdown is useful
assert.ok(!allDay('22:00', '06:00'));

console.log('focus page matcher + preset detection + end date + all-day ok');
