#!/usr/bin/env node
// Local bridge: extension POSTs prompt → spawns `claude -p` → returns stdout.
// Run: node scripts/claude-bridge.mjs              (defaults to PORT=7777)
//      PORT=7779 node scripts/claude-bridge.mjs    (mac, to avoid VoiceMode on 7777)
// Ctrl-C to stop.

import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT) || 7777;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'haiku';
// Path to a Python interpreter with `youtube-transcript-api` installed.
// Default points to project-local venv at scripts/.venv.
// Setup: python3 -m venv scripts/.venv && scripts/.venv/bin/pip install youtube-transcript-api
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENV_PY = process.platform === 'win32'
    ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '.venv', 'bin', 'python');
const YTT_PYTHON = process.env.YTT_PYTHON || VENV_PY;
// Transcript proxy mode (see runYtt). Set WEBSHARE_PROXY_USERNAME/PASSWORD for
// Webshare residential, or YTT_HTTP_PROXY/YTT_HTTPS_PROXY for a generic proxy.
const PROXY_MODE = (process.env.WEBSHARE_PROXY_USERNAME && process.env.WEBSHARE_PROXY_PASSWORD)
    ? 'webshare'
    : (process.env.YTT_HTTP_PROXY || process.env.YTT_HTTPS_PROXY) ? 'generic' : 'none';
// Hard cap to avoid runaway invocations
const MAX_INPUT_CHARS = 200_000;

// Bound to 127.0.0.1 below — only local processes can reach this. Origin allowlist
// keeps stray local pages from probing the bridge while still letting the extension
// (popup + YouTube content script) through.
const ALLOWED_ORIGINS = new Set([
    'https://www.youtube.com',
    'https://m.youtube.com',
]);
const ALLOWED_ORIGIN_PREFIXES = ['chrome-extension://', 'moz-extension://'];

function isOriginAllowed(origin) {
    if (!origin) return true; // same-origin / curl-style requests
    if (ALLOWED_ORIGINS.has(origin)) return true;
    return ALLOWED_ORIGIN_PREFIXES.some(p => origin.startsWith(p));
}

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin || '*',
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
    };
}

