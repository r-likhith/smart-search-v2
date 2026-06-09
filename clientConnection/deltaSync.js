// ─── DELTA SYNC ───────────────────────────────────────────
// Incremental sync — only changed products since last run
//
// Rules:
// UPSERT → status:true + approved:approved (even if out of stock)
// DELETE → status:false OR approved:pending/rejected
// Out of stock → UPSERT (keep visible, frontend shows badge)
//
// Safety:
// → PIT + search_after (no missed docs, no clock skew)
// → _seq_no change detection (replaces updated_at)
// → concurrent lock persisted to disk
// → heartbeat recovery (crash-safe)
// → circuit breaker (3 failures → pause 1hr)
// → retry with exponential backoff
// → adaptive intervals based on activity
// → error isolation (one client fail ≠ others fail)
// → rich metrics per client
// → never crashes server

require('dotenv').config();
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { MeiliSearch } = require('meilisearch');
const clients = require('../configVendors/clients');

// ─── CONFIG ───────────────────────────────────────────────
const ES_NODE     = process.env.ES_NODE;
const ES_USERNAME = process.env.ES_USERNAME;
const ES_PASSWORD = process.env.ES_PASSWORD;
const MEILI_HOST  = 'http://localhost:7700';
const BATCH_SIZE  = 100;
const STATE_DIR   = path.join(__dirname, '../sync_state');
const PIT_KEEP_ALIVE = '2m';

const CIRCUIT_BREAKER_THRESHOLD  = 3;
const CIRCUIT_BREAKER_PAUSE_MS   = 60 * 60 * 1000; // 1 hour
const MAX_RETRIES                = 3;
const RETRY_BASE_MS              = 1000;
const HEARTBEAT_INTERVAL_MS      = 30 * 1000;       // 30 seconds
const HEARTBEAT_STALE_MS         = 5 * 60 * 1000;   // 5 minutes = crashed

const meili = new MeiliSearch({ host: MEILI_HOST });

// ─── RUNTIME STATE (in-memory timers only) ────────────────
const runtimeTimers = {};

function getTimer(clientId) {
  if (!runtimeTimers[clientId]) runtimeTimers[clientId] = { timer: null, heartbeat: null };
  return runtimeTimers[clientId];
}

// ─── STATE FILE ───────────────────────────────────────────

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readState(clientId) {
  const file = path.join(STATE_DIR, `client_${clientId}.json`);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  } catch(e) {}
  return {
    clientId,
    // change detection
    lastSeqNo:            null,   // replaces updated_at
    lastPrimaryTerm:      null,
    lastSync:             null,
    // lock
    isRunning:            false,
    syncStartedAt:        null,
    heartbeat:            null,
    // adaptive interval
    productCount:         0,
    currentIntervalMs:    getDefaultInterval(0),
    // circuit breaker
    consecutiveFailures:  0,
    isPaused:             false,
    pausedUntil:          null,
    // metrics
    lastChangeCount:      0,
    lastSyncDurationMs:   0,
    totalSyncs:           0,
    totalUpserted:        0,
    totalDeleted:         0,
    lastError:            null,
    totalRetries:         0,
    successfulSyncs:      0
  };
}

