const fs = require('fs');
const path = require('path');
const { normalise } = require('../query/normalise');

const MAP_FILE   = path.join(__dirname, '../../learned/learnedMap.json');
const INDEX_FILE = path.join(__dirname, '../../learned/reverseIndex.json');
const MAX_VARIANTS = 20;

// ─── CONFIG ───────────────────────────────────────────────
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// confidence per source — used on new entry creation
const SOURCE_CONFIDENCE = {
  manual:            0.95,
  click:             0.80,
  symspell:          0.85,
  phonetic:          0.80,
  'phonetic+intent': 0.80,
  'symspell+intent': 0.85,
  ollama:            0.75,
  csv:               0.85,
  csv_fixed:         0.85,
  'ollama+intent':   0.75,
  auto:              0.75
};

// gate threshold — entries below this are blocked
// must be lower than lowest source confidence (ollama = 0.75)
const CONFIDENCE_GATE = 0.70;

// ─── PROMOTION LIFECYCLE ──────────────────────────────────
const TRUSTED_THRESHOLD = 5;
const PROVEN_THRESHOLD  = 50;
const REENABLE_CLICKS   = 3;

// ─── WRITE LOCKS ──────────────────────────────────────────
let isWriting        = false;
let pendingMapSave   = false;
let isWritingIndex   = false;
let pendingIndexSave = false;

// ─── SCOPE BLOCK COUNTER ──────────────────────────────────
// tracks how often scope enforcement fires ✅
// resets on server restart ✅
// exposed in getStats for dashboard visibility ✅
let scopeBlocks = 0;

// ─── IN MEMORY ────────────────────────────────────────────
let learnedMap   = {};
let reverseIndex = {};

// ─── LOAD MAP ─────────────────────────────────────────────

function loadMap() {
  try {
    if (fs.existsSync(MAP_FILE)) {
      const raw = fs.readFileSync(MAP_FILE, 'utf8');
      learnedMap = JSON.parse(raw);
      console.log(`Learned map loaded: ${Object.keys(learnedMap).length} entries`);
    } else {
      console.warn('learnedMap.json not found — starting empty');
    }

    if (fs.existsSync(INDEX_FILE)) {
      const raw = fs.readFileSync(INDEX_FILE, 'utf8');
      reverseIndex = JSON.parse(raw);
      console.log(`Reverse index loaded: ${Object.keys(reverseIndex).length} correct words`);
    } else {
      console.warn('reverseIndex.json not found — starting empty');
    }

    // ── migrate count → hitCount ──────────────────────────
    let migrated = 0;
    const now = new Date().toISOString();
    for (const entry of Object.values(learnedMap)) {
      let changed = false;
      if (entry.count !== undefined && entry.hitCount === undefined) {
        entry.hitCount = entry.count;
        delete entry.count;
        changed = true;
      }
      if (!('firstSeen' in entry)) {
        entry.firstSeen = entry.lastUpdated || now;
        changed = true;
      }
      if (!('lastUsed' in entry)) {
        entry.lastUsed = entry.lastUpdated || now;
        changed = true;
      }
      if (changed) migrated++;
    }
    if (migrated > 0) {
      console.log(`LearnedMap migrated: ${migrated} entries ✅`);
      saveMapToDisk();
    }

  } catch (err) {
    console.error('Failed to load learned map:', err.message);
    learnedMap   = {};
    reverseIndex = {};
  }
}

// ─── PROMOTION ENGINE ─────────────────────────────────────

function getPromotedStatus(entry) {
  if (entry.status === 'proven')   return null;
  if (entry.status === 'disabled') return null;
  if (entry.hitCount >= PROVEN_THRESHOLD)  return 'proven';
  if (entry.hitCount >= TRUSTED_THRESHOLD) return 'trusted';
  return null;
}

// ─── APPLY CORRECTION ─────────────────────────────────────
// context = { clientId, clientScope } ✅
// scope enforcement ACTIVE ✅
// electronics corrections blocked for grocery clients ✅
// global scope applies to all clients ✅

