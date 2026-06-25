'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// ── WASM singleton (survives warm invocations) ────────────────────────────────
let wasmReady = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
    wasmReady = true;
  })();
  return bootPromise;
}

// ── Link cache (survives warm invocations) ────────────────────────────────────
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const linkCache = new Map();      // key -> { url, ts }

function cacheKey(id, season, episode) {
  return season ? `tv:${id}:${season}:${episode || 1}` : `movie:${id}`;
}

function parseKey(key) {
  const parts = String(key).split(':');
  return parts[0] === 'tv'
    ? { id: parts[1], season: parts[2], episode: parts[3] }
    : { id: parts[1] };
}

// ── Raw stream resolver (always hits vidlink) ─────────────────────────────────
async function resolveStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();
  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error('No playlist in response');
  return playlist;
}

// ── Cached stream resolver ────────────────────────────────────────────────────
// force: bypass cache and re-resolve (used to repair broken links)
async function getStream(id, season, episode, { force = false } = {}) {
  const key = cacheKey(id, season, episode);
  const cached = linkCache.get(key);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL) {
    return { url: cached.url, key, cached: true };
  }
  const url = await resolveStream(id, season, episode);
  linkCache.set(key, { url, ts: Date.now() });
  return { url, key, cached: false };
}

// Re-resolve a fresh playlist URL for a cached stream key (auto-repair).
async function repairByKey(key) {
  const { id, season, episode } = parseKey(key);
  const { url } = await getStream(id, season, episode, { force: true });
  return url;
}

// ── HLS upstream fetcher with redirect support ────────────────────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function rewriteM3u8(body, url, key) {
  const base = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;
  const keyParam = key ? '&k=' + encodeURIComponent(key) : '';
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseDir + t;
    return '/api?url=' + encodeURIComponent(abs) + keyParam;
  }).join('\n');
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // Proxy mode: /api?url=...   (optional &k=<streamKey> enables auto-repair)
  if (q.url) {
    let url = decodeURIComponent(q.url);
    const key = q.k ? decodeURIComponent(q.k) : null;

    // Treat the top-level playlist as the "link" worth repairing.
    const isPlaylistUrl = /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

    try {
      let upstream = await fetchUpstream(url);

      // Broken link → re-resolve a fresh playlist and retry once.
      if (upstream.statusCode >= 400 && key && isPlaylistUrl) {
        try {
          url = await repairByKey(key);
          upstream = await fetchUpstream(url);
        } catch (_) { /* fall through with original response */ }
      }

      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url, key));
      } else {
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        res.statusCode = upstream.statusCode;
        upstream.pipe(res);
      }
    } catch (err) {
      // Connection-level failure → attempt repair before giving up.
      if (key && isPlaylistUrl) {
        try {
          url = await repairByKey(key);
          const upstream = await fetchUpstream(url);
          const chunks = [];
          for await (const chunk of upstream) chunks.push(chunk);
          const body = Buffer.concat(chunks).toString('utf8');
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          return res.end(rewriteM3u8(body, url, key));
        } catch (_) { /* fall through to error */ }
      }
      res.statusCode = 502;
      res.end(err.message);
    }
    return;
  }

  // Stream lookup: /api?id=550  or  /api?id=456&s=1&e=2
  if (!q.id) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing id' }));
  }

  res.setHeader('Content-Type', 'application/json');
  try {
    // force=1 lets a client explicitly refresh/repair a cached link.
    const force = q.force === '1' || q.refresh === '1';
    const { url, key, cached } = await getStream(q.id, q.s, q.e, { force });
    // Route playback through the proxy with the stream key so broken
    // links are detected and re-resolved automatically.
    const proxied = '/api?url=' + encodeURIComponent(url) + '&k=' + encodeURIComponent(key);
    res.end(JSON.stringify({ url: proxied, direct: url, key, cached }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
