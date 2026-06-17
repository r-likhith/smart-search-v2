const fs   = require('fs');
const path = require('path');

const ANALYTICS_LOG    = path.join(__dirname, '../logs/analytics.log');
const MULTI_TENANT_DIR = path.join(__dirname, '../multiTenantLogs');

// ─── READ ENTRIES (global) ────────────────────────────────

function readEntries() {
  try {
    if (!fs.existsSync(ANALYTICS_LOG)) return [];
    const lines = fs.readFileSync(ANALYTICS_LOG, 'utf8')
      .split('\n')
      .filter(l => l.trim());
    return lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// ─── READ CLIENT ENTRIES (per-client) ─────────────────────
// reads analytics for a specific client ✅
// isolated per-client log ✅
// used for per-client analytics ✅

function readClientEntries(clientId) {
  try {
    const clientLog = path.join(
      MULTI_TENANT_DIR,
      `client_${clientId}`,
      'analytics.log'
    );
    if (!fs.existsSync(clientLog)) return [];
    const lines = fs.readFileSync(clientLog, 'utf8')
      .split('\n')
      .filter(l => l.trim());
    return lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// ─── PERCENTILE ───────────────────────────────────────────

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── AGGREGATE ────────────────────────────────────────────

function aggregate(clientId = null) {
  // if clientId provided → use client log ✅
  // otherwise → use global log ✅
  const entries = clientId
    ? readClientEntries(clientId)
    : readEntries();

  if (entries.length === 0) return null;

  const total = entries.length;

  const correctionAttempted = entries.filter(e => e.correctionAttempted).length;
  const correctionApplied   = entries.filter(e => e.correction?.applied).length;
  const zeroResults         = entries.filter(e => e.results?.isZeroResult).length;
  const weakResults         = entries.filter(e => e.results?.isWeakResult).length;
  const fallbacks           = entries.filter(e => e.results?.isFallback).length;

  // ── stages ────────────────────────────────────────────
  const stages = {};
  for (const e of entries) {
    const s = e.searchStage || 'meilisearch';
    stages[s] = (stages[s] || 0) + 1;
  }

  // ── correction depth ──────────────────────────────────
  const depths = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const e of entries) {
    const d = e.correctionDepth || 0;
    depths[d] = (depths[d] || 0) + 1;
  }

  // ── correction sources ────────────────────────────────
  const sources = {};
  for (const e of entries) {
    const s = e.correction?.source || 'none';
    sources[s] = (sources[s] || 0) + 1;
  }

  // ── correction mode breakdown ─────────────────────────
  const correctionModes = { none: 0, assisted: 0, full: 0 };
  for (const e of entries) {
    const mode = e.correctionMode || 'none';
    correctionModes[mode] = (correctionModes[mode] || 0) + 1;
  }

  // ── query types ───────────────────────────────────────
  const queryTypes = {};
  for (const e of entries) {
    const t = e.queryType || 'unknown';
    queryTypes[t] = (queryTypes[t] || 0) + 1;
  }

  // ── latency buckets ───────────────────────────────────
  const latency = {};
  for (const e of entries) {
    const l = e.timing?.latencyBucket || 'unknown';
    latency[l] = (latency[l] || 0) + 1;
  }

  // ── per-client breakdown (global only) ────────────────
  const byClient = {};
  if (!clientId) {
    for (const e of entries) {
      const cid = e.clientId || 'unknown';
      if (!byClient[cid]) {
        byClient[cid] = {
          searches:    0,
          corrections: 0,
          zeroResults: 0,
          fallbacks:   0
        };
      }
      byClient[cid].searches++;
      if (e.correction?.applied)   byClient[cid].corrections++;
      if (e.results?.isZeroResult) byClient[cid].zeroResults++;
      if (e.results?.isFallback)   byClient[cid].fallbacks++;
    }
  }

  // ── timing ────────────────────────────────────────────
  const allTimes      = entries.map(e => e.timing?.total    || 0);
  const symspellTimes = entries.filter(e => e.symspell?.called).map(e => e.timing?.symspell || 0);
  const phoneticTimes = entries.filter(e => e.phonetic?.called).map(e => e.timing?.phonetic || 0);
  const ollamaTimes   = entries.filter(e => e.ollama?.called).map(e => e.timing?.ollama     || 0);

  const avgTotal    = Math.round(allTimes.reduce((a,b) => a+b, 0)      / (allTimes.length      || 1));
  const avgSymspell = Math.round(symspellTimes.reduce((a,b) => a+b, 0) / (symspellTimes.length || 1));
  const avgPhonetic = Math.round(phoneticTimes.reduce((a,b) => a+b, 0) / (phoneticTimes.length || 1));
  const avgOllama   = Math.round(ollamaTimes.reduce((a,b) => a+b, 0)   / (ollamaTimes.length   || 1));

  const p50 = percentile(allTimes, 50);
  const p95 = percentile(allTimes, 95);
  const p99 = percentile(allTimes, 99);

  // ── top queries ───────────────────────────────────────
  const queryCounts = {};
  for (const e of entries) {
    const q = e.query?.toLowerCase();
    if (q) queryCounts[q] = (queryCounts[q] || 0) + 1;
  }
  const topQueries = Object.entries(queryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([query, count]) => ({ query, count }));

  // ── top corrections ───────────────────────────────────
  // returns {query, correction, count} objects ✅
  const correctionCounts = {};
  for (const e of entries) {
    if (e.correction?.applied && e.correction?.finalQuery) {
      const key = `${e.query}||${e.correction.finalQuery}`;
      correctionCounts[key] = (correctionCounts[key] || 0) + 1;
    }
  }
  const topCorrections = Object.entries(correctionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, count]) => {
      const [query, correction] = key.split('||');
      return { query, correction, count };
    });

  // ── zero result queries with frequency ────────────────
  const zeroResultCounts = {};
  for (const e of entries) {
    if (e.results?.isZeroResult && !e.results?.isFallback && e.query) {
      const q = e.query.toLowerCase();
      zeroResultCounts[q] = (zeroResultCounts[q] || 0) + 1;
    }
  }
  const uniqueZeroResults = Object.entries(zeroResultCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([query, count]) => ({ query, count }));

  // ── weak result queries ───────────────────────────────
  const weakResultCounts = {};
  for (const e of entries) {
    if (e.results?.isWeakResult && e.query) {
      const q = e.query.toLowerCase();
      weakResultCounts[q] = (weakResultCounts[q] || 0) + 1;
    }
  }
  const uniqueWeakResults = Object.entries(weakResultCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([query, count]) => ({ query, count }));

  // ── slow queries ──────────────────────────────────────
  const slowQueries = entries
    .filter(e => (e.timing?.total || 0) > 1000)
    .sort((a, b) => (b.timing?.total || 0) - (a.timing?.total || 0))
    .slice(0, 10)
    .map(e => ({ query: e.query, time: e.timing?.total, stage: e.searchStage }));

  // ── layer stats ───────────────────────────────────────
  const symspellCalls    = entries.filter(e => e.symspell?.called);
  const symspellAccepted = symspellCalls.filter(e => e.symspell?.outcome === 'accepted');
  const symspellRejected = symspellCalls.filter(e => e.symspell?.outcome?.startsWith('rejected'));
  const phoneticCalls    = entries.filter(e => e.phonetic?.called);
  const phoneticAccepted = phoneticCalls.filter(e => e.phonetic?.outcome === 'accepted');
  const ollamaCalls      = entries.filter(e => e.ollama?.called);
  const ollamaAccepted   = ollamaCalls.filter(e => e.ollama?.outcome === 'accepted');
  const learnedMapHits      = entries.filter(e => e.learnedMap?.hit);
  const learnedMapAccepted  = learnedMapHits.filter(e => e.learnedMap?.outcome === 'accepted');
  const learnedMapPenalised = learnedMapHits.filter(e => e.learnedMap?.outcome === 'penalised');

  return {
    // scope of this analytics ✅
    scope: clientId ? `client_${clientId}` : 'global',
    summary: {
      totalSearches:    total,
      correctionAttempted,
      correctionApplied,
      correctionRate:   total > 0 ? Math.round((correctionApplied / total) * 100) : 0,
      zeroResults,
      zeroResultRate:   total > 0 ? Math.round((zeroResults / total) * 100) : 0,
      weakResults,
      weakResultRate:   total > 0 ? Math.round((weakResults / total) * 100) : 0,
      fallbacks,
      period: entries.length > 0 ? {
        from: entries[0].ts,
        to:   entries[entries.length - 1].ts
      } : null
    },
    stages,
    depths,
    sources,
    correctionModes,
    queryTypes,
    latency,
    byClient,
    timing: {
      avgTotal,
      avgSymspell,
      avgPhonetic,
      avgOllama,
      p50,
      p95,
      p99
    },
    layerFunnel: {
      totalSearches:    total,
      learnedMapHits:   learnedMapHits.length,
      symspellCalled:   symspellCalls.length,
      phoneticCalled:   phoneticCalls.length,
      meilisearchFuzzy: entries.filter(e =>
        e.searchStage === 'meilisearch' &&
        !e.learnedMap?.hit &&
        !e.symspell?.called &&
        !e.phonetic?.called
      ).length
    },
    layers: {
      learnedMap: {
        hits:      learnedMapHits.length,
        accepted:  learnedMapAccepted.length,
        penalised: learnedMapPenalised.length,
        hitRate:   total > 0 ? Math.round((learnedMapHits.length / total) * 100) : 0
      },
      symspell: {
        calls:      symspellCalls.length,
        accepted:   symspellAccepted.length,
        rejected:   symspellRejected.length,
        acceptRate: symspellCalls.length > 0
          ? Math.round((symspellAccepted.length / symspellCalls.length) * 100) : 0
      },
      phonetic: {
        calls:      phoneticCalls.length,
        accepted:   phoneticAccepted.length,
        acceptRate: phoneticCalls.length > 0
          ? Math.round((phoneticAccepted.length / phoneticCalls.length) * 100) : 0
      },
      ollama: {
        calls:      ollamaCalls.length,
        accepted:   ollamaAccepted.length,
        acceptRate: ollamaCalls.length > 0
          ? Math.round((ollamaAccepted.length / ollamaCalls.length) * 100) : 0
      }
    },
    topQueries,
    topCorrections,
    zeroResultQueries: uniqueZeroResults,
    weakResultQueries: uniqueWeakResults,
    slowQueries
  };
}

// ─── QUERY REPLAY ─────────────────────────────────────────
// ts parameter: if provided → return only that specific event ✅
// ts parameter: if null → return last 10 events for query ✅

function replayQuery(query, ts = null, latest = false) {
  const entries = readEntries();
  if (!query) return [];

  const lower = query.toLowerCase().trim();

  let matches = entries
    .filter(e => e.query?.toLowerCase() === lower)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts));

  // if ts provided → find exact event ✅
  if (ts) {
    const exact = matches.find(e => e.ts === ts);
    if (exact) matches = [exact];
    else matches = matches.slice(0, 1); // fallback to most recent ✅
  } else if (latest) {
    matches = matches.slice(0, 1); // most recent only ✅
  } else {
    matches = matches.slice(0, 10);
  }


  return matches.map(e => ({
    ts:         e.ts,
    requestId:  e.requestId,
    query:      e.query,
    normalised: e.normalised,
    queryType:  e.queryType,

    pipeline: [
      {
        step:   1,
        name:   'Normalise',
        status: e.normaliseResult === 'changed' ? 'changed' : 'pass',
        detail: e.normaliseResult === 'changed'
          ? `"${e.query}" → "${e.normalised}"`
          : 'no change needed',
        time: 0
      },
      {
        step:   2,
        name:   'LearnedMap',
        status: e.learnedMap?.hit ? e.learnedMap.outcome : 'miss',
        detail: e.learnedMap?.hit
          ? `hit → "${e.learnedMap.correction}" (${e.learnedMap.source}, conf:${e.learnedMap.confidence})`
          : 'not in learnedMap',
        resultsBefore: e.learnedMap?.resultsBefore || 0,
        resultsAfter:  e.learnedMap?.resultsAfter  || 0,
        time:          e.timing?.learnedmap        || 0
      },
      {
        step:   3,
        name:   'SymSpell',
        status: e.symspell?.called ? e.symspell.outcome : 'skipped',
        detail: e.symspell?.called
          ? e.symspell.candidate
            ? `candidate: "${e.symspell.candidate}" → ${e.symspell.outcome}${e.symspell.rejectionReason ? ` (${e.symspell.rejectionReason})` : ''}`
            : 'no candidate found'
          : 'not called',
        changedWords:  e.symspell?.changedWords  || [],
        resultsBefore: e.symspell?.resultsBefore || 0,
        resultsAfter:  e.symspell?.resultsAfter  || 0,
        time:          e.symspell?.timeTaken     || 0
      },
      {
        step:   4,
        name:   'Phonetic',
        status: e.phonetic?.called ? e.phonetic.outcome : 'skipped',
        detail: e.phonetic?.called
          ? e.phonetic.candidate
            ? `candidate: "${e.phonetic.candidate}" → ${e.phonetic.outcome}`
            : 'no candidate found'
          : 'not called',
        resultsBefore: e.phonetic?.resultsBefore || 0,
        resultsAfter:  e.phonetic?.resultsAfter  || 0,
        time:          e.phonetic?.timeTaken     || 0
      },
      {
        step:   5,
        name:   'Ollama',
        status: e.ollama?.called ? e.ollama.outcome : 'skipped',
        detail: e.ollama?.called
          ? e.ollama.candidate
            ? `candidate: "${e.ollama.candidate}" → ${e.ollama.outcome}${e.ollama.rejectionReason ? ` (${e.ollama.rejectionReason})` : ''}`
            : 'no candidate'
          : 'not called (offline learner only)',
        resultsBefore: e.ollama?.resultsBefore || 0,
        resultsAfter:  e.ollama?.resultsAfter  || 0,
        time:          e.ollama?.timeTaken     || 0
      }
    ],

    outcome: {
      searchStage:       e.searchStage,
      correctionDepth:   e.correctionDepth,
      correctionMode:    e.correctionMode       || 'none',
      correctionApplied: e.correction?.applied  || false,
      finalQuery:        e.correction?.finalQuery || e.normalised,
      source:            e.correction?.source    || 'none',
      confidence:        e.correction?.confidence || null,
      improvement:       e.correction?.improvement || 0,
      resultsCount:      e.results?.count        || 0,
      isFallback:        e.results?.isFallback   || false
    },

    timing: {
      total:         e.timing?.total         || 0,
      learnedmap:    e.timing?.learnedmap    || 0,
      symspell:      e.timing?.symspell      || 0,
      phonetic:      e.timing?.phonetic      || 0,
      ollama:        e.timing?.ollama        || 0,
      meilisearch:   e.timing?.meilisearch   || 0,
      latencyBucket: e.timing?.latencyBucket || 'unknown'
    }
  }));
}

module.exports = { aggregate, readEntries, readClientEntries, replayQuery };