function applyCorrection(query, currentResults = null, context = {}) {
  try {
    const key   = normalise(query);
    const entry = learnedMap[key];

    // ── exact full-query match ────────────────────────────
    if (entry) {
      // disabled entries are blocked ✅
      if (entry.status === 'disabled') {
        console.log(`[Gate] "${key}" blocked — status: disabled`);
        return { query, corrected: false };
      }

      if (entry.confidence < CONFIDENCE_GATE) {
        console.log(`[Gate] "${key}" blocked — confidence ${entry.confidence} < ${CONFIDENCE_GATE}`);
        return { query, corrected: false };
      }

      // ── scope enforcement ─────────────────────────────
      // block correction if entry scope doesn't match
      // client scope ✅
      // global entries apply everywhere ✅
      // entries without scope apply everywhere ✅
      // only blocks when both sides have explicit scope ✅
      if (
        entry.scope &&
        entry.scope !== 'global' &&
        context.clientScope &&
        context.clientScope !== entry.scope
      ) {
        scopeBlocks++;
        console.log(`[Gate] "${key}" blocked — scope mismatch: entry=${entry.scope} client=${context.clientScope} (total blocks: ${scopeBlocks})`);
        return { query, corrected: false };
      }

      if (entry.onlyIfNoResults === true && currentResults > 0) {
        return { query, corrected: false };
      }

      // update lastUsed on every hit ✅
      entry.lastUsed = new Date().toISOString();
      saveMapToDisk();

      return {
        query:      normalise(entry.correction),
        corrected:  true,
        original:   query,
        confidence: entry.confidence,
        source:     entry.source || 'manual'
      };
    }

    // ── word-level match ──────────────────────────────────
    // checks each word individually against learnedMap ✅
    // IMPORTANT: only fires for single-word corrections ✅
    // prevents "door" → "door mat" expanding mid-phrase ✅
    const words = key.split(/\s+/);
    if (words.length > 1) {
      const correctedWords = [...words];
      let anyChanged    = false;
      let minConfidence = 1.0;
      const sources     = [];

      for (let i = 0; i < words.length; i++) {
        const wordEntry = learnedMap[words[i]];
        if (
          wordEntry &&
          wordEntry.status !== 'disabled' &&
          wordEntry.confidence >= CONFIDENCE_GATE
        ) {
          // ── scope check at word level too ───────────────
          if (
            wordEntry.scope &&
            wordEntry.scope !== 'global' &&
            context.clientScope &&
            context.clientScope !== wordEntry.scope
          ) {
            scopeBlocks++;
            console.log(`[Gate] word "${words[i]}" blocked — scope mismatch: entry=${wordEntry.scope} client=${context.clientScope}`);
            continue;
          }

          // word-level only fires for single-word corrections ✅
          const correctionWords = wordEntry.correction.split(/\s+/);
          if (correctionWords.length > 1) continue;

          correctedWords[i] = wordEntry.correction;
          anyChanged        = true;
          minConfidence     = Math.min(minConfidence, wordEntry.confidence);
          if (!sources.includes(wordEntry.source)) {
            sources.push(wordEntry.source || 'manual');
          }
        }
      }

      if (anyChanged) {
        const corrected = correctedWords.join(' ');
        console.log(`[LearnedMap] Word-level: "${key}" → "${corrected}"`);

        const now = new Date().toISOString();
        for (let i = 0; i < words.length; i++) {
          const wordEntry = learnedMap[words[i]];
          if (wordEntry && wordEntry.status !== 'disabled') {
            wordEntry.lastUsed = now;
          }
        }
        saveMapToDisk();

        return {
          query:      corrected,
          corrected:  true,
          original:   query,
          confidence: minConfidence,
          source:     sources.join('+')
        };
      }
    }

    return { query, corrected: false };

  } catch (err) {
    console.error('learnedMap error:', err.message);
    return { query, corrected: false };
  }
}

// ─── PENALISE CORRECTION ──────────────────────────────────
// context = { clientId, clientScope } ✅
// scope enforcement active — cross-client penalise blocked ✅
// if correction scope doesn't match client scope → skip ✅
// prevents grocery client destroying electronics correction ✅

