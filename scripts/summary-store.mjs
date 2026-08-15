// Storage + prompt + notification layer for the phone summary path.
//
// One JSON file per video under data/summaries/. Deliberately uncapped: the
// extension's chrome.storage cache evicts at 50 entries (lib/storage.js
// SUMMARY_CACHE_CAP), and the whole point of this path is a durable history you
// can scroll on the phone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

export const DATA_DIR = process.env.YT_SUMMARY_DIR || path.join(REPO_ROOT, 'data', 'summaries');
const PROFILES_PATH = path.join(REPO_ROOT, 'lib', 'summary-profiles.json');

// ── Video ID ────────────────────────────────────────────────────────────────

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Pull an 11-char video ID out of any YouTube URL shape, or out of a bare ID.
 * Android share text is often "Title\nhttps://youtu.be/ID?si=..." so we scan
 * the whole string rather than requiring it to parse as a lone URL.
 */
export function parseVideoId(input) {
    if (typeof input !== 'string') return null;
    const text = input.trim();
    if (VIDEO_ID_RE.test(text)) return text;

    // youtu.be/ID · /watch?v=ID · /shorts/ID · /live/ID · /embed/ID · /v/ID
    const patterns = [
        /youtu\.be\/([A-Za-z0-9_-]{11})/,
        /[?&]v=([A-Za-z0-9_-]{11})/,
        /\/shorts\/([A-Za-z0-9_-]{11})/,
        /\/live\/([A-Za-z0-9_-]{11})/,
        /\/embed\/([A-Za-z0-9_-]{11})/,
        /\/v\/([A-Za-z0-9_-]{11})/,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m) return m[1];
    }
    return null;
}

// ── Profiles ────────────────────────────────────────────────────────────────

let profileCache = null;

export function getProfiles() {
    if (!profileCache) {
        const raw = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
        profileCache = raw.profiles;
    }
    return profileCache;
}

export function getProfile(id) {
    const profiles = getProfiles();
    return profiles.find(p => p.id === id) || profiles[0];
}

/**
 * Fill {{title}} / {{duration}} / {{transcript}} placeholders.
 *
 * Uses replaceAll where content.js:1645 uses replace — the single-occurrence
 * version silently drops the second use of a placeholder, which matters here
 * because the phone lets you type an arbitrary prompt.
 */
export function renderPrompt(promptTemplate, { title, duration, transcript }) {
    return String(promptTemplate)
        .replaceAll('{{title}}', title || '')
        .replaceAll('{{duration}}', duration || '')
        .replaceAll('{{transcript}}', transcript || '');
}

/** Mirrors content.js:1631-1637 so phone and extension report runtime identically. */
export function formatDuration(totalSec) {
    const sec = Math.max(0, Math.round(totalSec));
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    if (min <= 0) return `${rem} sec`;
    return rem > 0 ? `${min} min ${rem} sec` : `${min} min`;
}

/** Transcript text exactly as the extension builds it (content.js:1629). */
export function segmentsToText(segments) {
    return (segments || []).map(s => s.text).join(' ');
}

export function durationFromSegments(segments) {
    if (!segments || !segments.length) return 0;
    return Math.round((segments[segments.length - 1].t || 0) / 1000);
}

// ── Records ─────────────────────────────────────────────────────────────────

function recordPath(videoId) {
    return path.join(DATA_DIR, `${videoId}.json`);
}

export function readRecord(videoId) {
    if (!VIDEO_ID_RE.test(videoId)) return null;
    try {
        return JSON.parse(fs.readFileSync(recordPath(videoId), 'utf8'));
    } catch {
        return null;
    }
}

export function writeRecord(rec) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write-then-rename so a crash mid-write can't leave a truncated record
    // that readRecord would silently treat as "missing".
    const target = recordPath(rec.videoId);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, target);
    return rec;
}

