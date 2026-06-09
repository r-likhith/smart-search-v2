const { normalise } = require('../query/normalise');

// ─── CONFIG ───────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000;        // 1 hour TTL
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // sweep every 10 min

// ─── STORAGE ──────────────────────────────────────────────
// Object.create(null) — no prototype
// safer when user queries become keys
const cache = Object.create(null);

// ─── CLEANUP SWEEPER ──────────────────────────────────────

function cleanExpired() {
  const now = Date.now();
  let removed = 0;

  for (const key of Object.keys(cache)) {
    if (now > cache[key].expires) {
      delete cache[key];
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[OllamaCache] Swept ${removed} expired entries`);
  }
}

// unref() — don't keep Node alive just for this timer
const cleanupTimer = setInterval(cleanExpired, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

// ─── GET ──────────────────────────────────────────────────

function get(query) {
  const key = normalise(query);
  const entry = cache[key];

  if (!entry) return null;

  if (Date.now() > entry.expires) {
    delete cache[key];
    return null;
  }

  console.log(`[OllamaCache] Hit: "${query}" → "${entry.correction}"`);
  return entry.correction;
}

// ─── SET ──────────────────────────────────────────────────

function set(query, correction) {
  if (!query || !correction) return;

  const key = normalise(query);

  cache[key] = {
    correction,
    expires: Date.now() + CACHE_TTL_MS,
    cachedAt: new Date().toISOString()
  };

  console.log(`[OllamaCache] Saved: "${query}" → "${correction}"`);
}

// ─── STATS ────────────────────────────────────────────────

function getStats() {
  const keys = Object.keys(cache);
  const now = Date.now();
  const valid = keys.filter(k => now < cache[k].expires);

  return {
    totalCached: keys.length,
    validEntries: valid.length,
    expiredEntries: keys.length - valid.length
  };
}

module.exports = { get, set, getStats, cleanExpired };