function penaliseCorrection(originalQuery, context = {}) {
  try {
    const key = normalise(originalQuery);
    if (!learnedMap[key]) return;

    const entry = learnedMap[key];

    // proven entries are protected ✅
    if (entry.status === 'proven') {
      console.log(`[Penalise] "${key}" protected — status: proven`);
      return;
    }

    // ── scope enforcement on penalise ─────────────────────
    // if entry has a specific scope and this client
    // has a different scope → skip penalisation ✅
    // grocery client should not penalise electronics entry ✅
    if (
      entry.scope &&
      entry.scope !== 'global' &&
      context.clientScope &&
      context.clientScope !== entry.scope
    ) {
      console.log(`[Penalise] "${key}" skipped — scope mismatch: entry=${entry.scope} client=${context.clientScope}`);
      return;
    }

    entry.failures   = (entry.failures || 0) + 1;
    entry.confidence = parseFloat(
      Math.max(0, entry.confidence - 0.1).toFixed(3)
    );

    // ── cross-client penalty tracking ─────────────────────
    if (context.clientId && entry.scope && entry.scope !== 'global') {
      entry.lastPenalisedByClient = context.clientId;
      entry.lastPenalisedAt       = new Date().toISOString();

      if (context.clientId !== String(entry.learnedFrom || '')) {
        console.warn(`[Penalise] ⚠️  Cross-client penalty detected!`);
        console.warn(`           "${key}" scope:${entry.scope} penalised by client_${context.clientId}`);
        console.warn(`           learnedFrom: client_${entry.learnedFrom || 'unknown'}`);
      }
    }

    console.log(
      `[Penalise] "${key}" → failures: ${entry.failures}, confidence: ${entry.confidence}` +
      `${context.clientId ? ' client:' + context.clientId : ''}` +
      `${entry.scope && entry.scope !== 'global' ? ' scope:' + entry.scope : ''}`
    );

    if (entry.confidence < 0.5) {
      console.log(`[Remove] "${key}" deleted — confidence too low after ${entry.failures} failures`);
      delete learnedMap[key];
      removeFromReverseIndex(key);
    }

    saveMapToDisk();

  } catch (err) {
    console.error('penaliseCorrection error:', err.message);
  }
}

// ─── REMOVE FROM REVERSE INDEX ────────────────────────────

function removeFromReverseIndex(wrongWord) {
  try {
    for (const [correctWord, data] of Object.entries(reverseIndex)) {
      const idx = data.variants.indexOf(wrongWord);
      if (idx !== -1) {
        data.variants.splice(idx, 1);
        data.totalVariants = Math.max(0, data.totalVariants - 1);
        if (data.variants.length === 0) {
          delete reverseIndex[correctWord];
        }
        saveReverseIndex();
        break;
      }
    }
  } catch (err) {
    console.error('removeFromReverseIndex error:', err.message);
  }
}

// ─── SAVE MAP TO DISK ─────────────────────────────────────
// atomic write: tmp → rename ✅
// pendingMapSave ensures no update is silently dropped ✅

function saveMapToDisk() {
  if (isWriting) {
    pendingMapSave = true;
    return;
  }

  isWriting      = true;
  pendingMapSave = false;

  fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });

  const data    = JSON.stringify(learnedMap, null, 2);
  const tmpFile = MAP_FILE + '.tmp';

  fs.writeFile(tmpFile, data, err => {
    if (err) {
      isWriting = false;
      console.error('Failed to write temp map:', err.message);
      if (pendingMapSave) {
        pendingMapSave = false;
        saveMapToDisk();
      }
      return;
    }
    fs.rename(tmpFile, MAP_FILE, err => {
      isWriting = false;
      if (err) console.error('Failed to rename map:', err.message);
      if (pendingMapSave) {
        pendingMapSave = false;
        saveMapToDisk();
      }
    });
  });
}

// ─── UPDATE REVERSE INDEX ─────────────────────────────────

