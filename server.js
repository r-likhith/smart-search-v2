const express = require('express');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const fetch = require('node-fetch');
const { createIndexes } = require('./src/meilisearch/indexes');
const { errorHandler, AuthError } = require('./src/utils/errors');
const { loadMap, getStats } = require('./src/learned/learnedMap');
const { loadMap: loadSuggestMap, getStats: getSuggestStats } = require('./src/learned/suggestMap');
const { loadClicks, getClickStats } = require('./src/behaviour/tracker');
const { loadBuildState, getBuildState, shouldBuild } = require('./src/behaviour/buildState');
const { triggerBuildSafe } = require('./src/behaviour/builder');
const { initSymSpell } = require('./src/spellcheck/symspell');
const { buildIndex: buildPhoneticIndex } = require('./src/spellcheck/phonetic');
const { loadBrands } = require('./src/query/intentParser');
const meiliClient = require('./src/meilisearch/client');
const { aggregate, replayQuery } = require('./analytics/aggregator');
const config = require('./src/config');
const { loadKeys, validateKey, persistKeys, getAllKeys } = require('./src/auth/apiKeyManager');

// ─── CONFIG VALIDATION ────────────────────────────────────
// Fail immediately with a clear message if any required
// env var is missing — catches .env typos on Oracle VM
// deployment before they cause confusing runtime errors ✅
// Runs before any route, middleware, or DB init. ✅

const REQUIRED_ENV = [
  'MEILI_HOST',
  'MEILI_MASTER_KEY',
  'API_KEY',
  'PORT',
  'GROQ_API_KEY'
];

const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error('');
  console.error('❌ Missing required environment variables:');
  missingEnv.forEach(k => console.error(`   - ${k}`));
  console.error('');
  console.error('   Check your .env file against .env.example');
  console.error('   Server will not start until all required vars are set.');
  console.error('');
  process.exit(1);
}

// ─── BACKUP HELPER ────────────────────────────────────────
// shared by both the nightly scheduler and the pre-reload
// trigger — single place to change backup behavior ✅

function runBackup(reason = 'scheduled') {
  const start = Date.now();
  exec('bash ./scripts/backup.sh', (err, stdout) => {
    if (err) {
      console.error(`[Backup] ❌ Failed (${reason}): ${err.message}`);
    } else {
      console.log(`[Backup] ✅ Complete (${reason}, ${Date.now() - start}ms)`);
      if (stdout) {
        const summary = stdout.split('\n').find(l => l.includes('Backup complete'));
        if (summary) console.log(`[Backup] ${summary.trim()}`);
      }
    }
  });
}

// Routes
const searchRoute    = require('./src/api/search');
const suggestRoute   = require('./src/api/suggest');
const navigateRoute  = require('./src/api/navigate');
const healthRoute    = require('./src/api/health');
const behaviourRoute = require('./src/api/behaviour');

const app = express();

// ─── MIDDLEWARE ───────────────────────────────────────────

app.use((req, res, next) => {
  res.locals.requestId = crypto.randomUUID();
  next();
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use('/api/health', healthRoute);

const suggestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  handler: (req, res) => res.status(429).json({
    success: false,
    timestamp: new Date().toISOString(),
    requestId: res.locals.requestId || null,
    error: { type: 'RateLimitError', message: 'Too many requests.', code: 'RATE_LIMIT_ERROR' }
  })
});

const defaultLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  handler: (req, res) => res.status(429).json({
    success: false,
    timestamp: new Date().toISOString(),
    requestId: res.locals.requestId || null,
    error: { type: 'RateLimitError', message: 'Too many requests.', code: 'RATE_LIMIT_ERROR' }
  })
});

morgan.token('id', (req, res) => res.locals.requestId || '-');
app.use(morgan(':id :method :url :status :response-time ms'));

