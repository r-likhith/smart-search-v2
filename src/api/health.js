// src/api/health.js
//
// Three-tier health endpoints ✅
//
// /api/health/live  — is the process alive?
//   → Docker uses this for container health ✅
//   → always 200 if process is running ✅
//   → no external checks (never fails due to Meili) ✅
//
// /api/health/ready — can it serve requests right now?
//   → CI/CD uses this after deploy to verify success ✅
//   → checks Meilisearch is reachable ✅
//   → 503 if Meili is down ✅
//
// /api/health/deep  — full subsystem breakdown
//   → you use this for monitoring ✅
//   → shows every subsystem state + latency ✅
//   → always 200 (detail in payload, not HTTP status) ✅
//
// / (existing) — kept for backward compat ✅
//
// Status values:
//   healthy    — all systems nominal ✅
//   degraded   — correction layers missing, search works ✅
//   unavailable — Meilisearch unreachable, search fails ✅

const express  = require('express');
const router   = express.Router();
const client   = require('../meilisearch/client');
const { getStatus: getPhoneticStatus } = require('../spellcheck/phonetic');
const { getStatus: getSymSpellStatus } = require('../spellcheck/symspell');
const { getStats }                     = require('../learned/learnedMap');
const { getStats: getSuggestStats }    = require('../learned/suggestMap');
const { getClickStats }                = require('../behaviour/tracker');
const { successResponse }              = require('../utils/response');

// ─── MEILI PING WITH TIMEOUT ──────────────────────────────
// uses same deadline pattern as withRetry.js ✅
// prevents /deep hanging if Meili is unresponsive ✅
// timeout: 500ms (generous for a health check) ✅

async function pingMeili(timeoutMs = 500) {
  const start = Date.now();
  try {
    await Promise.race([
      client.health(),
      new Promise((_, reject) =>
        setTimeout(() => {
          const err = new Error(`Meili health check timed out after ${timeoutMs}ms`);
          err.code = 'ETIMEOUT';
          reject(err);
        }, timeoutMs)
      )
    ]);
    return {
      healthy:   true,
      latencyMs: Date.now() - start,
      timedOut:  false,
      error:     null
    };
  } catch (err) {
    return {
      healthy:   false,
      latencyMs: Date.now() - start,
      timedOut:  err.code === 'ETIMEOUT',
      error:     err.message
    };
  }
}

// ─── GET /api/health/live ─────────────────────────────────
// "is the process alive?"
// Docker HEALTHCHECK uses this ✅
// Never checks external deps — if process can respond,
// it's alive. Meili being down does NOT make this fail ✅

router.get('/live', (req, res) => {
  return res.status(200).json({
    status:    'live',
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime())
  });
});

// ─── GET /api/health/ready ────────────────────────────────
// "can it serve search requests right now?"
// CI/CD pipeline calls this after deploy ✅
// Returns 200 only if Meilisearch is reachable ✅
// Returns 503 if Meili is down — deploy should fail ✅

router.get('/ready', async (req, res) => {
  const meili = await pingMeili();

  if (!meili.healthy) {
    return res.status(503).json({
      status:    'not_ready',
      timestamp: new Date().toISOString(),
      reason:    meili.timedOut ? 'meilisearch_timeout' : 'meilisearch_unreachable',
      meili:     meili,
      uptime:    Math.floor(process.uptime())
    });
  }

  return res.status(200).json({
    status:    'ready',
    timestamp: new Date().toISOString(),
    meili:     meili,
    uptime:    Math.floor(process.uptime())
  });
});

// ─── GET /api/health/deep ─────────────────────────────────
// "what is the state of every subsystem?"
// You use this for monitoring and debugging ✅
// Always returns 200 — detail is in payload ✅
// Internal hostnames NOT exposed (security) ✅