function updateReverseIndex(wrongWord, correctWord, hitCount, confidence, source) {
  try {
    const key = normalise(correctWord);
    if (!key) return;

    if (!reverseIndex[key]) {
      reverseIndex[key] = {
        variants:               [],
        totalVariants:          0,
        totalCount:             0,
        confidence:             0,
        _weightedConfidenceSum: 0,
        sources:                []
      };
    }

    const entry = reverseIndex[key];

    if (!entry.variants.includes(wrongWord)) {
      entry.variants.push(wrongWord);
      entry.totalVariants++;
    }

    entry.totalCount             += hitCount;
    entry._weightedConfidenceSum += confidence * hitCount;
    entry.confidence              = parseFloat(
      (entry._weightedConfidenceSum / entry.totalCount).toFixed(3)
    );

    if (source && !entry.sources.includes(source)) {
      entry.sources.push(source);
    }

    entry.variants = entry.variants
      .sort((a, b) => {
        const countA = learnedMap[a]?.hitCount || 0;
        const countB = learnedMap[b]?.hitCount || 0;
        return countB - countA;
      })
      .slice(0, MAX_VARIANTS);

    saveReverseIndex();

  } catch (err) {
    console.error('updateReverseIndex error:', err.message);
  }
}

// ─── SAVE REVERSE INDEX ───────────────────────────────────

function saveReverseIndex() {
  if (isWritingIndex) {
    pendingIndexSave = true;
    return;
  }

  isWritingIndex   = true;
  pendingIndexSave = false;

  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });

  const toSave = {};
  for (const [k, v] of Object.entries(reverseIndex)) {
    const { _weightedConfidenceSum, ...rest } = v;
    toSave[k] = rest;
  }

  const tmpIndex = INDEX_FILE + '.tmp';

  fs.writeFile(tmpIndex, JSON.stringify(toSave, null, 2), err => {
    if (err) {
      isWritingIndex = false;
      console.error('Failed to write temp index:', err.message);
      if (pendingIndexSave) {
        pendingIndexSave = false;
        saveReverseIndex();
      }
      return;
    }
    fs.rename(tmpIndex, INDEX_FILE, err => {
      isWritingIndex = false;
      if (err) console.error('Failed to rename index:', err.message);
      if (pendingIndexSave) {
        pendingIndexSave = false;
        saveReverseIndex();
      }
    });
  });
}

// ─── SAVE CORRECTION ──────────────────────────────────────

