const fs = require('fs');
const path = require('path');
const { normalise } = require('../query/normalise');

const CLICKS_FILE = path.join(__dirname, '../../learned/clicks.json');

// ─── CONFIG ───────────────────────────────────────────────
const MIN_CLICKS_TO_LEARN = 5;
const DOMINANCE_THRESHOLD = 0.6;
const DEDUP_WINDOW_MS = 5000;
const MAX_RAW_CLICKS = 10000;

// ─── WRITE QUEUE ──────────────────────────────────────────
let isWriting = false;
let pendingSave = false;

// ─── IN MEMORY ────────────────────────────────────────────
let clickData = {
  raw: [],
  aggregated: {}
};

// ─── LOAD CLICKS ──────────────────────────────────────────

function loadClicks() {
  try {
    fs.mkdirSync(path.dirname(CLICKS_FILE), { recursive: true });

    if (fs.existsSync(CLICKS_FILE)) {
      const raw = fs.readFileSync(CLICKS_FILE, 'utf8');
      clickData = JSON.parse(raw);
      console.log(`Click data loaded: ${clickData.raw.length} raw clicks`);
    } else {
      console.log('No click data found — starting fresh');
      saveClicks();
    }
  } catch (err) {
    console.error('Failed to load clicks:', err.message);
    clickData = { raw: [], aggregated: {} };
  }
}

// ─── EXTRACT CORRECTION KEYWORD ───────────────────────────
// Returns correction (clean word) + aggregationKey (collision-safe)

function extractCorrectionKeyword(productName, category, subcategory) {
  // Fix 3 — last 2 meaningful words as fallback
  const fallback = normalise(productName)
    .split(' ')
    .filter(w => w.length > 3)
    .slice(-2)
    .join(' ') || normalise(productName);

  // clean correction word for learnedMap
  const correction = subcategory
    ? normalise(subcategory)
    : category
    ? normalise(category)
    : fallback;

  // Fix 4 — composite key prevents collision
  const aggregationKey = subcategory && category
    ? `${normalise(subcategory)}::${normalise(category)}`
    : correction;

  return { correction, aggregationKey };
}

// ─── RECORD CLICK ─────────────────────────────────────────

function recordClick(data) {
  try {
    const {
      query,
      productId,
      productName,
      category,
      subcategory,
      requestId
    } = data;

    if (!query || !productId) {
      console.warn('recordClick: missing query or productId');
      return { recorded: false, reason: 'missing data' };
    }

    const normalisedQuery = normalise(query);
    const now = Date.now();

    // dedup within 5 seconds
    const recentDuplicate = clickData.raw.some(c =>
      c.normalised === normalisedQuery &&
      c.productId === productId &&
      now - new Date(c.timestamp).getTime() < DEDUP_WINDOW_MS
    );

    if (recentDuplicate) {
      console.log(`[Click] Duplicate ignored: "${query}"`);
      return { recorded: false, reason: 'duplicate' };
    }

    // Fix 1 — isFirst = unique query+product combination ever
    const isFirst = !clickData.raw.some(c =>
      c.normalised === normalisedQuery &&
      c.productId === productId
    );

    // Fix 3 + 4 — extract both correction and aggregation key
    const { correction, aggregationKey } = extractCorrectionKeyword(
      productName || '',
      category,
      subcategory
    );

    // store rich click data
    const click = {
      query,
      normalised: normalisedQuery,
      productId,
      productName: productName || '',
      correction,
      aggregationKey,
      category: category || null,
      subcategory: subcategory || null,
      timestamp: new Date().toISOString(),
      requestId: requestId || null,
      isFirst
    };

    // limit raw clicks size
    if (clickData.raw.length >= MAX_RAW_CLICKS) {
      clickData.raw.shift();
    }
    clickData.raw.push(click);

    // update aggregation
    updateAggregation(
      normalisedQuery,
      correction,
      aggregationKey,
      category,
      subcategory,
      isFirst
    );

    saveClicks();

    console.log(`[Click] Recorded: "${query}" → "${correction}" (key: ${aggregationKey}, first: ${isFirst})`);

    // ─── HYBRID AUTO-BUILD TRIGGER ────────────────────────
    try {
      const { incrementClickCount, shouldBuild } = require('./buildState');
      incrementClickCount();

      if (shouldBuild()) {
        console.log('[Auto] Build conditions met — triggering...');
        const { triggerBuildSafe } = require('./builder');
        triggerBuildSafe().catch(err =>
          console.error('[Auto] Build error:', err.message)
        );
      }
    } catch (buildErr) {
      console.error('[Auto] Build trigger error:', buildErr.message);
    }

    return { recorded: true, isFirst };

  } catch (err) {
    console.error('recordClick error:', err.message);
    return { recorded: false, reason: err.message };
  }
}

// ─── UPDATE AGGREGATION ───────────────────────────────────

function updateAggregation(
  normalisedQuery,
  correction,
  aggregationKey,
  category,
  subcategory,
  isFirst
) {
  try {
    if (!clickData.aggregated[normalisedQuery]) {
      clickData.aggregated[normalisedQuery] = {};
    }

    const queryAgg = clickData.aggregated[normalisedQuery];

    if (!queryAgg[aggregationKey]) {
      queryAgg[aggregationKey] = {
        count: 0,
        correction,
        category: category || null,
        subcategory: subcategory || null,
        lastSeen: null
      };
    }

    // Fix 1 — only unique clicks count
    if (isFirst) {
      queryAgg[aggregationKey].count++;
    }
    queryAgg[aggregationKey].lastSeen = new Date().toISOString();

  } catch (err) {
    console.error('updateAggregation error:', err.message);
  }
}

// ─── GET LEARNABLE CORRECTIONS ────────────────────────────

function getLearnableCorrections() {
  const corrections = [];

  for (const [query, products] of Object.entries(clickData.aggregated)) {

    const totalClicks = Object.values(products)
      .reduce((sum, p) => sum + p.count, 0);

    for (const [aggregationKey, data] of Object.entries(products)) {
      const dominance = totalClicks > 0 ? data.count / totalClicks : 0;

      if (
        data.count >= MIN_CLICKS_TO_LEARN &&
        dominance >= DOMINANCE_THRESHOLD
      ) {
        corrections.push({
          query,
          correction: data.correction || aggregationKey.split('::')[0],
          aggregationKey,
          count: data.count,
          dominance: parseFloat(dominance.toFixed(2)),
          category: data.category,
          subcategory: data.subcategory,
          lastSeen: data.lastSeen
        });
      }
    }
  }

  return corrections.sort((a, b) => b.count - a.count);
}

// ─── SAVE CLICKS ──────────────────────────────────────────

function saveClicks() {
  if (isWriting) {
    pendingSave = true;
    return;
  }

  isWriting = true;
  pendingSave = false;

  fs.mkdirSync(path.dirname(CLICKS_FILE), { recursive: true });

  fs.writeFile(
    CLICKS_FILE,
    JSON.stringify(clickData, null, 2),
    err => {
      isWriting = false;
      if (err) console.error('Failed to save clicks:', err.message);
      if (pendingSave) saveClicks();
    }
  );
}

// ─── STATS ────────────────────────────────────────────────

function getClickStats() {
  const learnable = getLearnableCorrections();
  return {
    totalRawClicks: clickData.raw.length,
    uniqueQueries: Object.keys(clickData.aggregated).length,
    learnableCorrections: learnable.length,
    topCorrections: learnable.slice(0, 5)
  };
}

module.exports = {
  loadClicks,
  recordClick,
  getLearnableCorrections,
  getClickStats
};