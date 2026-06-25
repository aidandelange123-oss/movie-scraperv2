'use strict';

// Persistent shared cache backed by Upstash Redis.
// This acts as our "custom CDN": every resolved link and every fetched
// link body (playlists + segments) is stored here so it is served from
// our own servers instead of hitting the upstream origin every time.

const { Redis } = require('@upstash/redis');

let redis = null;
function client() {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null; // cache disabled if not configured
  redis = new Redis({ url, token });
  return redis;
}

// ── Resolved playlist links (TMDB id/season/episode -> playlist url) ──────────
const LINK_TTL = 30 * 60;          // 30 minutes
const LINK_PREFIX = 'link:';

async function getLink(key) {
  const r = client();
  if (!r) return null;
  try { return await r.get(LINK_PREFIX + key); } catch { return null; }
}

async function setLink(key, url) {
  const r = client();
  if (!r) return;
  try { await r.set(LINK_PREFIX + key, url, { ex: LINK_TTL }); } catch {}
}

async function delLink(key) {
  const r = client();
  if (!r) return;
  try { await r.del(LINK_PREFIX + key); } catch {}
}

// ── Cached link bodies (the CDN layer: url -> { ct, body(base64) }) ───────────
const BODY_TTL = 6 * 60 * 60;      // 6 hours
const BODY_PREFIX = 'cdn:';
const MAX_BODY = 8 * 1024 * 1024;  // 8 MB cap per cached object

function bodyKey(url) {
  // Hash-free stable key; encode to keep it a single token.
  return BODY_PREFIX + Buffer.from(url).toString('base64url');
}

async function getBody(url) {
  const r = client();
  if (!r) return null;
  try {
    const v = await r.get(bodyKey(url));
    if (!v) return null;
    return { ct: v.ct, body: Buffer.from(v.body, 'base64') };
  } catch { return null; }
}

async function setBody(url, ct, body) {
  const r = client();
  if (!r) return;
  if (!body || body.length > MAX_BODY) return; // skip oversized objects
  try {
    await r.set(bodyKey(url), { ct, body: body.toString('base64') }, { ex: BODY_TTL });
  } catch {}
}

async function delBody(url) {
  const r = client();
  if (!r) return;
  try { await r.del(bodyKey(url)); } catch {}
}

module.exports = {
  enabled: () => !!client(),
  getLink, setLink, delLink,
  getBody, setBody, delBody,
};