// ─── API KEY AUTH ─────────────────────────────────────────
// Per-client keys — clientId injected from key, not body ✅
// Legacy shared key (searchapikey123) still works ✅
// clientId in body that mismatches key → rejected ✅

function checkApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return next(new AuthError('Missing API key'));
  }

  const origin       = req.headers['origin'] || req.headers['referer'] || null;
  const clientConfig = validateKey(apiKey, origin);

  if (!clientConfig) {
    return next(new AuthError('Invalid or disabled API key'));
  }

  // inject clientId from key — client does NOT need to send clientId ✅
  req.resolvedClientId     = clientConfig.clientId;
  req.resolvedClientConfig = clientConfig;

  // reject if clientId in body mismatches key's clientId ✅
  // prevents confusion where developer sends wrong clientId
  // legacy key has clientId: null — skip this check for it ✅
  const bodyClientId = req.body?.clientId;
  if (
    bodyClientId &&
    clientConfig.clientId &&
    String(bodyClientId) !== String(clientConfig.clientId)
  ) {
    return next(new AuthError(
      `clientId in request body (${bodyClientId}) does not match API key — remove clientId from body`
    ));
  }

  next();
}

// ─── PERMISSION CHECK HELPER ──────────────────────────────
// used by admin endpoints to verify permission ✅
// returns true if permitted, false otherwise ✅

function hasPermission(req, permission) {
  return req.resolvedClientConfig?.permissions?.[permission] === true;
}

// ─── SUCCESS RATE HELPER ──────────────────────────────────

function calcSuccessRate(hitCount, failures) {
  if (!hitCount || hitCount === 0) return null;
  return parseFloat(
    ((hitCount - (failures || 0)) / hitCount * 100).toFixed(1)
  );
}

// ─── SOURCE PERFORMANCE HELPER ────────────────────────────

function calcSourcePerformance(map) {
  const sources = ['manual', 'symspell', 'phonetic', 'groq', 'ollama', 'click'];
  const result  = {};

  for (const src of sources) {
    const entries = Object.values(map).filter(e => e.source === src);
    if (entries.length === 0) continue;

    const withTraffic = entries.filter(e => (e.hitCount || 0) >= 1);
    const rates       = withTraffic
      .map(e => calcSuccessRate(e.hitCount, e.failures))
      .filter(r => r !== null);
    const avgRate     = rates.length > 0
      ? parseFloat((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1))
      : null;

    result[src] = {
      entries:        entries.length,
      withTraffic:    withTraffic.length,
      avgSuccessRate: avgRate,
      trusted:        entries.filter(e => e.status === 'trusted').length,
      proven:         entries.filter(e => e.status === 'proven').length,
      disabled:       entries.filter(e => e.status === 'disabled').length,
      neverUsed:      entries.filter(e => !e.hitCount || e.hitCount === 0).length
    };
  }

  return result;
}

// ─── RECENT ACTIVITY HELPER ───────────────────────────────

