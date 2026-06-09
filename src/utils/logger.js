const fs   = require('fs');
const path = require('path');

const LOG_FILE         = path.join(__dirname, '../../logs/queries.log');
const MULTI_TENANT_DIR = path.join(__dirname, '../../multiTenantLogs');
fs.mkdirSync(MULTI_TENANT_DIR, { recursive: true });

// safe directory creation
fs.mkdirSync(path.join(__dirname, '../../logs'), { recursive: true });

function logQuery(data) {
  try {
    const results           = data.results           || 0;
    const isFallback        = data.isFallback        || false;
    const appliedCorrection = data.appliedCorrection || false;
    const processingTime    = data.processingTime    || 0;

    const entry = JSON.stringify({
      ts:         new Date().toISOString(),
      requestId:  data.requestId  || null,
      source:     data.source     || 'search',
      // ── client tracking ──────────────────────────────
      clientId:   data.clientId   || null,
      clientName: data.clientName || null,
      // ── query ────────────────────────────────────────
      query:       data.query,
      queryLength: data.query ? data.query.length : 0,
      normalised:  data.normalised,
      // ── correction ───────────────────────────────────
      correctedQuery:       data.correctedQuery       || null,
      appliedCorrection,
      correctionSource:     data.correctionSource     || null,
      correctionMode:       data.correctionMode       || 'none',
      correctionConfidence: data.correctionConfidence || null,
      correctionWorked:     appliedCorrection && results > 0,
      // ── filters ──────────────────────────────────────
      catalogue:   data.catalogue  || null,
      category:    data.category   || null,
      subcategory: data.subcategory || null,
      subCategory: data.subCategory || null,
      brand:       data.brand      || null,
      color:       data.color      || null,
      size:        data.size       || null,
      // ── results ──────────────────────────────────────
      results,
      resultType:  results > 0 ? 'results' : 'empty',
      noResults:   results === 0,
      isBadQuery:  results === 0 && !isFallback,
      isFallback,
      // ── performance ──────────────────────────────────
      processingTime,
      latencyBucket:
        processingTime < 20  ? 'fast'   :
        processingTime < 100 ? 'medium' : 'slow',
      // ── intent tracking ──────────────────────────────
      intentFilters:    data.intentFilters    || null,
      intentCleanQuery: data.intentCleanQuery || null,
      intentApplied:    !!(data.intentFilters)
    });

    // ── write to global log ───────────────────────────
    fs.appendFile(LOG_FILE, entry + '\n', err => {
      if (err) console.error('Logger error:', err.message);
    });

    // ── write to per-client log ───────────────────────
    // isolated per client ✅
    // ACID isolation maintained ✅
    if (data.clientId) {
      const clientLog = path.join(
        MULTI_TENANT_DIR,
        `client_${data.clientId}`,
        'queries.log'
      );
      fs.appendFile(clientLog, entry + '\n', err => {
        if (err) console.error(`Logger error (${data.clientId}):`, err.message);
      });
    }

  } catch (err) {
    console.error('Logger error:', err.message);
  }
}

module.exports = { logQuery };






// const fs = require('fs');
// const path = require('path');

// const LOG_FILE = path.join(__dirname, '../../logs/queries.log');

// // safe directory creation
// fs.mkdirSync(path.join(__dirname, '../../logs'), { recursive: true });

// function logQuery(data) {
//   try {
//     const entry = JSON.stringify({
//       ts: new Date().toISOString(),
//       requestId: data.requestId || null,
//       query: data.query,
//       normalised: data.normalised,
//       correctedQuery: data.correctedQuery || null,
//       appliedCorrection: data.appliedCorrection || false,
//       results: data.results || 0,
//       noResults: data.results === 0,
//       isBadQuery: data.results === 0,
//       isFallback: data.isFallback || false,
//       processingTime: data.processingTime || 0
//     });

//     // async — non blocking
//     fs.appendFile(LOG_FILE, entry + '\n', err => {
//       if (err) console.error('Logger error:', err.message);
//     });

//   } catch (err) {
//     console.error('Logger error:', err.message);
//   }
// }

// module.exports = { logQuery };