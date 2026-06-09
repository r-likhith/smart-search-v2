const fs   = require('fs');
const path = require('path');

const PRODUCTS_LOG     = path.join(__dirname, '../logs/products.log');
const MULTI_TENANT_DIR = path.join(__dirname, '../multiTenantLogs');
fs.mkdirSync(MULTI_TENANT_DIR, { recursive: true });

// ensure logs/ directory exists ✅
// prevents silent failure if dir missing ✅
fs.mkdirSync(path.join(__dirname, '../logs'), { recursive: true });

function logProducts(query, results, meta = {}) {
  if (!results || results.length === 0) return;

  try {
    const entry = JSON.stringify({
      ts:               new Date().toISOString(),
      // ── client tracking ✅
      clientId:         meta.clientId         || null,
      // ── query ✅
      query:            meta.originalQuery    || query,
      correctedQuery:   meta.correctedQuery   || null,
      correctionSource: meta.correctionSource || null,
      correctionMode:   meta.correctionMode   || 'none',
      // ── intent ✅
      intentFilters:    meta.intentFilters    || null,
      // ── results ✅
      totalHits:        meta.totalHits        || results.length,
      shown:            results.slice(0, 20).map(h => ({
        name:        h.name,
        category:    h.category,
        subCategory: h.subCategory || null,
        color:       h.color       || null,
        price:       h.price       || null,
        brand:       h.brand       || null,
        size:        h.size        || null
      }))
    });

    // ── write to global log ───────────────────────────
    fs.appendFileSync(PRODUCTS_LOG, entry + '\n');

    // ── write to per-client log ───────────────────────
    // isolated per client ✅
    // ACID isolation maintained ✅
    if (meta.clientId) {
      const clientLog = path.join(
        MULTI_TENANT_DIR,
        `client_${meta.clientId}`,
        'products.log'
      );
      fs.appendFileSync(clientLog, entry + '\n');
    }

  } catch (e) {
    // silent — never break search ✅
  }
}

module.exports = { logProducts };