function readRecentActivity(logFile, limit = 50) {
  try {
    if (!fs.existsSync(logFile)) return [];

    const content = fs.readFileSync(logFile, 'utf8');
    const lines   = content.trim().split('\n').filter(Boolean);
    const recent  = lines.slice(-limit);

    return recent
      .map(line => {
        try {
          const e = JSON.parse(line);
          return {
            time:             e.ts ? new Date(e.ts).toLocaleTimeString('en', { hour12: false }) : null,
            timestamp:        e.ts || null,
            clientId:         e.clientId   || null,
            query:            e.query      || null,
            displayQuery:     e.correction?.applied ? e.correction.finalQuery : null,
            correctionMode:   e.correctionMode  || 'none',
            correctionSource: e.correction?.source !== 'none' ? e.correction?.source : null,
            layer:            e.searchStage      || 'meilisearch',
            hits:             e.results?.count   || 0,
            isZeroResult:     e.results?.isZeroResult || false,
            isFallback:       e.results?.isFallback   || false,
            processingTime:   e.timing?.total    || 0,
            latency:          e.timing?.latencyBucket || null,
            corrected:        e.correction?.applied   || false,
            saved:            e.learnedMap?.outcome === 'accepted' || false,
            intentFilters:    Object.keys(e.intent?.filters || {}).length > 0
                                ? e.intent.filters : null,
            why: buildWhyString(e)
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .reverse();

  } catch (e) {
    return [];
  }
}

// ─── WHY STRING BUILDER ───────────────────────────────────

function buildWhyString(e) {
  if (e.results?.isFallback) {
    return 'No results found → showing popular products';
  }
  if (e.correction?.applied) {
    const src   = e.correction.source || 'unknown';
    const query = e.correction.finalQuery;
    const hits  = e.results?.count || 0;
    const saved = e.learnedMap?.outcome === 'accepted' ? ' → saved to learnedMap' : '';
    return `"${e.query}" → "${query}" via ${src} → ${hits} results${saved}`;
  }
  if (e.intent?.filtersApplied) {
    const filters = Object.entries(e.intent.filters || {})
      .map(([k, v]) => `${k}=${v}`).join(', ');
    return `Intent parsed: ${filters} → ${e.results?.count || 0} results`;
  }
  if (e.results?.count === 0) {
    return `No results for "${e.query}" → no correction found`;
  }
  return `Direct search → ${e.results?.count || 0} results`;
}

// ─── SERVE FRONTENDS ──────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'search-test.html'));
});

app.get('/search-test.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'search-test.html'));
});

app.use('/demos', express.static(path.join(__dirname, 'demos')));

// ─── ANALYTICS REPLAY ─────────────────────────────────────

app.get('/api/analytics/replay', checkApiKey, (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    const ts    = (req.query.ts || '').trim() || null;
    if (!query) {
      return res.status(400).json({ success: false, error: 'Query parameter ?q= is required' });
    }
    const latest = req.query.latest === 'true';
    const data   = replayQuery(query, ts, latest);
    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
      query,
      ts: ts || null,
      count: data.length,
      data
    });
  } catch (err) {
    console.error('Replay error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, 'analytics/dashboard.html'));
});

// ─── ANALYTICS API ────────────────────────────────────────