async function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
            if (data.length > MAX_INPUT_CHARS + 4096) {
                reject(new Error('payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function runYtt(videoId) {
    return new Promise((resolve) => {
        const script = `
import sys, json, os
from youtube_transcript_api import YouTubeTranscriptApi
try:
    # Optional proxy to dodge YouTube IP bans. Webshare residential proxies are
    # supported natively (rotating); a generic HTTP/HTTPS proxy also works.
    #   Webshare:  WEBSHARE_PROXY_USERNAME / WEBSHARE_PROXY_PASSWORD
    #   Generic:   YTT_HTTP_PROXY / YTT_HTTPS_PROXY  (e.g. http://user:pass@host:port)
    proxy_config = None
    wu = os.environ.get('WEBSHARE_PROXY_USERNAME')
    wp = os.environ.get('WEBSHARE_PROXY_PASSWORD')
    hp = os.environ.get('YTT_HTTP_PROXY')
    sp = os.environ.get('YTT_HTTPS_PROXY')
    if wu and wp:
        from youtube_transcript_api.proxies import WebshareProxyConfig
        proxy_config = WebshareProxyConfig(proxy_username=wu, proxy_password=wp)
    elif hp or sp:
        from youtube_transcript_api.proxies import GenericProxyConfig
        proxy_config = GenericProxyConfig(http_url=(hp or sp), https_url=(sp or hp))
    api = YouTubeTranscriptApi(proxy_config=proxy_config) if proxy_config else YouTubeTranscriptApi()
    fetched = api.fetch(sys.argv[1])
    out = {
        'ok': True,
        'language': fetched.language_code,
        'isAsr': fetched.is_generated,
        'videoId': sys.argv[1],
        'segments': [{'t': int(s.start * 1000), 'text': s.text} for s in fetched.snippets],
    }
    sys.stdout.write(json.dumps(out))
except Exception as e:
    sys.stdout.write(json.dumps({'ok': False, 'reason': type(e).__name__, 'message': str(e)}))
`;
        const proc = spawn(YTT_PYTHON, ['-c', script, videoId], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '', spawnErr = null;
        proc.on('error', e => {
            spawnErr = e;
            const msg = e.code === 'ENOENT'
                ? `Python not found at "${YTT_PYTHON}". Setup: python3 -m venv scripts/.venv && scripts/.venv/bin/pip install youtube-transcript-api`
                : `spawn failed: ${e.message}`;
            resolve({ ok: false, reason: 'python-spawn', message: msg });
        });
        proc.stdout.on('data', d => out += d);
        proc.stderr.on('data', d => err += d);
        proc.on('close', code => {
            if (spawnErr) return;
            if (code !== 0) return resolve({ ok: false, reason: 'python-exit', exit: code, stderr: err.slice(0, 500) });
            try { resolve(JSON.parse(out)); }
            catch (e) { resolve({ ok: false, reason: 'python-parse', message: e.message, stdout: out.slice(0, 200) }); }
        });
    });
}

// ── Transcript fetch throttle ────────────────────────────────────────────────
// Opening many videos at once fires many transcript fetches; YouTube then
// rate-blocks the IP (IpBlocked / RequestBlocked). Serialize fetches one at a
// time, wait a randomized 2–5s gap between them (varied so the cadence isn't
// robotic), dedupe concurrent requests for the same video, and back off for a
// cooldown once a block is detected so we stop hammering YouTube.
const TRANSCRIPT_MIN_GAP_MS = Number(process.env.YTT_MIN_GAP_MS) || 2000;
const TRANSCRIPT_MAX_GAP_MS = Number(process.env.YTT_MAX_GAP_MS) || 5000;
const TRANSCRIPT_COOLDOWN_MS = Number(process.env.YTT_COOLDOWN_MS) || 5 * 60 * 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Random delay in [min, max], clamped so a min>max env combo can't go negative.
function nextGapMs() {
    const span = Math.max(0, TRANSCRIPT_MAX_GAP_MS - TRANSCRIPT_MIN_GAP_MS);
    return TRANSCRIPT_MIN_GAP_MS + Math.floor(Math.random() * (span + 1));
}

let ytQueue = Promise.resolve();   // serial chain: one Python process at a time
let lastYttAt = 0;                  // timestamp of the last fetch (for min-gap)
let blockedUntil = 0;              // epoch ms: skip fetching until this passes
const ytInFlight = new Map();      // videoId → Promise (dedupe concurrent reqs)

function isBlockResult(r) {
    if (!r || r.ok) return false;
    const s = `${r.reason || ''} ${r.message || ''}`.toLowerCase();
    return s.includes('ipblocked') || s.includes('requestblocked')
        || s.includes('blocking requests') || s.includes('too many requests');
}

// Run task on the serial queue (next item waits for the current one).
function enqueue(task) {
    const run = ytQueue.then(task, task);
    ytQueue = run.then(() => {}, () => {});
    return run;
}

function fetchTranscriptThrottled(videoId) {
    const existing = ytInFlight.get(videoId);
    if (existing) return existing;   // same video already queued/running

    const p = enqueue(async () => {
        // In cooldown → don't even spawn Python; tell the caller to slow down.
        if (Date.now() < blockedUntil) {
            const waitS = Math.ceil((blockedUntil - Date.now()) / 1000);
            return {
                ok: false,
                reason: 'RateLimitCooldown',
                message: `YouTube rate-limited this IP from too many requests. Cooling down ~${waitS}s — open videos more slowly.`,
                cooldownMs: blockedUntil - Date.now(),
            };
        }
        // Wait a randomized gap since the last fetch (skip if enough time passed).
        const gap = nextGapMs();
        const since = Date.now() - lastYttAt;
        if (since < gap) await sleep(gap - since);

        const result = await runYtt(videoId);
        lastYttAt = Date.now();

        if (isBlockResult(result)) {
            blockedUntil = Date.now() + TRANSCRIPT_COOLDOWN_MS;
            console.warn(`[${new Date().toISOString()}] YouTube IP block detected — pausing transcript fetches for ${TRANSCRIPT_COOLDOWN_MS / 1000}s`);
        }
        return result;
    }).finally(() => ytInFlight.delete(videoId));

    ytInFlight.set(videoId, p);
    return p;
}

function runClaude(prompt, model) {
    return new Promise((resolve) => {
        const args = ['-p', '--model', model || DEFAULT_MODEL];
        const proc = spawn(CLAUDE_BIN, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, CLAUDE_CONFIG_DIR },
        });
        let out = '', err = '';
        let spawnErr = null;
        proc.on('error', e => {
            spawnErr = e;
            if (e.code === 'ENOENT') {
                err = `claude binary not found at "${CLAUDE_BIN}". Install it or set CLAUDE_BIN env var.`;
            } else {
                err = `spawn failed: ${e.message}`;
            }
            resolve({ code: 127, out: '', err });
        });
        proc.stdout.on('data', d => out += d);
        proc.stderr.on('data', d => err += d);
        proc.on('close', code => {
            if (spawnErr) return; // already resolved in 'error' handler
            resolve({ code, out, err });
        });
        try {
            proc.stdin.write(prompt);
            proc.stdin.end();
        } catch {
            // 'error' handler will resolve
        }
    });
}

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    if (!isOriginAllowed(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: `origin not allowed: ${origin}` }));
    }
    const headers = corsHeaders(origin);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        return res.end();
    }
    // Lightweight health probe for popup status row.
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
        return res.end(JSON.stringify({
            ok: true,
            port: PORT,
            defaultModel: DEFAULT_MODEL,
            pythonPath: YTT_PYTHON,
            proxy: PROXY_MODE,
        }));
    }
    if (req.method === 'POST' && req.url === '/transcript') {
        try {
            const body = await readBody(req);
            const { videoId } = JSON.parse(body || '{}');
            if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
                res.writeHead(400, { 'Content-Type': 'application/json', ...headers });
                return res.end(JSON.stringify({ ok: false, error: 'invalid videoId' }));
            }
            const t0 = Date.now();
            const result = await fetchTranscriptThrottled(videoId);
            const ms = Date.now() - t0;
            console.log(`[${new Date().toISOString()}] /transcript ${videoId} → ${result.ok ? result.segments.length + ' segs' : result.reason} in ${ms}ms`);
            res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
            return res.end(JSON.stringify({ ...result, elapsedMs: ms }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...headers });
            return res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    }

    if (req.method !== 'POST' || req.url !== '/run') {
        res.writeHead(404, headers);
        return res.end('not found');
    }

    try {
        const body = await readBody(req);
        const { prompt, model } = JSON.parse(body || '{}');
        if (typeof prompt !== 'string' || prompt.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...headers });
            return res.end(JSON.stringify({ ok: false, error: 'missing prompt' }));
        }
        if (prompt.length > MAX_INPUT_CHARS) {
            res.writeHead(413, { 'Content-Type': 'application/json', ...headers });
            return res.end(JSON.stringify({ ok: false, error: 'prompt too long' }));
        }

        const t0 = Date.now();
        const { code, out, err } = await runClaude(prompt, model);
        const ms = Date.now() - t0;
        console.log(`[${new Date().toISOString()}] ${prompt.length}ch → ${out.length}ch in ${ms}ms (exit ${code})`);

        res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify({
            ok: code === 0,
            output: out.trim(),
            error: code !== 0 ? err.trim() : null,
            elapsedMs: ms,
        }));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify({ ok: false, error: e.message }));
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`claude-bridge ready on http://localhost:${PORT}`);
    console.log(`POST /run         body: { "prompt": "...", "model": "haiku|sonnet|opus" }`);
    console.log(`POST /transcript  body: { "videoId": "..." }  python: ${YTT_PYTHON}`);
    console.log(`transcript proxy: ${PROXY_MODE}  ·  throttle: serial, ${TRANSCRIPT_MIN_GAP_MS}-${TRANSCRIPT_MAX_GAP_MS}ms gap, ${TRANSCRIPT_COOLDOWN_MS / 1000}s cooldown on block`);
    if (PROXY_MODE === 'none') {
        console.log('  (no proxy — set WEBSHARE_PROXY_USERNAME/PASSWORD to avoid IP bans when bursting)');
    }
});