/** Newest first. Transcript and markdown are stripped — this feeds the list screen. */
export function listRecords(limit = 200) {
    let names;
    try {
        names = fs.readdirSync(DATA_DIR).filter(n => n.endsWith('.json'));
    } catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        const rec = readRecord(name.slice(0, -5));
        if (!rec) continue;
        out.push({
            videoId: rec.videoId,
            title: rec.title,
            author: rec.author,
            url: rec.url,
            ts: rec.ts,
            durationSec: rec.durationSec,
            profileId: rec.profileId,
            model: rec.model,
            status: rec.status,
            error: rec.error || null,
            versionCount: (rec.versions || []).length,
        });
    }
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out.slice(0, limit);
}

// ── Title lookup ────────────────────────────────────────────────────────────

/**
 * oEmbed is a public, unauthenticated endpoint — same trust model as the
 * transcript path (no cookies, no key). Title is cosmetic, so any failure
 * falls back to the bare video ID rather than failing the job.
 */
export async function fetchTitle(videoId) {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { title: videoId, author: '' };
        const data = await res.json();
        return { title: data.title || videoId, author: data.author_name || '' };
    } catch {
        return { title: videoId, author: '' };
    }
}

// ── Push ────────────────────────────────────────────────────────────────────

/**
 * ntfy push. The phone already has io.heckel.ntfy installed and subscribed to
 * the default topic, so this needs no setup on the device.
 *
 * Click opens ytsum://summary/<id>, a custom scheme the Android app claims
 * outright — no Digital Asset Links, no browser disambiguation dialog.
 */
export async function notify(topic, { title, message, videoId }) {
    if (!topic) return { ok: false, reason: 'no-topic' };
    try {
        const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
            method: 'POST',
            headers: {
                'Title': asciiHeader(title),
                'Click': `ytsum://summary/${videoId}`,
                'Tags': 'clapper',
            },
            body: message || '',
            signal: AbortSignal.timeout(10000),
        });
        return { ok: res.ok, status: res.status };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

// HTTP header values must be latin-1; video titles are full of em dashes and
// emoji, which throw in undici's header validation and would otherwise take the
// whole notification down.
function asciiHeader(s) {
    return String(s || '')
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 200) || 'Summary ready';
}

// ── Self-check ──────────────────────────────────────────────────────────────
// node scripts/summary-store.mjs   → asserts the parsing/formatting logic.

if (process.argv[1] && process.argv[1].endsWith('summary-store.mjs')) {
    const assert = (await import('node:assert')).strict;

    assert.equal(parseVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('Some title\nhttps://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(parseVideoId('https://example.com/nope'), null);
    assert.equal(parseVideoId(null), null);

    assert.equal(formatDuration(0), '0 sec');
    assert.equal(formatDuration(45), '45 sec');
    assert.equal(formatDuration(60), '1 min');
    assert.equal(formatDuration(3725), '62 min 5 sec');

    assert.equal(durationFromSegments([{ t: 0 }, { t: 61_000 }]), 61);
    assert.equal(durationFromSegments([]), 0);
    assert.equal(segmentsToText([{ text: 'a' }, { text: 'b' }]), 'a b');

    // replaceAll, not replace — a template using {{transcript}} twice must get both.
    assert.equal(
        renderPrompt('{{title}} {{transcript}} {{transcript}}', { title: 'T', transcript: 'X' }),
        'T X X',
    );

    assert.equal(asciiHeader('Why — I 🎬 code'), 'Why  I  code');
    assert.equal(asciiHeader(''), 'Summary ready');

    const profiles = getProfiles();
    assert.ok(profiles.length === 6, `expected 6 profiles, got ${profiles.length}`);
    assert.equal(getProfile('briefing').id, 'briefing');
    assert.equal(getProfile('nonexistent').id, 'standard', 'unknown id falls back to first');
    assert.ok(getProfile('standard').prompt.includes('{{transcript}}'));

    console.log('summary-store self-check OK');
}
