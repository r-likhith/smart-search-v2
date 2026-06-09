// offlineLearner/queryCollector.js
// reads zero-result queries from logs ✅
// aggregates across all clients ✅
// tracks firstSeen + lastSeen ✅
// filters already known ✅
// returns sorted by frequency ✅

const fs   = require('fs');
const path = require('path');
const { PATHS, THRESHOLDS, CLIENT_SCOPE } = require('./config');

// ─── READ CLIENT LOGS ─────────────────────────────────────

function readClientLogs() {
  const zeroResultCounts = {};  // query → count
  const queryClients     = {};  // query → Set of clientIds
  const queryFirstSeen   = {};  // query → earliest ts ✅
  const queryLastSeen    = {};  // query → latest ts ✅

  const clients = Object.keys(CLIENT_SCOPE);

  for (const clientId of clients) {
    const logFile = path.join(
      PATHS.multiTenantLogs,
      `client_${clientId}`,
      'analytics.log'
    );

    if (!fs.existsSync(logFile)) continue;

    try {
      const lines = fs.readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(l => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // only zero-result queries ✅
          // not fallbacks (those are different) ✅
          if (
            entry.results?.isZeroResult &&
            !entry.results?.isFallback  &&
            entry.query
          ) {
            const q = entry.query.toLowerCase().trim();
            if (!q || q.length < 2) continue;

            // aggregate count ✅
            zeroResultCounts[q] = (zeroResultCounts[q] || 0) + 1;

            // track which clients had this query ✅
            if (!queryClients[q]) queryClients[q] = new Set();
            queryClients[q].add(clientId);

            // track firstSeen + lastSeen ✅
            // 3 failures in 5 minutes ≠ 3 failures in 6 months ✅
            if (entry.ts) {
              if (!queryFirstSeen[q] || entry.ts < queryFirstSeen[q]) {
                queryFirstSeen[q] = entry.ts;
              }
              if (!queryLastSeen[q] || entry.ts > queryLastSeen[q]) {
                queryLastSeen[q] = entry.ts;
              }
            }
          }
        } catch { continue; }
      }
    } catch (err) {
      console.warn(`[QueryCollector] Could not read client_${clientId}: ${err.message}`);
    }
  }

  return { zeroResultCounts, queryClients, queryFirstSeen, queryLastSeen };
}

// ─── LOAD LEARNED MAP ─────────────────────────────────────

function loadLearnedMap() {
  try {
    if (!fs.existsSync(PATHS.learnedMap)) return {};
    return JSON.parse(fs.readFileSync(PATHS.learnedMap, 'utf8'));
  } catch {
    return {};
  }
}

// ─── COLLECT QUERIES ──────────────────────────────────────

function collectQueries() {
  console.log('\n[QueryCollector] Reading client logs...');

  const {
    zeroResultCounts,
    queryClients,
    queryFirstSeen,
    queryLastSeen
  } = readClientLogs();

  const learnedMap      = loadLearnedMap();
  const totalZeroResult = Object.keys(zeroResultCounts).length;

  console.log(`[QueryCollector] Found ${totalZeroResult} unique zero-result queries`);

  // filter and sort ✅
  const candidates = [];

  for (const [query, count] of Object.entries(zeroResultCounts)) {
    // skip if count below threshold ✅
    if (count < THRESHOLDS.minFailCount) continue;

    // skip if already in learnedMap ✅
    if (learnedMap[query]) {
      console.log(`[QueryCollector] Already known — skipped: "${query}"`);
      continue;
    }

    // skip very short queries ✅
    if (query.length < 3) continue;

    // skip numeric only ✅
    if (/^\d+$/.test(query)) continue;

    const clients   = [...(queryClients[query]   || [])];
    const firstSeen = queryFirstSeen[query]       || null;
    const lastSeen  = queryLastSeen[query]        || null;

    candidates.push({
      query,
      count,
      clients,
      firstSeen,   // when first failed ✅
      lastSeen,    // when last failed ✅
      // scope hint based on which clients saw this ✅
      scopeHint: deriveScopeHint(clients)
    });
  }

  // sort by frequency ✅
  // most common failures first ✅
  candidates.sort((a, b) => b.count - a.count);

  // limit to max per run ✅
  const limited = candidates.slice(0, THRESHOLDS.maxQueriesPerRun);

  console.log(`[QueryCollector] ${candidates.length} candidates found`);
  console.log(`[QueryCollector] Processing ${limited.length} (max ${THRESHOLDS.maxQueriesPerRun})`);

  return limited;
}

// ─── DERIVE SCOPE HINT ────────────────────────────────────
// derives scope from which clients saw the query ✅
// if only one scope → that scope ✅
// if multiple scopes → global ✅

function deriveScopeHint(clients) {
  if (!clients || clients.length === 0) return 'global';

  const scopes       = clients.map(c => CLIENT_SCOPE[c] || 'general');
  const uniqueScopes = [...new Set(scopes)];

  if (uniqueScopes.length === 1) return uniqueScopes[0];
  return 'global';
}

module.exports = { collectQueries };