function saveCorrection(originalQuery, correctedQuery, source = 'auto', resultsCount = 0, dominanceWeight = null) {
  try {
    if (resultsCount === 0) {
      console.warn(`saveCorrection skipped — no results for "${correctedQuery}"`);
      return;
    }

    const key       = normalise(originalQuery);
    const corrected = normalise(correctedQuery);
    if (!key || !corrected) return;

    const now = new Date().toISOString();

    if (learnedMap[key]) {
      const entry     = learnedMap[key];
      const oldStatus = entry.status || 'candidate';

      const nowMs = Date.now();
      const timeSinceUpdate = entry.lastUpdated
        ? nowMs - new Date(entry.lastUpdated).getTime()
        : Infinity;

      const cooldownFactor = timeSinceUpdate === Infinity
        ? 1.0
        : Math.min(1.0, Math.max(0.1, timeSinceUpdate / COOLDOWN_MS));

      if (cooldownFactor < 1.0) {
        console.log(`[Cooldown] "${key}" reduced — factor: ${cooldownFactor.toFixed(2)} (${Math.round(timeSinceUpdate / 1000)}s ago)`);
      }

      entry.hitCount = (entry.hitCount || entry.count || 0) + 1;
      if (entry.count !== undefined) delete entry.count;

      if (source === 'click') {
        const boost = dominanceWeight !== null ? dominanceWeight : 0.05;
        entry.confidence = parseFloat(
          Math.min(0.95, entry.confidence + (boost * cooldownFactor)).toFixed(3)
        );

        if (entry.status === 'disabled') {
          entry.clicksSinceDisabled = (entry.clicksSinceDisabled || 0) + 1;

          if (entry.clicksSinceDisabled >= REENABLE_CLICKS) {
            console.log(`[Restore] "${key}" re-enabled by ${REENABLE_CLICKS} clicks ✅`);
            entry.status              = 'candidate';
            entry.lastPromotedAt      = now;
            entry.clicksSinceDisabled = 0;
            delete entry.disabledAt;
            delete entry.disabledBy;
          } else {
            console.log(`[Restore] "${key}" ${entry.clicksSinceDisabled}/${REENABLE_CLICKS} clicks to re-enable`);
          }
          saveMapToDisk();
          return;
        }

      } else {
        entry.confidence = parseFloat(
          Math.min(0.95, entry.confidence + ((1 / entry.hitCount) * cooldownFactor)).toFixed(3)
        );
      }

      entry.failures = 0;

      if (cooldownFactor >= 1.0) {
        entry.lastUpdated = now;
      }

      const newStatus = getPromotedStatus(entry);
      if (newStatus && newStatus !== oldStatus) {
        entry.status         = newStatus;
        entry.lastPromotedAt = now;
        console.log(`[LearnedMap] Promoted "${key}" ${oldStatus} → ${newStatus} (hitCount: ${entry.hitCount})`);
      }

    } else {
      learnedMap[key] = {
        correction:  corrected,
        confidence:  SOURCE_CONFIDENCE[source] || 0.75,
        hitCount:    1,
        failures:    0,
        source,
        status:      'candidate',
        firstSeen:   now,
        lastUsed:    now,
        lastUpdated: now
      };
    }

    updateReverseIndex(
      key,
      corrected,
      learnedMap[key].hitCount,
      learnedMap[key].confidence,
      source
    );

    saveMapToDisk();

  } catch (err) {
    console.error('saveCorrection error:', err.message);
  }
}

// ─── STATS ────────────────────────────────────────────────

function getStats() {
  const entries = Object.values(learnedMap);
  const now     = Date.now();
  const day7    = 7  * 24 * 60 * 60 * 1000;
  const day90   = 90 * 24 * 60 * 60 * 1000;

  return {
    totalEntries:      Object.keys(learnedMap).length,
    manualEntries:     entries.filter(e => e.source === 'manual').length,
    autoEntries:       entries.filter(e => e.source === 'auto').length,
    clickEntries:      entries.filter(e => e.source === 'click').length,
    symspellEntries:   entries.filter(e => e.source === 'symspell').length,
    ollamaEntries:     entries.filter(e => e.source === 'ollama').length,
    phoneticEntries:   entries.filter(e => e.source === 'phonetic').length,
    csvEntries:        entries.filter(e => e.source === 'csv').length,
    blockedEntries:    entries.filter(e => e.confidence < CONFIDENCE_GATE).length,
    failedEntries:     entries.filter(e => (e.failures || 0) > 0).length,
    disabledEntries:   entries.filter(e => e.status === 'disabled').length,
    candidateEntries:  entries.filter(e => e.status === 'candidate').length,
    trustedEntries:    entries.filter(e => e.status === 'trusted').length,
    provenEntries:     entries.filter(e => e.status === 'proven').length,
    groqEntries:       entries.filter(e => e.source === 'groq').length,
    reverseIndexSize:  Object.keys(reverseIndex).length,
    highValueEntries:  entries.filter(e => (e.hitCount || 0) >= 10).length,
    neverUsed:         entries.filter(e => (e.hitCount || 0) === 0).length,
    scopeBlocksTotal:  scopeBlocks,  // ← new: scope enforcement metric ✅
    promotedLast7Days: entries.filter(e =>
      e.lastPromotedAt &&
      (now - new Date(e.lastPromotedAt).getTime()) < day7
    ).length,
    staleEntries:      entries.filter(e =>
      (e.hitCount || 0) === 0 &&
      e.lastUsed &&
      (now - new Date(e.lastUsed).getTime()) > day90
    ).length
  };
}

module.exports = {
  loadMap,
  applyCorrection,
  saveCorrection,
  penaliseCorrection,
  getStats
};