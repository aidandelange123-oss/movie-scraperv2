'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const cache = require('./cache');

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

// ── Link cache: fast in-memory layer in front of the shared Redis CDN ─────────
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
  const stream = data?.stream;

  // Standard quality labels we expose in the API.
  const WANT = ['360', '480', '720', '1080'];
  const out = { '360p': null, '480p': null, '720p': null, '1080p': null };

  // New format: per-quality mp4 files keyed by height (e.g. "360", "720").
  const qualities = stream?.qualities;
  if (qualities && typeof qualities === 'object') {
    for (const q of WANT) {
      const item = qualities[q];
      if (item?.url) out[q + 'p'] = item.url;
    }
    // Map any non-standard heights (e.g. 2160/1440) to the nearest label.
    for (const k of Object.keys(qualities)) {
      const url = qualities[k]?.url;
      if (!url || WANT.includes(k)) continue;
      const n = Number(k);
      if (!isNaN(n) && n >= 1080 && !out['1080p']) out['1080p'] = url;
    }
  }

  // Fallback: expose an HLS/DASH master playlist under every empty slot so
  // clients always get a usable link even when per-quality mp4s are missing.
  const alt = stream?.alternates;
  const master = stream?.playlist || alt?.hls?.playlist || alt?.dash?.playlist || null;
  if (master) {
    for (const label of Object.keys(out)) {
      if (!out[label]) out[label] = master;
    }
  }

  if (!Object.values(out).some(Boolean)) {
    throw new Error('No playable stream in response');
  }
  return out;
}

