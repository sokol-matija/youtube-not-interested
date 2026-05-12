#!/usr/bin/env node
// Local bridge: extension POSTs prompt → spawns `claude -p` → returns stdout.
// Run: node scripts/claude-bridge.mjs
// Ctrl-C to stop. Listens on http://localhost:7777

import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = 7777;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'haiku';
// Path to a Python interpreter with `youtube-transcript-api` installed.
// Default points to project-local venv at scripts/.venv.
// Setup: python3 -m venv scripts/.venv && scripts/.venv/bin/pip install youtube-transcript-api
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENV_PY = process.platform === 'win32'
    ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '.venv', 'bin', 'python');
const YTT_PYTHON = process.env.YTT_PYTHON || VENV_PY;
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
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
import sys, json
from youtube_transcript_api import YouTubeTranscriptApi
try:
    api = YouTubeTranscriptApi()
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

function runClaude(prompt, model) {
    return new Promise((resolve) => {
        const args = ['-p', '--model', model || DEFAULT_MODEL];
        const proc = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (req.method === 'POST' && req.url === '/transcript') {
        try {
            const body = await readBody(req);
            const { videoId } = JSON.parse(body || '{}');
            if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
                res.writeHead(400, { 'Content-Type': 'application/json', ...headers });
                return res.end(JSON.stringify({ ok: false, error: 'invalid videoId' }));
            }
            const t0 = Date.now();
            const result = await runYtt(videoId);
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
});