app.get('/api/analytics', checkApiKey, (req, res) => {
  try {
    const clientId = req.query.clientId || null;
    const data = aggregate(clientId);
    if (!data) {
      return res.json({
        success: true,
        timestamp: new Date().toISOString(),
        data: null,
        message: 'No analytics data yet — run some searches first'
      });
    }
    return res.json({ success: true, timestamp: new Date().toISOString(), data });
  } catch (err) {
    console.error('Analytics error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ADMIN: RECENT ACTIVITY ───────────────────────────────

app.get('/api/admin/recent-activity', checkApiKey, (req, res) => {
  try {
    if (!hasPermission(req, 'admin')) {
      return res.status(403).json({ success: false, error: 'Admin permission required' });
    }

    const limit          = Math.min(parseInt(req.query.limit || '50'), 200);
    const filterClient   = req.query.clientId   || null;
    const filterLayer    = req.query.layer       || null;
    const correctionOnly = req.query.correctionOnly === 'true';
    const zeroResultOnly = req.query.zeroResultOnly === 'true';
    const groqOnly       = req.query.groqOnly       === 'true';

    const LOG_FILE = path.join(__dirname, 'logs/analytics.log');
    let events = readRecentActivity(LOG_FILE, limit * 3);

    if (filterClient) {
      const clientLog = path.join(
        __dirname,
        `multiTenantLogs/client_${filterClient}/analytics.log`
      );
      events = readRecentActivity(clientLog, limit * 3);
    }

    if (filterClient && !filterClient === null) {
      events = events.filter(e => e.clientId === filterClient);
    }
    if (filterLayer) {
      events = events.filter(e => e.layer === filterLayer);
    }
    if (correctionOnly) {
      events = events.filter(e => e.corrected === true);
    }
    if (zeroResultOnly) {
      events = events.filter(e => e.isZeroResult === true);
    }
    if (groqOnly) {
      events = events.filter(e => e.correctionSource === 'groq');
    }

    events = events.slice(0, limit);

    const summary = {
      total:         events.length,
      corrected:     events.filter(e => e.corrected).length,
      zeroResults:   events.filter(e => e.isZeroResult).length,
      fallbacks:     events.filter(e => e.isFallback).length,
      avgLatency:    events.length > 0
        ? Math.round(
            events.reduce((a, e) => a + (e.processingTime || 0), 0) / events.length
          )
        : 0,
      layerBreakdown: {
        learnedmap:  events.filter(e => e.layer === 'learnedmap').length,
        symspell:    events.filter(e => e.layer === 'symspell').length,
        phonetic:    events.filter(e => e.layer === 'phonetic').length,
        meilisearch: events.filter(e => e.layer === 'meilisearch').length,
        fallback:    events.filter(e => e.layer === 'fallback').length
      }
    };

    return res.json({
      success:   true,
      timestamp: new Date().toISOString(),
      summary,
      events
    });

  } catch (e) {
    console.error('[Admin] Recent activity failed:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── DELTA SYNC STATUS ────────────────────────────────────

app.get('/api/sync/status', checkApiKey, (req, res) => {
  try {
    const { getStatus } = require('./clientConnection/deltaSync');
    const data = getStatus();
    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
      enabled: process.env.ENABLE_DELTA_SYNC === 'true',
      data
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── WEBHOOK SYNC TRIGGER ─────────────────────────────────

app.post('/api/sync/trigger', checkApiKey, (req, res) => {
  try {
    const { clientId, secret } = req.body;

    if (!secret || secret !== process.env.SYNC_WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, error: 'Invalid webhook secret' });
    }

    if (!clientId) {
      return res.status(400).json({ success: false, error: 'clientId is required' });
    }

    const { triggerSync } = require('./clientConnection/deltaSync');
    const triggered = triggerSync(clientId);

    return res.json({
      success: triggered,
      message: triggered
        ? `Sync triggered for client ${clientId}`
        : `Unknown or inactive client: ${clientId}`
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── ADMIN: RELOAD MAP ────────────────────────────────────

app.post('/api/admin/reload', checkApiKey, (req, res) => {
  try {
    if (!hasPermission(req, 'admin')) {
      return res.status(403).json({ success: false, error: 'Admin permission required' });
    }

    // backup before reload ✅
    runBackup('pre-reload');

    loadMap();
    loadSuggestMap();
    loadKeys(); // reload API keys too ✅
    const stats        = getStats();
    const suggestStats = getSuggestStats();
    console.log('[Admin] Maps reloaded ✅');
    return res.json({
      success:   true,
      timestamp: new Date().toISOString(),
      learnedMap: {
        totalEntries:     stats.totalEntries,
        candidateEntries: stats.candidateEntries,
        trustedEntries:   stats.trustedEntries,
        provenEntries:    stats.provenEntries,
        disabledEntries:  stats.disabledEntries,
        groqEntries:      stats.groqEntries
      },
      suggestMap: {
        totalCompletions: suggestStats.totalCompletions
      }
    });
  } catch (e) {
    console.error('[Admin] Reload failed:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── ADMIN: LIST API KEYS ─────────────────────────────────
// returns key previews only — never full keys ✅
// admin permission required ✅

app.get('/api/admin/keys', checkApiKey, (req, res) => {
  try {
    if (!hasPermission(req, 'admin')) {
      return res.status(403).json({ success: false, error: 'Admin permission required' });
    }
    return res.json({
      success:   true,
      timestamp: new Date().toISOString(),
      keys:      getAllKeys()
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── ADMIN: CORRECTIONS DASHBOARD ────────────────────────

app.get('/api/admin/corrections', checkApiKey, (req, res) => {
  try {
    if (!hasPermission(req, 'admin')) {
      return res.status(403).json({ success: false, error: 'Admin permission required' });
    }

    const stats = getStats();
    const map   = JSON.parse(
      fs.readFileSync('./learned/learnedMap.json', 'utf8')
    );

    const sourcePerformance = calcSourcePerformance(map);

    const topCorrections = Object.entries(map)
      .filter(([, e]) => (e.hitCount || 0) > 0)
      .sort(([, a], [, b]) => (b.hitCount || 0) - (a.hitCount || 0))
      .slice(0, 20)
      .map(([key, e]) => ({
        query:       key,
        correction:  e.correction,
        hitCount:    e.hitCount       || 0,
        failures:    e.failures       || 0,
        successRate: calcSuccessRate(e.hitCount, e.failures),
        confidence:  e.confidence,
        status:      e.status         || 'candidate',
        source:      e.source,
        lastUsed:    e.lastUsed       || null,
        firstSeen:   e.firstSeen      || null,
        promotedAt:  e.lastPromotedAt || null
      }));

    const lowestSuccessRate = Object.entries(map)
      .filter(([, e]) => (e.hitCount || 0) >= 5)
      .map(([key, e]) => ({
        query:       key,
        correction:  e.correction,
        hitCount:    e.hitCount  || 0,
        failures:    e.failures  || 0,
        successRate: calcSuccessRate(e.hitCount, e.failures),
        status:      e.status    || 'candidate',
        source:      e.source
      }))
      .filter(e => e.successRate !== null && e.successRate < 80)
      .sort((a, b) => (a.successRate || 100) - (b.successRate || 100))
      .slice(0, 10);

    const groqCandidates = Object.entries(map)
      .filter(([, e]) => e.source === 'groq' && e.status === 'candidate')
      .map(([key, e]) => ({
        query:      key,
        correction: e.correction,
        confidence: e.confidence,
        scope:      e.scope     || null,
        firstSeen:  e.firstSeen || null
      }));

    const disabledEntries = Object.entries(map)
      .filter(([, e]) => e.status === 'disabled')
      .map(([key, e]) => ({
        query:               key,
        correction:          e.correction,
        failures:            e.failures            || 0,
        confidence:          e.confidence,
        successRate:         calcSuccessRate(e.hitCount, e.failures),
        disabledAt:          e.disabledAt          || null,
        clicksSinceDisabled: e.clicksSinceDisabled || 0
      }));

    const crossClientRisks = Object.entries(map)
      .filter(([, e]) =>
        e.lastPenalisedByClient &&
        e.learnedFrom &&
        String(e.lastPenalisedByClient) !== String(e.learnedFrom)
      )
      .map(([key, e]) => ({
        query:             key,
        correction:        e.correction,
        scope:             e.scope                || 'global',
        learnedFrom:       e.learnedFrom          || null,
        penalisedByClient: e.lastPenalisedByClient,
        penalisedAt:       e.lastPenalisedAt      || null,
        failures:          e.failures             || 0,
        successRate:       calcSuccessRate(e.hitCount, e.failures)
      }));

    const allRates = Object.values(map)
      .filter(e => (e.hitCount || 0) >= 5)
      .map(e => calcSuccessRate(e.hitCount, e.failures))
      .filter(r => r !== null);

    const avgSuccessRate = allRates.length > 0
      ? parseFloat((allRates.reduce((a, b) => a + b, 0) / allRates.length).toFixed(1))
      : null;

    return res.json({
      success:   true,
      timestamp: new Date().toISOString(),
      stats: {
        total:             stats.totalEntries,
        candidates:        stats.candidateEntries,
        trusted:           stats.trustedEntries,
        proven:            stats.provenEntries,
        disabled:          stats.disabledEntries,
        groq:              stats.groqEntries,
        promotedLast7Days: stats.promotedLast7Days,
        neverUsed:         stats.neverUsed,
        highValue:         stats.highValueEntries,
        avgSuccessRate
      },
      sourcePerformance,
      topCorrections,
      lowestSuccessRate,
      groqCandidates,
      disabledEntries,
      crossClientRisks
    });
  } catch (e) {
    console.error('[Admin] Dashboard failed:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─── ROUTES ───────────────────────────────────────────────

app.use('/api/search',    defaultLimiter, checkApiKey, searchRoute);
app.use('/api/suggest',   suggestLimiter, checkApiKey, suggestRoute);
app.use('/api/navigate',  defaultLimiter, checkApiKey, navigateRoute);
app.use('/api/behaviour', defaultLimiter, checkApiKey, behaviourRoute);

// ─── ERROR HANDLER ────────────────────────────────────────

app.use(errorHandler);

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────

let server;

process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  persistKeys(); // flush lastUsed before exit ✅
  server.close(() => { console.log('Server closed.'); process.exit(0); });
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  persistKeys(); // flush lastUsed before exit ✅
  server.close(() => { console.log('Server closed.'); process.exit(0); });
});

// ─── OLLAMA HEALTH CHECK ──────────────────────────────────

async function checkOllama() {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    if (response.ok) {
      const data = await response.json();
      const models = data.models?.map(m => m.name) || [];
      console.log(`Ollama ready ✅ — models: ${models.join(', ')} (offline learner only)`);
      return true;
    }
    console.warn('⚠️  Ollama responded but not ready');
    return false;
  } catch (err) {
    console.warn('⚠️  Ollama not running — offline learner disabled');
    return false;
  }
}

// ─── START ────────────────────────────────────────────────

async function start() {
  try {
    // env vars already validated at top of file ✅

    // ── load per-client API keys ───────────────────────
    loadKeys();

    await createIndexes();
    console.log('Meilisearch indexes ready');

    try {
      loadMap();
      const stats = getStats();
      console.log(`Learned map ready: ${stats.totalEntries} entries (${stats.manualEntries} manual, ${stats.clickEntries} click, ${stats.disabledEntries} disabled)`);
    } catch (e) {
      console.error('Learned map failed:', e.message);
      console.warn('Continuing without learned map...');
    }

    try {
      loadSuggestMap();
      const suggestStats = getSuggestStats();
      console.log(`SuggestMap ready: ${suggestStats.totalCompletions} completions`);
    } catch (e) {
      console.error('SuggestMap failed:', e.message);
      console.warn('Continuing without suggestMap...');
    }

    try {
      loadClicks();
      const clickStats = getClickStats();
      console.log(`Click data ready: ${clickStats.totalRawClicks} clicks, ${clickStats.learnableCorrections} learnable`);
    } catch (e) {
      console.error('Click data failed:', e.message);
      console.warn('Continuing without click data...');
    }

    try {
      loadBuildState();
      const buildState = getBuildState();
      console.log(`Build state ready: ${buildState.totalBuilds} builds, ${buildState.clicksSinceLastBuild} pending clicks`);
      if (shouldBuild()) {
        console.log('[Startup] Build conditions met — triggering...');
        triggerBuildSafe().catch(err => console.error('[Startup] Build error:', err.message));
      }
    } catch (e) {
      console.error('Build state failed:', e.message);
      console.warn('Continuing without build state...');
    }

    try {
      await initSymSpell();
      await loadBrands(meiliClient);
    } catch (e) {
      console.warn('⚠️  SymSpell failed — dictionary corrections disabled');
      console.warn(`   Error: ${e.message}`);
    }

    try {
      buildPhoneticIndex();
    } catch (e) {
      console.warn('⚠️  Phonetic index failed — phonetic corrections disabled');
      console.warn(`   Error: ${e.message}`);
    }

    const features = require('./src/searchBanners/features');
    console.log('Feature flags:');
    console.log(`  retrievalCorrection:   ${features.retrievalCorrection}`);
    console.log(`  cosmeticCorrection:    ${features.cosmeticCorrection}`);
    console.log(`  correctionBanner:      ${features.correctionBanner}`);
    console.log(`  searchInsteadLink:     ${features.searchInsteadLink}`);
    console.log(`  silentInputCorrection: ${features.silentInputCorrection}`);

    await checkOllama();

    if (process.env.ENABLE_DELTA_SYNC === 'true') {
      try {
        require('./clientConnection/deltaSync');
        console.log('✅ Delta sync started');
      } catch (e) {
        console.error('❌ Delta sync failed to start:', e.message);
      }
    } else {
      console.log('ℹ️  Delta sync disabled (ENABLE_DELTA_SYNC=false)');
    }

    server = app.listen(config.port, () => {
      // ── formalized startup report ─────────────────────
      const stats        = getStats();
      const suggestStats = getSuggestStats();
      const clickStats   = getClickStats();

      console.log('');
      console.log('╔════════════════════════════════════════╗');
      console.log('║         SMART SEARCH v2 READY          ║');
      console.log('╚════════════════════════════════════════╝');
      console.log(`  Corrections:    ${stats.totalEntries} entries`);
      console.log(`    manual:       ${stats.manualEntries}`);
      console.log(`    groq:         ${stats.groqEntries}`);
      console.log(`    click:        ${stats.clickEntries}`);
      console.log(`    disabled:     ${stats.disabledEntries}`);
      console.log(`  Suggest:        ${suggestStats.totalCompletions} completions`);
      console.log(`  Clicks:         ${clickStats.totalRawClicks} recorded`);
      console.log(`  Meilisearch:    ${process.env.MEILI_HOST}`);
      console.log(`  Port:           ${config.port}`);
      console.log(`  Clients:        8`);
      console.log('════════════════════════════════════════');

      console.log(`\n🌿 Smart Search v2`);
      console.log(`Running at http://localhost:${config.port}`);
      console.log(`\nEndpoints:`);
      console.log(`GET  /api/health`);
      console.log(`GET  /api/health/live`);
      console.log(`GET  /api/health/ready`);
      console.log(`GET  /api/health/deep`);
      console.log(`POST /api/search`);
      console.log(`GET  /api/suggest?q=`);
      console.log(`POST /api/navigate`);
      console.log(`POST /api/behaviour/click`);
      console.log(`GET  /api/behaviour/stats`);
      console.log(`POST /api/behaviour/build`);
      console.log(`GET  /api/behaviour/pending`);
      console.log(`GET  /api/behaviour/buildstate`);
      console.log(`GET  /api/analytics`);
      console.log(`GET  /api/analytics/replay?q=`);
      console.log(`GET  /api/sync/status`);
      console.log(`POST /api/sync/trigger`);
      console.log(`POST /api/admin/reload`);
      console.log(`GET  /api/admin/keys`);
      console.log(`GET  /api/admin/corrections`);
      console.log(`GET  /api/admin/recent-activity`);
      console.log(`\nPages:`);
      console.log(`GET  /              → Search UI`);
      console.log(`GET  /analytics     → Analytics Dashboard`);
      console.log(`GET  /demos         → Client Demo Pages`);

      // ── nightly backup scheduler ──────────────────────
      setInterval(() => runBackup('scheduled'), 24 * 60 * 60 * 1000);
      console.log('\n[Backup] Scheduler started — runs every 24h ✅');

      // ── persist lastUsed every 5 minutes ──────────────
      // keeps key usage data fresh without writing on
      // every single request ✅
      setInterval(() => persistKeys(), 5 * 60 * 1000);
      console.log('[ApiKeys] lastUsed flush scheduled — every 5min ✅');
    });

  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();