// Coerce a cached value into a valid qualities object, or null if it is
// missing / stale / in an old incompatible format (so it gets re-resolved).
function normalizeQualities(val) {
  if (!val) return null;
  let obj = val;
  if (typeof val === 'string') {
    try { obj = JSON.parse(val); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const hasQ = ['360p', '480p', '720p', '1080p'].some(k => obj[k]);
  return hasQ ? obj : null;
}

// ── Cached stream resolver ────────────────────────────────────────────────────
// Two-tier cache: in-memory (warm instance) → Redis (shared across all
// servers/instances = our CDN) → upstream vidlink resolve.
// force: bypass both caches and re-resolve (used to repair broken links).
async function getStream(id, season, episode, { force = false } = {}) {
  const key = cacheKey(id, season, episode);

  if (!force) {
    const mem = linkCache.get(key);
    if (mem && Date.now() - mem.ts < CACHE_TTL) {
      return { qualities: mem.qualities, key, cached: 'memory' };
    }
    const shared = await cache.getLink(key);
    const qualities = normalizeQualities(shared);
    if (qualities) {
      linkCache.set(key, { qualities, ts: Date.now() });
      return { qualities, key, cached: 'redis' };
    }
  }

  const qualities = await resolveStream(id, season, episode);
  linkCache.set(key, { qualities, ts: Date.now() });
  await cache.setLink(key, JSON.stringify(qualities));
  return { qualities, key, cached: false };
}

// Re-resolve fresh quality links for a cached stream key (auto-repair).
// Also invalidates the broken entry from both cache tiers.
async function repairByKey(key) {
  linkCache.delete(key);
  await cache.delLink(key);
  const { id, season, episode } = parseKey(key);
  const { qualities } = await getStream(id, season, episode, { force: true });
  return qualities;
}

// Best available direct link from a qualities object (highest quality first).
function bestQuality(qualities) {
  const order = ['1080p', '720p', '480p', '360p'];
  for (const q of order) if (qualities?.[q]) return qualities[q];
  return null;
}

// ── Upstream fetcher with redirect + Range support ────────────────────────────
function fetchUpstream(url, range = null, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const headers = { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' };
    if (range) headers.Range = range;
    (url.startsWith('https') ? https : http).get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, range, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

// Rewrite every child link (sub-playlists + segments) to flow through our
// custom /server CDN endpoint, which caches each object in Redis.
function rewriteM3u8(body, url, key) {
  const base = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;
  const keyParam = key ? '&k=' + encodeURIComponent(key) : '';
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseDir + t;
    return '/server?url=' + encodeURIComponent(abs) + keyParam;
  }).join('\n');
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const parsed = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(parsed.searchParams);
  // /server is our custom CDN endpoint: same proxy logic, but every object
  // (playlists + segments) is stored in and served from the Redis cache.
  const isCdn = parsed.pathname.startsWith('/server');

  // Proxy / CDN mode: /api?url=...  or  /server?url=...
  // (optional &k=<streamKey> enables broken-link auto-repair)
  if (q.url) {
    // searchParams already URL-decodes values — do not decode again, or
    // percent-encoded params inside signed upstream URLs get corrupted.
    let url = q.url;
    const key = q.k || null;
    const range = req.headers.range || null;

    // The main media link (playlist or mp4 file) is the one worth repairing.
    const isPlaylistUrl = /\.(m3u8?|mpd)(\?|$)/i.test(url.split('?')[0]);
    const isMediaFileUrl = /\.(mp4|mkv|webm)(\?|$)/i.test(url.split('?')[0]);
    const repairable = key && (isPlaylistUrl || isMediaFileUrl);

    // ── CDN cache hit: serve straight from our own servers (playlists only —
    // large media files are streamed with Range support, not buffered) ───────
    if (isCdn && !range) {
      const hit = await cache.getBody(url);
      if (hit) {
        res.setHeader('Content-Type', hit.ct || 'application/octet-stream');
        res.setHeader('X-Cache', 'HIT');
        return res.end(hit.body);
      }
    }

    // Buffer + cache a response body, rewriting playlists as needed.
    const sendBuffered = async (upstream, finalUrl) => {
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') ||
        /\.m3u8?(\?|$)/i.test(finalUrl.split('?')[0]);

      const chunks = [];
      for await (const chunk of upstream) chunks.push(chunk);
      let buf = Buffer.concat(chunks);
      let outCt = ct || 'application/octet-stream';

      if (isM3u8) {
        buf = Buffer.from(rewriteM3u8(buf.toString('utf8'), finalUrl, key), 'utf8');
        outCt = 'application/vnd.apple.mpegurl';
      }

      // Store every fetched link body in the shared CDN cache.
      if (isCdn) {
        await cache.setBody(url, outCt, buf);
        res.setHeader('X-Cache', 'MISS');
      }
      res.setHeader('Content-Type', outCt);
      return res.end(buf);
    };

    // Stream a (possibly large) media response through, preserving Range
    // semantics so video seeking works.
    const sendStreamed = (upstream, ct) => {
      res.statusCode = upstream.statusCode;
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
      }
      upstream.pipe(res);
    };

    try {
      let upstream = await fetchUpstream(url, range);

      // Broken link → re-resolve fresh quality links and retry once.
      if (upstream.statusCode >= 400 && repairable) {
        try {
          const fresh = await repairByKey(key);
          url = bestQuality(fresh) || url;
          upstream = await fetchUpstream(url, range);
        } catch (_) { /* fall through with original response */ }
      }

      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

      // Playlists are buffered (rewritten + cached in the CDN); everything
      // else (mp4/segments) streams straight through with Range support.
      if (isM3u8) {
        return await sendBuffered(upstream, url);
      } else {
        sendStreamed(upstream, ct);
      }
    } catch (err) {
      // Connection-level failure → attempt repair before giving up.
      if (repairable) {
        try {
          const fresh = await repairByKey(key);
          url = bestQuality(fresh) || url;
          const upstream = await fetchUpstream(url, range);
          const ct = (upstream.headers['content-type'] || '').toLowerCase();
          const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);
          if (isM3u8) return await sendBuffered(upstream, url);
          return sendStreamed(upstream, ct);
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
    // force=1 lets a client explicitly refresh/repair cached links.
    const force = q.force === '1' || q.refresh === '1';
    const { qualities, key, cached } = await getStream(q.id, q.s, q.e, { force });

    // Pure link API: return the direct HTTP stream URL for each quality.
    res.end(JSON.stringify({
      id: q.id,
      type: q.s ? 'tv' : 'movie',
      season: q.s ? Number(q.s) : undefined,
      episode: q.s ? Number(q.e || 1) : undefined,
      cached,
      key,
      qualities,
    }, null, 2));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