router.get('/deep', async (req, res) => {
  const start = Date.now();

  // ── Meilisearch (core dependency) ─────────────────────
  const meili = await pingMeili();

  // ── correction pipeline (all in-memory) ───────────────
  const phonetic = getPhoneticStatus();
  const symspell = getSymSpellStatus();

  let learnedMapStats = null;
  let suggestStats    = null;
  let clickStats      = null;

  try { learnedMapStats = getStats(); }        catch (e) {}
  try { suggestStats    = getSuggestStats(); } catch (e) {}
  try { clickStats      = getClickStats(); }   catch (e) {}

  // ── memory ────────────────────────────────────────────
  const mem           = process.memoryUsage();
  const heapUsedMB    = Math.round(mem.heapUsed  / 1024 / 1024);
  const heapTotalMB   = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB         = Math.round(mem.rss       / 1024 / 1024);
  const memoryPercent = heapTotalMB > 0
    ? parseFloat((heapUsedMB / heapTotalMB * 100).toFixed(1))
    : 0;

  // ── overall status ────────────────────────────────────
  // unavailable: Meili down → customers cannot search ✅
  // degraded:    correction layers missing → search works,
  //              typo correction reduced ✅
  // healthy:     everything nominal ✅
  let status = 'healthy';
  if (!meili.healthy) {
    status = 'unavailable';
  } else if (!phonetic.ready || !symspell.ready || !learnedMapStats) {
    status = 'degraded';
  }

  return successResponse(res, {
    status,
    timestamp:   new Date().toISOString(),
    uptime:      Math.floor(process.uptime()),
    checkedInMs: Date.now() - start,

    // ── core dependency ───────────────────────────────
    // internal host NOT exposed for security ✅
    meilisearch: {
      healthy:   meili.healthy,
      latencyMs: meili.latencyMs,
      timedOut:  meili.timedOut,
      error:     meili.error
    },

    // ── correction pipeline ───────────────────────────
    learnedMap: {
      healthy:  !!learnedMapStats,
      entries:  learnedMapStats?.totalEntries    || 0,
      manual:   learnedMapStats?.manualEntries   || 0,
      groq:     learnedMapStats?.groqEntries     || 0,
      click:    learnedMapStats?.clickEntries    || 0,
      disabled: learnedMapStats?.disabledEntries || 0,
      trusted:  learnedMapStats?.trustedEntries  || 0,
      proven:   learnedMapStats?.provenEntries   || 0
    },

    symspell: {
      healthy:         symspell.ready,
      maxEditDistance: symspell.maxEditDistance,
      minWordLength:   symspell.minWordLength
    },

    phonetic: {
      healthy:   phonetic.ready,
      indexed:   phonetic.indexed,
      indexSize: phonetic.indexSize
    },

    // ── suggest ───────────────────────────────────────
    suggest: {
      healthy:     !!suggestStats,
      completions: suggestStats?.totalCompletions || 0
    },

    // ── learning pipeline ─────────────────────────────
    clicks: {
      healthy:   !!clickStats,
      total:     clickStats?.totalRawClicks       || 0,
      learnable: clickStats?.learnableCorrections || 0
    },

    // ── process ───────────────────────────────────────
    process: {
      uptimeSec:   Math.floor(process.uptime()),
      nodeVersion: process.version,
      memory: {
        heapUsedMB,
        heapTotalMB,
        rssMB,
        memoryPercent   // ← heapUsed/heapTotal as % ✅
      }
    }
  });
});

// ─── GET /api/health (existing — backward compat) ─────────
// kept so anything already calling /api/health still works ✅

router.get('/', async (req, res, next) => {
  const start = Date.now();
  try {
    let meiliHealth = 'disconnected';
    try {
      await client.health();
      meiliHealth = 'connected';
    } catch {}

    const allHealthy = meiliHealth === 'connected';

    return successResponse(res, {
      status:         allHealthy ? 'healthy' : 'degraded',
      services:       { meilisearch: meiliHealth },
      processingTime: Date.now() - start,
      uptime:         Math.floor(process.uptime())
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;