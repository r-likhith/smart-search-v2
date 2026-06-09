const express = require('express');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
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

function checkApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== config.apiKey) {
    return next(new AuthError('Invalid or missing API key'));
  }
  next();
}

// ─── SUCCESS RATE HELPER ──────────────────────────────────
// successRate CONTRIBUTES to confidence ✅
// not the same as confidence ✅
// formula: (hitCount - failures) / hitCount ✅
// requires sample size to be meaningful ✅

function calcSuccessRate(hitCount, failures) {
  if (!hitCount || hitCount === 0) return null;
  return parseFloat(
    ((hitCount - (failures || 0)) / hitCount * 100).toFixed(1)
  );
}

// ─── SOURCE PERFORMANCE HELPER ────────────────────────────
// per-source quality breakdown ✅
// answers: is groq producing quality vs symspell vs manual? ✅
// only meaningful once entries have real traffic ✅
// neverUsed = candidate entries with 0 hits ✅
// withTraffic = entries that have been used at least once ✅

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
      withTraffic:    withTraffic.length,      // used at least once ✅
      avgSuccessRate: avgRate,                  // null until real traffic ✅
      trusted:        entries.filter(e => e.status === 'trusted').length,
      proven:         entries.filter(e => e.status === 'proven').length,
      disabled:       entries.filter(e => e.status === 'disabled').length,
      neverUsed:      entries.filter(e => !e.hitCount || e.hitCount === 0).length
    };
  }

  return result;
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
    if (!query) {
      return res.status(400).json({ success: false, error: 'Query parameter ?q= is required' });
    }
    const data = replayQuery(query);
    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
      query,
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
// POST /api/admin/reload ✅
// reloads learnedMap + suggestMap from disk ✅
// no server restart needed ✅
// call after offline learner runs ✅
// call after manual learnedMap edits ✅

app.post('/api/admin/reload', checkApiKey, (req, res) => {
  try {
    loadMap();
    loadSuggestMap();
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

// ─── ADMIN: CORRECTIONS DASHBOARD ────────────────────────
// GET /api/admin/corrections ✅
// read-only view of learnedMap health ✅
// shows: stats, sourcePerformance, top corrections,
//        groq candidates, disabled entries,
//        cross-client risks, lowestSuccessRate ✅
// successRate = (hitCount - failures) / hitCount ✅
// successRate CONTRIBUTES to confidence ✅
// not the same as confidence alone ✅

app.get('/api/admin/corrections', checkApiKey, (req, res) => {
  try {
    const stats = getStats();
    const map   = JSON.parse(
      fs.readFileSync('./learned/learnedMap.json', 'utf8')
    );

    // ── source performance ────────────────────────────
    // per-source quality breakdown ✅
    // key metric for evaluating groq vs symspell vs manual ✅
    // avgSuccessRate = null until real traffic flows ✅
    const sourcePerformance = calcSourcePerformance(map);

    // ── top corrections by hitCount ───────────────────
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

    // ── lowest successRate ────────────────────────────
    // pruning candidates — entries below 80% with sample ≥ 5 ✅
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

    // ── groq candidates ───────────────────────────────
    // pending real-world validation ✅
    // status: candidate until real traffic promotes them ✅
    const groqCandidates = Object.entries(map)
      .filter(([, e]) => e.source === 'groq' && e.status === 'candidate')
      .map(([key, e]) => ({
        query:      key,
        correction: e.correction,
        confidence: e.confidence,
        scope:      e.scope     || null,
        firstSeen:  e.firstSeen || null
      }));

    // ── disabled entries ──────────────────────────────
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

    // ── cross-client risks ────────────────────────────
    // visibility only — no enforcement yet ✅
    // grows = consider scope enforcement ✅
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

    // ── system-wide avgSuccessRate ────────────────────
    // health signal — null until enough traffic ✅
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
      sourcePerformance,    // ← per-source quality ✅
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
  server.close(() => { console.log('Server closed.'); process.exit(0); });
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  server.close(() => { console.log('Server closed.'); process.exit(0); });
});

// ─── OLLAMA HEALTH CHECK ──────────────────────────────────
// Ollama removed from search path ✅
// kept for offline learner only ✅

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
    if (!config.apiKey) { console.error('❌ Missing API_KEY'); process.exit(1); }
    if (!config.port)   { console.error('❌ Missing PORT');    process.exit(1); }

    await createIndexes();
    console.log('Meilisearch indexes ready');

    // ─── LEARNEDMAP ───────────────────────────────────
    try {
      loadMap();
      const stats = getStats();
      console.log(`Learned map ready: ${stats.totalEntries} entries (${stats.manualEntries} manual, ${stats.clickEntries} click, ${stats.disabledEntries} disabled)`);
    } catch (e) {
      console.error('Learned map failed:', e.message);
      console.warn('Continuing without learned map...');
    }

    // ─── SUGGESTMAP ───────────────────────────────────
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

    // ─── SYMSPELL ─────────────────────────────────────
    try {
      await initSymSpell();
      await loadBrands(meiliClient);
    } catch (e) {
      console.warn('⚠️  SymSpell failed — dictionary corrections disabled');
      console.warn(`   Error: ${e.message}`);
    }

    // ─── PHONETIC INDEX ───────────────────────────────
    try {
      buildPhoneticIndex();
    } catch (e) {
      console.warn('⚠️  Phonetic index failed — phonetic corrections disabled');
      console.warn(`   Error: ${e.message}`);
    }

    // ─── FEATURE FLAGS ────────────────────────────────
    const features = require('./src/searchBanners/features');
    console.log('Feature flags:');
    console.log(`  retrievalCorrection:   ${features.retrievalCorrection}`);
    console.log(`  cosmeticCorrection:    ${features.cosmeticCorrection}`);
    console.log(`  correctionBanner:      ${features.correctionBanner}`);
    console.log(`  searchInsteadLink:     ${features.searchInsteadLink}`);
    console.log(`  silentInputCorrection: ${features.silentInputCorrection}`);

    // ─── OLLAMA (offline only) ────────────────────────
    await checkOllama();

    // ─── DELTA SYNC ───────────────────────────────────
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
      console.log(`\n🌿 Smart Search v2`);
      console.log(`Running at http://localhost:${config.port}`);
      console.log(`\nEndpoints:`);
      console.log(`GET  /api/health`);
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
      console.log(`GET  /api/admin/corrections`);
      console.log(`\nPages:`);
      console.log(`GET  /              → Search UI`);
      console.log(`GET  /analytics     → Analytics Dashboard`);
      console.log(`GET  /demos         → Client Demo Pages`);
    });

  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();