function writeState(clientId, updates) {
  const file    = path.join(STATE_DIR, `client_${clientId}.json`);
  const current = readState(clientId);
  const next    = { ...current, ...updates, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

// ─── CRASH RECOVERY ───────────────────────────────────────
// on startup check if any client was mid-sync when crashed
// detected by: isRunning=true AND heartbeat > HEARTBEAT_STALE_MS ago

function recoverStuckLocks() {
  const activeClients = Object.entries(clients)
    .filter(([, c]) => c.active && c.synced);

  for (const [clientId] of activeClients) {
    const state = readState(clientId);
    if (!state.isRunning) continue;

    const heartbeatAge = state.heartbeat
      ? Date.now() - new Date(state.heartbeat).getTime()
      : Infinity;

    if (heartbeatAge > HEARTBEAT_STALE_MS) {
      console.log(`[DeltaSync] ⚠️  client_${clientId} stuck lock detected — recovering`);
      writeState(clientId, {
        isRunning:     false,
        syncStartedAt: null,
        heartbeat:     null
      });
    }
  }
}

// ─── ADAPTIVE INTERVAL ────────────────────────────────────

function getDefaultInterval(productCount) {
  if (productCount > 5000) return 10 * 60 * 1000; // 10 mins
  if (productCount > 500)  return 15 * 60 * 1000; // 15 mins
  return                         30 * 60 * 1000;  // 30 mins
}

function getNextInterval(currentIntervalMs, changeCount, productCount) {
  if (changeCount > 50)  return  5 * 60 * 1000;  // very active
  if (changeCount > 10)  return 10 * 60 * 1000;  // active
  if (changeCount === 0) return Math.min(currentIntervalMs * 1.5, 60 * 60 * 1000); // slow down
  return getDefaultInterval(productCount);         // reset to default
}

// ─── RETRY WRAPPER ────────────────────────────────────────

async function withRetry(fn, label, retryCounter = { count: 0 }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      retryCounter.count++;
      if (attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        console.log(`  [retry] ${label} attempt ${attempt} — waiting ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }
  throw lastError;
}

// ─── KIBANA PROXY REQUEST ─────────────────────────────────

async function esRequest(method, esPath, body = null) {
  const baseUrl   = ES_NODE.replace(/\/$/, '');
  const proxyPath = '/api/console/proxy?path=' +
    encodeURIComponent(esPath) + '&method=' + method;
  const fullUrl   = new URL(baseUrl + proxyPath);

  const hasBody   = body !== null;
  const reqBody   = hasBody ? JSON.stringify(body) : null;

  const options = {
    hostname: fullUrl.hostname,
    port:     fullUrl.port || (fullUrl.protocol === 'https:' ? 443 : 80),
    path:     fullUrl.pathname + fullUrl.search,
    method:   'POST',
    headers: {
      'Content-Type':  'application/json',
      'kbn-xsrf':      'true',
      'Authorization': 'Basic ' +
        Buffer.from(`${ES_USERNAME}:${ES_PASSWORD}`).toString('base64'),
      'Content-Length': hasBody ? Buffer.byteLength(reqBody) : 0
    },
    rejectUnauthorized: false
  };

  return new Promise((resolve, reject) => {
    const protocol = fullUrl.protocol === 'https:' ? https : http;
    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    if (hasBody) req.write(reqBody);
    req.end();
  });
}

// ─── PIT HELPERS ─────────────────────────────────────────

async function openPit(esIndex) {
  const resp = await esRequest('POST', `/${esIndex}/_pit?keep_alive=${PIT_KEEP_ALIVE}`);
  if (!resp.id) throw new Error('Failed to open PIT: ' + JSON.stringify(resp).substring(0, 200));
  return resp.id;
}

async function closePit(pitId) {
  try {
    await esRequest('DELETE', '/_pit', { id: pitId });
  } catch(e) {
    // silent — PIT auto-expires anyway
  }
}

// ─── FIELD MAPPERS ────────────────────────────────────────

function extractColor(variants = []) {
  const v = variants.find(v =>
    v.name && ['colour','color'].includes(v.name.toLowerCase())
  );
  return v ? v.value : null;
}

function extractSize(variants = []) {
  const v = variants.find(v =>
    v.name && ['storage','ram','size','capacity','gm','kg','ml','l',
      'weight','volume','pack','packing','number'].includes(v.name.toLowerCase())
  );
  return v ? v.value : null;
}

function extractPrice(doc) {
  if (doc.max_sale_price > 0) return doc.max_sale_price;
  if (doc.sale_price > 0)     return doc.sale_price;
  if (doc.mrp_price > 0)      return doc.mrp_price;
  if (doc.prices) {
    const key = Object.keys(doc.prices)[0];
    if (key) return doc.prices[key].sale_price || doc.prices[key].mrp_price || 0;
  }
  return 0;
}

function buildDescription(doc) {
  const parts = [];
  if (doc.short_description)
    parts.push(doc.short_description.replace(/<[^>]*>/g, '').trim());
  if (doc.description)
    parts.push(doc.description.replace(/<[^>]*>/g, '').trim());
  if (doc.specifications?.length)
    parts.push(doc.specifications.map(s => `${s.name}: ${s.value}`).join('. '));
  const hl = [doc.highlight1,doc.highlight2,doc.highlight3,
              doc.highlight4,doc.highlight5].filter(Boolean).join('. ');
  if (hl) parts.push(hl);
  return parts.join(' ').trim() || null;
}

function mapProduct(doc) {
  return {
    id:          doc.id,
    sku:         doc.sku,
    name:        doc.title || doc.product_name,
    description: buildDescription(doc),
    catalogue:   doc.category_l1_name || null,
    category:    doc.category_l2_name || doc.category_l1_name || null,
    subcategory: doc.category_l3_name || null,
    subCategory: doc.category_l4_name || null,
    brand:       doc.brand_name || null,
    price:       extractPrice(doc),
    mrp:         doc.mrp_price || 0,
    color:       extractColor(doc.variants || []),
    size:        extractSize(doc.variants || []),
    popularity:  doc.is_top_seller ? 10 : (doc.is_featured ? 5 : 0),
    sales:       0,
    inStock:     (doc.qty > 0 || doc.stock > 0),
    isActive:    doc.status === true && doc.approved_status === 'approved',
    vendorId:    doc.vendor_id,
    slug:        doc.product_slug,
    thumbnail:   doc.thumbnail
  };
}

// ─── SYNC ONE CLIENT ──────────────────────────────────────

async function syncOneClient(clientId, clientConfig) {
  const state      = readState(clientId);
  const esIndex    = clientConfig.esIndex;
  const meiliIndex = clientConfig.meiliIndex;
  const syncStart  = Date.now();
  const syncTs     = new Date().toISOString();
  const retryCounter = { count: 0 };

  // ── circuit breaker ────────────────────────────────────
  if (state.isPaused) {
    const pausedUntil = new Date(state.pausedUntil).getTime();
    if (Date.now() < pausedUntil) {
      const minsLeft = Math.round((pausedUntil - Date.now()) / 60000);
      console.log(`  [${clientId}] ⏸ Paused — ${minsLeft} mins remaining`);
      scheduleNext(clientId, clientConfig, state.currentIntervalMs);
      return { upserted: 0, deleted: 0, skipped: true };
    }
    console.log(`  [${clientId}] ▶ Circuit reset — resuming`);
    writeState(clientId, { isPaused: false, pausedUntil: null, consecutiveFailures: 0 });
  }

  // ── concurrent lock (persisted) ───────────────────────
  if (state.isRunning) {
    const heartbeatAge = state.heartbeat
      ? Date.now() - new Date(state.heartbeat).getTime()
      : Infinity;
    if (heartbeatAge < HEARTBEAT_STALE_MS) {
      console.log(`  [${clientId}] ⏳ Already running — skipping`);
      scheduleNext(clientId, clientConfig, state.currentIntervalMs);
      return { upserted: 0, deleted: 0, skipped: true };
    }
    console.log(`  [${clientId}] ⚠️ Stale lock — recovering`);
  }

  // ── acquire lock ───────────────────────────────────────
  writeState(clientId, {
    isRunning:     true,
    syncStartedAt: syncTs,
    heartbeat:     syncTs
  });

  // ── heartbeat timer ────────────────────────────────────
  const timers = getTimer(clientId);
  if (timers.heartbeat) clearInterval(timers.heartbeat);
  timers.heartbeat = setInterval(() => {
    writeState(clientId, { heartbeat: new Date().toISOString() });
  }, HEARTBEAT_INTERVAL_MS);

  let upserted = 0;
  let deleted  = 0;
  let pitId    = null;

  try {
    console.log(`\n  [${clientId}] ${clientConfig.name}`);
    console.log(`  Last seq_no: ${state.lastSeqNo ?? 'none (full sync)'}`);

    // ── build query ────────────────────────────────────
    // use _seq_no for change detection (no clock skew) ✅
    const query = state.lastSeqNo !== null ? {
      bool: {
        filter: [
          { range: { _seq_no: { gt: state.lastSeqNo } } }
        ]
      }
    } : { match_all: {} };

    // ── open PIT for consistent pagination ─────────────
    pitId = await withRetry(
      () => openPit(esIndex),
      `client_${clientId} open PIT`,
      retryCounter
    );

    let searchAfter  = null;
    let hasMore      = true;
    let maxSeqNo     = state.lastSeqNo || 0;
    let maxPrimTerm  = state.lastPrimaryTerm || 0;

    // ── batch tasks for bulk writing ───────────────────
    const meiliUpsertBatches = [];
    const meiliDeleteBatches = [];

    while (hasMore) {
      const searchBody = {
        size:  BATCH_SIZE,
        query,
        sort: [
          { _seq_no:    { order: 'asc' } },
          { _shard_doc: 'asc' }
        ],
        pit:   { id: pitId, keep_alive: PIT_KEEP_ALIVE },
        seq_no_primary_term: true   // return _seq_no + _primary_term ✅
      };
      if (searchAfter) searchBody.search_after = searchAfter;

      const resp = await withRetry(
        () => esRequest('GET', '/_search', searchBody),
        `client_${clientId} search_after`,
        retryCounter
      );

      if (!resp.hits?.hits) {
        console.error(`  [${clientId}] Unexpected ES response`);
        break;
      }

      const hits = resp.hits.hits;
      if (hits.length === 0) { hasMore = false; break; }

      const toUpsert = [];
      const toDelete = [];

      for (const hit of hits) {
        const doc = hit._source;
        const isActive = doc.status === true &&
                         doc.approved_status === 'approved';

        // track highest seq_no seen ✅
        if (hit._seq_no > maxSeqNo) {
          maxSeqNo    = hit._seq_no;
          maxPrimTerm = hit._primary_term;
        }

        if (isActive) {
          toUpsert.push(mapProduct(doc));
        } else {
          if (doc.id) toDelete.push(doc.id);
        }
      }

      if (toUpsert.length > 0) meiliUpsertBatches.push(toUpsert);
      if (toDelete.length > 0) meiliDeleteBatches.push(toDelete);

      // search_after uses last sort value ✅
      searchAfter = hits[hits.length - 1].sort;
      if (hits.length < BATCH_SIZE) hasMore = false;

      // update PIT id (ES may return new one)
      if (resp.pit_id) pitId = resp.pit_id;
    }

    // ── close PIT ──────────────────────────────────────
    await closePit(pitId);
    pitId = null;

    // ── bulk write to Meilisearch ──────────────────────
    // collect all tasks first, then wait at end (faster) ✅
    const meiliTasks = [];

    for (const batch of meiliUpsertBatches) {
      const task = await meili.index(meiliIndex).addDocuments(batch);
      meiliTasks.push(task.taskUid);
      upserted += batch.length;
    }

    for (const batch of meiliDeleteBatches) {
      const task = await meili.index(meiliIndex).deleteDocuments(batch);
      meiliTasks.push(task.taskUid);
      deleted += batch.length;
    }

    // wait for all Meilisearch tasks at once ✅
    for (const taskUid of meiliTasks) {
      await meili.waitForTask(taskUid);
    }

    process.stdout.write(
      `\r  [${clientId}] upserted: ${upserted} deleted: ${deleted}   \n`
    );

    const durationMs  = Date.now() - syncStart;
    const changeCount = upserted + deleted;
    const syncNumber  = (state.totalSyncs || 0) + 1;

    // ── product count ──────────────────────────────────
    // first run: always get real count from Meilisearch ✅
    // subsequent runs: incremental estimate (fast) ✅
    // every 10 syncs: verify against Meilisearch ✅
    let productCount = state.productCount || 0;
    const isFirstRun = state.lastSeqNo === null;

    if (isFirstRun || syncNumber % 10 === 0) {
      // get real count — first run or periodic check ✅
      try {
        const stats = await meili.index(meiliIndex).getStats();
        productCount = stats.numberOfDocuments;
        if (isFirstRun) {
          console.log(`  [${clientId}] 📦 Initial count: ${productCount}`);
        } else {
          console.log(`  [${clientId}] 🔍 Count verified: ${productCount}`);
        }
      } catch(e) {
        // fallback to upserted count on first run ✅
        if (isFirstRun) productCount = upserted;
      }
    } else {
      // incremental estimate — no API call ✅
      // only subtract real deletes (products that existed in Meili)
      // use upserted only — deletions may be no-ops on Meili ✅
      productCount = Math.max(0, productCount + upserted);
    }

    const nextInterval = getNextInterval(
      state.currentIntervalMs, changeCount, productCount
    );

    // ── write state ────────────────────────────────────
    writeState(clientId, {
      // change detection
      lastSeqNo:           maxSeqNo,
      lastPrimaryTerm:     maxPrimTerm,
      lastSync:            syncTs,
      // lock release
      isRunning:           false,
      syncStartedAt:       null,
      heartbeat:           null,
      // product count
      productCount:        productCount,
      // interval
      currentIntervalMs:   nextInterval,
      // circuit breaker reset
      consecutiveFailures: 0,
      isPaused:            false,
      pausedUntil:         null,
      // metrics
      lastChangeCount:     changeCount,
      lastSyncDurationMs:  durationMs,
      lastError:           null,
      totalRetries:        (state.totalRetries || 0) + retryCounter.count,
      totalSyncs:          syncNumber,
      successfulSyncs:     (state.successfulSyncs || 0) + 1,
      totalUpserted:       (state.totalUpserted || 0) + upserted,
      totalDeleted:        (state.totalDeleted || 0) + deleted
    });

    console.log(
      `  [${clientId}] ✅ upserted:${upserted} deleted:${deleted}` +
      ` duration:${durationMs}ms nextIn:${Math.round(nextInterval/60000)}mins`
    );

    scheduleNext(clientId, clientConfig, nextInterval);
    return { upserted, deleted };

  } catch (e) {
    // close PIT if still open
    if (pitId) await closePit(pitId).catch(() => {});

    const failures = (state.consecutiveFailures || 0) + 1;
    console.error(`\n  [${clientId}] ❌ ${e.message} (failure ${failures})`);

    const isPausing = failures >= CIRCUIT_BREAKER_THRESHOLD;
    const pausedUntil = isPausing
      ? new Date(Date.now() + CIRCUIT_BREAKER_PAUSE_MS).toISOString()
      : null;

    writeState(clientId, {
      isRunning:           false,
      syncStartedAt:       null,
      heartbeat:           null,
      consecutiveFailures: failures,
      isPaused:            isPausing,
      pausedUntil:         pausedUntil,
      lastError:           e.message,
      totalRetries:        (state.totalRetries || 0) + retryCounter.count
    });

    if (isPausing) {
      console.error(`  [${clientId}] ⚡ Circuit opened — paused until ${pausedUntil}`);
    }

    scheduleNext(clientId, clientConfig, state.currentIntervalMs);
    return { upserted: 0, deleted: 0, error: e.message };

  } finally {
    // clear heartbeat timer
    if (timers?.heartbeat) {
      clearInterval(timers.heartbeat);
      timers.heartbeat = null;
    }
  }
}

// ─── SCHEDULER ────────────────────────────────────────────

function scheduleNext(clientId, clientConfig, intervalMs) {
  const timers = getTimer(clientId);
  if (timers.timer) clearTimeout(timers.timer);
  timers.timer = setTimeout(() => {
    syncOneClient(clientId, clientConfig).catch(e => {
      console.error(`[DeltaSync] Unhandled: ${clientId}:`, e.message);
    });
  }, intervalMs);
}

// ─── STATUS (used by GET /api/sync/status) ────────────────

function getStatus() {
  const activeClients = Object.entries(clients)
    .filter(([, c]) => c.active && c.synced);

  const result = {};
  for (const [clientId, clientConfig] of activeClients) {
    const state   = readState(clientId);
    const timers  = getTimer(clientId);
    const nextMs  = timers.timer?._idleStart + timers.timer?._idleTimeout - Date.now();
    const nextIn  = nextMs > 0 ? `${Math.round(nextMs / 60000)}mins` : 'soon';
    const successRate = state.totalSyncs > 0
      ? Math.round((state.successfulSyncs / state.totalSyncs) * 100)
      : null;

    result[clientId] = {
      name:               clientConfig.name,
      type:               clientConfig.type,
      // sync state
      lastSync:           state.lastSync,
      lastSeqNo:          state.lastSeqNo,
      nextSyncIn:         nextIn,
      currentInterval:    `${Math.round(state.currentIntervalMs / 60000)}mins`,
      isRunning:          state.isRunning,
      // health
      isPaused:           state.isPaused,
      pausedUntil:        state.pausedUntil,
      consecutiveFailures: state.consecutiveFailures,
      lastError:          state.lastError,
      // metrics
      lastChangeCount:    state.lastChangeCount,
      lastDurationMs:     state.lastSyncDurationMs,
      totalSyncs:         state.totalSyncs,
      successfulSyncs:    state.successfulSyncs,
      successRate:        successRate ? `${successRate}%` : null,
      totalUpserted:      state.totalUpserted,
      totalDeleted:       state.totalDeleted,
      totalRetries:       state.totalRetries
    };
  }
  return result;
}

// ─── WEBHOOK TRIGGER (future-ready) ───────────────────────

function triggerSync(clientId) {
  const clientConfig = clients[clientId];
  if (!clientConfig?.active) {
    console.log(`[DeltaSync] triggerSync: unknown client ${clientId}`);
    return false;
  }
  console.log(`[DeltaSync] Manual trigger: client ${clientId}`);
  syncOneClient(clientId, clientConfig).catch(console.error);
  return true;
}

// ─── START ────────────────────────────────────────────────

function start() {
  ensureStateDir();
  recoverStuckLocks(); // crash recovery on startup ✅

  const activeClients = Object.entries(clients)
    .filter(([, c]) => c.active && c.synced);

  console.log('\n🔄 Delta sync starting...');
  console.log(`   Clients: ${activeClients.map(([id]) => id).join(', ')}`);
  console.log(`   Change detection: _seq_no (no clock skew) ✅`);
  console.log(`   Pagination: PIT + search_after ✅`);
  console.log(`   Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} failures → 1hr pause`);
  console.log(`   Retry: ${MAX_RETRIES}x exponential backoff`);
  console.log(`   Heartbeat: every ${HEARTBEAT_INTERVAL_MS/1000}s\n`);

  // stagger — 5s apart to avoid hammering ES
  activeClients.forEach(([clientId, clientConfig], index) => {
    setTimeout(() => {
      syncOneClient(clientId, clientConfig).catch(e => {
        console.error(`[DeltaSync] Start error ${clientId}:`, e.message);
      });
    }, index * 5000);
  });
}

// ─── EXPORTS ──────────────────────────────────────────────

module.exports = { start, triggerSync, getStatus };

// ─── AUTO-START ───────────────────────────────────────────

if (process.env.ENABLE_DELTA_SYNC === 'true') {
  start();
} else {
  console.log('[DeltaSync] Disabled — set ENABLE_DELTA_SYNC=true to enable');
}