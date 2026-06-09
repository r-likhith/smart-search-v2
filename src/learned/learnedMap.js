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
// candidate → trusted → proven ✅
// based on hitCount thresholds ✅
// proven entries protected from pruning + penalisation ✅

const TRUSTED_THRESHOLD = 5;    // hitCount >= 5  → trusted ✅
const PROVEN_THRESHOLD  = 50;   // hitCount >= 50 → proven ✅
const REENABLE_CLICKS   = 3;    // clicks needed to re-enable disabled ✅

// ─── WRITE LOCKS ──────────────────────────────────────────
// pendingSave ensures no update is silently dropped ✅
// same pattern as suggestMap.js ✅

let isWriting        = false;
let pendingMapSave   = false;

let isWritingIndex   = false;
let pendingIndexSave = false;

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
      // only migrate if field completely missing ✅
      // null is intentional (never used) ✅
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
// returns new status if promotion should happen ✅
// returns null if no change needed ✅

function getPromotedStatus(entry) {
  // proven is the highest — never demote ✅
  if (entry.status === 'proven')   return null;
  // disabled handled separately via click re-enable ✅
  if (entry.status === 'disabled') return null;
  // promote based on hitCount ✅
  if (entry.hitCount >= PROVEN_THRESHOLD)  return 'proven';
  if (entry.hitCount >= TRUSTED_THRESHOLD) return 'trusted';
  // stay candidate ✅
  return null;
}

// ─── APPLY CORRECTION ─────────────────────────────────────
// context param: future-proof for scope enforcement ✅
// context = { clientId, clientScope } ✅
// scope enforcement NOT active yet ✅
// API shape ready — callers pass context, ignored for now ✅

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
// context param: { clientId, clientScope } ✅
// tracks cross-client penalties for visibility ✅
// scope enforcement NOT active yet ✅
// when cross-client penalty detected → log warning ✅
// monitor logs → enforce scope when pattern appears ✅

function penaliseCorrection(originalQuery, context = {}) {
  try {
    const key = normalise(originalQuery);
    if (!learnedMap[key]) return;

    const entry = learnedMap[key];

    // proven entries are protected from penalisation ✅
    // 50+ confirmations — one bad result shouldn't destroy it ✅
    if (entry.status === 'proven') {
      console.log(`[Penalise] "${key}" protected — status: proven`);
      return;
    }

    entry.failures   = (entry.failures || 0) + 1;
    entry.confidence = parseFloat(
      Math.max(0, entry.confidence - 0.1).toFixed(3)
    );

    // ── cross-client penalty detection ────────────────────
    // fires when a client penalises a correction
    // that was learned for a different domain ✅
    // visibility only — no enforcement yet ✅
    // watch logs → enforce scope when pattern appears ✅
    if (context.clientId && entry.scope && entry.scope !== 'global') {
      entry.lastPenalisedByClient = context.clientId;
      entry.lastPenalisedAt       = new Date().toISOString();

      if (context.clientId !== String(entry.learnedFrom || '')) {
        console.warn(`[Penalise] ⚠️  Cross-client penalty detected!`);
        console.warn(`           "${key}" scope:${entry.scope} penalised by client_${context.clientId}`);
        console.warn(`           learnedFrom: client_${entry.learnedFrom || 'unknown'}`);
        console.warn(`           This may indicate scope enforcement is needed ✅`);
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
      // flush pending save ✅
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
// atomic write: tmp → rename ✅
// pendingIndexSave ensures no update is silently dropped ✅

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
      // flush pending save ✅
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

        // ── click re-enable for disabled entries ──────────
        // disabled = system saw failures ✅
        // requires REENABLE_CLICKS evidence to come back ✅
        // 3 independent confirmations — not just noise ✅
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
          // don't promote while disabled ✅
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

      // ── promotion engine ──────────────────────────────
      // candidate → trusted → proven ✅
      // fires automatically on every saveCorrection ✅
      // centralised — all sources flow through here ✅
      const newStatus = getPromotedStatus(entry);
      if (newStatus && newStatus !== oldStatus) {
        entry.status         = newStatus;
        entry.lastPromotedAt = now;
        console.log(`[LearnedMap] Promoted "${key}" ${oldStatus} → ${newStatus} (hitCount: ${entry.hitCount})`);
      }

    } else {
      // ── new entry ─────────────────────────────────────
      // explicit status: 'candidate' on creation ✅
      // all new corrections start as candidates ✅
      // promoted automatically as hitCount grows ✅
      learnedMap[key] = {
        correction:  corrected,
        confidence:  SOURCE_CONFIDENCE[source] || 0.75,
        hitCount:    1,
        failures:    0,
        source,
        status:      'candidate',  // explicit lifecycle start ✅
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
    // promotion velocity ✅
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












































// const fs = require('fs');
// const path = require('path');
// const { normalise } = require('../query/normalise');

// const MAP_FILE = path.join(__dirname, '../../learned/learnedMap.json');
// const INDEX_FILE = path.join(__dirname, '../../learned/reverseIndex.json');
// const MAX_VARIANTS = 20;

// // ─── CONFIG ───────────────────────────────────────────────
// // Layer 4 — diminishing reinforcement cooldown
// const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// // ─── WRITE LOCKS ──────────────────────────────────────────
// let isWriting = false;
// let isWritingIndex = false;

// // ─── IN MEMORY ────────────────────────────────────────────
// let learnedMap = {};
// let reverseIndex = {};

// // ─── LOAD MAP ─────────────────────────────────────────────

// function loadMap() {
//   try {
//     if (fs.existsSync(MAP_FILE)) {
//       const raw = fs.readFileSync(MAP_FILE, 'utf8');
//       learnedMap = JSON.parse(raw);
//       console.log(`Learned map loaded: ${Object.keys(learnedMap).length} entries`);
//     } else {
//       console.warn('learnedMap.json not found — starting empty');
//     }

//     if (fs.existsSync(INDEX_FILE)) {
//       const raw = fs.readFileSync(INDEX_FILE, 'utf8');
//       reverseIndex = JSON.parse(raw);
//       console.log(`Reverse index loaded: ${Object.keys(reverseIndex).length} correct words`);
//     } else {
//       console.warn('reverseIndex.json not found — starting empty');
//     }

//   } catch (err) {
//     console.error('Failed to load learned map:', err.message);
//     learnedMap = {};
//     reverseIndex = {};
//   }
// }

// // ─── APPLY CORRECTION ─────────────────────────────────────

// function applyCorrection(query, currentResults = null) {
//   try {
//     const key = normalise(query);
//     const entry = learnedMap[key];

//     if (!entry) return { query, corrected: false };

//     // Layer 2 — confidence gate
//     if (entry.confidence < 0.8) {
//       console.log(`[Gate] "${key}" blocked — confidence ${entry.confidence}`);
//       return { query, corrected: false };
//     }

//     if (entry.onlyIfNoResults === true && currentResults > 0) {
//       return { query, corrected: false };
//     }

//     return {
//       query: normalise(entry.correction),
//       corrected: true,
//       original: query,
//       confidence: entry.confidence,
//       source: entry.source || 'manual'
//     };

//   } catch (err) {
//     console.error('learnedMap error:', err.message);
//     return { query, corrected: false };
//   }
// }

// // ─── PENALISE CORRECTION (Layer 2) ────────────────────────
// // bypasses cooldown intentionally
// // bad corrections must always be penalised immediately

// function penaliseCorrection(originalQuery) {
//   try {
//     const key = normalise(originalQuery);
//     if (!learnedMap[key]) return;

//     const entry = learnedMap[key];

//     entry.failures = (entry.failures || 0) + 1;
//     entry.confidence = parseFloat(
//       Math.max(0, entry.confidence - 0.1).toFixed(3)
//     );

//     console.log(`[Penalise] "${key}" → failures: ${entry.failures}, confidence: ${entry.confidence}`);

//     if (entry.confidence < 0.5) {
//       console.log(`[Remove] "${key}" deleted — confidence too low after ${entry.failures} failures`);
//       delete learnedMap[key];
//       removeFromReverseIndex(key);
//     }

//     saveMapToDisk();

//   } catch (err) {
//     console.error('penaliseCorrection error:', err.message);
//   }
// }

// // ─── REMOVE FROM REVERSE INDEX ────────────────────────────

// function removeFromReverseIndex(wrongWord) {
//   try {
//     for (const [correctWord, data] of Object.entries(reverseIndex)) {
//       const idx = data.variants.indexOf(wrongWord);
//       if (idx !== -1) {
//         data.variants.splice(idx, 1);
//         data.totalVariants = Math.max(0, data.totalVariants - 1);

//         if (data.variants.length === 0) {
//           delete reverseIndex[correctWord];
//         }

//         saveReverseIndex();
//         break;
//       }
//     }
//   } catch (err) {
//     console.error('removeFromReverseIndex error:', err.message);
//   }
// }

// // ─── SAVE MAP TO DISK ─────────────────────────────────────

// function saveMapToDisk() {
//   if (isWriting) return;
//   isWriting = true;

//   fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });

//   fs.writeFile(
//     MAP_FILE,
//     JSON.stringify(learnedMap, null, 2),
//     err => {
//       isWriting = false;
//       if (err) console.error('Failed to save learned map:', err.message);
//     }
//   );
// }

// // ─── UPDATE REVERSE INDEX ─────────────────────────────────

// function updateReverseIndex(wrongWord, correctWord, count, confidence, source) {
//   try {
//     const key = normalise(correctWord);
//     if (!key) return;

//     if (!reverseIndex[key]) {
//       reverseIndex[key] = {
//         variants: [],
//         totalVariants: 0,
//         totalCount: 0,
//         confidence: 0,
//         _weightedConfidenceSum: 0,
//         sources: []
//       };
//     }

//     const entry = reverseIndex[key];

//     if (!entry.variants.includes(wrongWord)) {
//       entry.variants.push(wrongWord);
//       entry.totalVariants++;
//     }

//     entry.totalCount += count;
//     entry._weightedConfidenceSum += confidence * count;
//     entry.confidence = parseFloat(
//       (entry._weightedConfidenceSum / entry.totalCount).toFixed(3)
//     );

//     if (source && !entry.sources.includes(source)) {
//       entry.sources.push(source);
//     }

//     entry.variants = entry.variants
//       .sort((a, b) => {
//         const countA = learnedMap[a]?.count || 0;
//         const countB = learnedMap[b]?.count || 0;
//         return countB - countA;
//       })
//       .slice(0, MAX_VARIANTS);

//     saveReverseIndex();

//   } catch (err) {
//     console.error('updateReverseIndex error:', err.message);
//   }
// }

// // ─── SAVE REVERSE INDEX ───────────────────────────────────

// function saveReverseIndex() {
//   if (isWritingIndex) return;
//   isWritingIndex = true;

//   fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });

//   const toSave = {};
//   for (const [k, v] of Object.entries(reverseIndex)) {
//     const { _weightedConfidenceSum, ...rest } = v;
//     toSave[k] = rest;
//   }

//   fs.writeFile(
//     INDEX_FILE,
//     JSON.stringify(toSave, null, 2),
//     err => {
//       isWritingIndex = false;
//       if (err) console.error('Failed to save reverse index:', err.message);
//     }
//   );
// }

// // ─── SAVE CORRECTION ──────────────────────────────────────

// function saveCorrection(originalQuery, correctedQuery, source = 'auto', resultsCount = 0, dominanceWeight = null) {
//   try {
//     // validation — skip if no signal
//     if (resultsCount === 0) {
//       console.warn(`saveCorrection skipped — no results for "${correctedQuery}"`);
//       return;
//     }

//     const key = normalise(originalQuery);
//     const corrected = normalise(correctedQuery);
//     if (!key || !corrected) return;

//     if (learnedMap[key]) {
//       const entry = learnedMap[key];

//       // Layer 4 — diminishing reinforcement
//       // real traffic still counts but rapid repeats get weaker boost
//       const now = Date.now();
//       const timeSinceUpdate = entry.lastUpdated
//         ? now - new Date(entry.lastUpdated).getTime()
//         : Infinity;

//       // cooldownFactor: 0.1 (immediate repeat) → 1.0 (after full cooldown)
//       const cooldownFactor = timeSinceUpdate === Infinity
//         ? 1.0
//         : Math.min(1.0, Math.max(0.1, timeSinceUpdate / COOLDOWN_MS));

//       if (cooldownFactor < 1.0) {
//         console.log(`[Cooldown] "${key}" reduced — factor: ${cooldownFactor.toFixed(2)} (${Math.round(timeSinceUpdate / 1000)}s ago)`);
//       }

//       entry.count += 1;

//       if (source === 'click') {
//         const boost = dominanceWeight !== null
//           ? dominanceWeight
//           : 0.05;
//         entry.confidence = parseFloat(
//           Math.min(0.95, entry.confidence + (boost * cooldownFactor)).toFixed(3)
//         );
//       } else {
//         entry.confidence = parseFloat(
//           Math.min(0.95, entry.confidence + ((1 / entry.count) * cooldownFactor)).toFixed(3)
//         );
//       }

//       // reset failures on success
//       entry.failures = 0;

//       // only update timestamp when full cooldown has passed
//       // prevents timestamp creep on rapid requests
//       if (cooldownFactor >= 1.0) {
//         entry.lastUpdated = new Date().toISOString();
//       }

//     } else {
//       // new entry — no cooldown needed
//       learnedMap[key] = {
//         correction: corrected,
//         confidence: source === 'click' ? 0.80 : 0.75,
//         count: 1,
//         failures: 0,
//         source,
//         lastUpdated: new Date().toISOString()
//       };
//     }

//     updateReverseIndex(
//       key,
//       corrected,
//       learnedMap[key].count,
//       learnedMap[key].confidence,
//       source
//     );

//     saveMapToDisk();

//   } catch (err) {
//     console.error('saveCorrection error:', err.message);
//   }
// }

// // ─── STATS ────────────────────────────────────────────────

// function getStats() {
//   const entries = Object.values(learnedMap);
//   return {
//     totalEntries: Object.keys(learnedMap).length,
//     manualEntries: entries.filter(e => e.source === 'manual').length,
//     autoEntries: entries.filter(e => e.source === 'auto').length,
//     clickEntries: entries.filter(e => e.source === 'click').length,
//     ollamaEntries: entries.filter(e => e.source === 'ollama').length,
//     blockedEntries: entries.filter(e => e.confidence < 0.8).length,
//     failedEntries: entries.filter(e => (e.failures || 0) > 0).length,
//     reverseIndexSize: Object.keys(reverseIndex).length
//   };
// }

// module.exports = {
//   loadMap,
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection,
//   getStats
// };
































// const fs = require('fs');
// const path = require('path');
// const { normalise } = require('../query/normalise');

// const MAP_FILE = path.join(__dirname, '../../learned/learnedMap.json');
// const INDEX_FILE = path.join(__dirname, '../../learned/reverseIndex.json');
// const MAX_VARIANTS = 20;

// // ─── WRITE LOCKS ──────────────────────────────────────────
// let isWriting = false;
// let isWritingIndex = false;

// // ─── IN MEMORY ────────────────────────────────────────────
// let learnedMap = {};
// let reverseIndex = {};

// // ─── LOAD MAP ─────────────────────────────────────────────

// function loadMap() {
//   try {
//     if (fs.existsSync(MAP_FILE)) {
//       const raw = fs.readFileSync(MAP_FILE, 'utf8');
//       learnedMap = JSON.parse(raw);
//       console.log(`Learned map loaded: ${Object.keys(learnedMap).length} entries`);
//     } else {
//       console.warn('learnedMap.json not found — starting empty');
//     }

//     if (fs.existsSync(INDEX_FILE)) {
//       const raw = fs.readFileSync(INDEX_FILE, 'utf8');
//       reverseIndex = JSON.parse(raw);
//       console.log(`Reverse index loaded: ${Object.keys(reverseIndex).length} correct words`);
//     } else {
//       console.warn('reverseIndex.json not found — starting empty');
//     }

//   } catch (err) {
//     console.error('Failed to load learned map:', err.message);
//     learnedMap = {};
//     reverseIndex = {};
//   }
// }

// // ─── APPLY CORRECTION ─────────────────────────────────────

// function applyCorrection(query, currentResults = null) {
//   try {
//     const key = normalise(query);
//     const entry = learnedMap[key];

//     if (!entry) return { query, corrected: false };

//     // Layer 2 — confidence gate
//     if (entry.confidence < 0.8) {
//       console.log(`[Gate] "${key}" blocked — confidence ${entry.confidence}`);
//       return { query, corrected: false };
//     }

//     if (entry.onlyIfNoResults === true && currentResults > 0) {
//       return { query, corrected: false };
//     }

//     return {
//       query: normalise(entry.correction),
//       corrected: true,
//       original: query,
//       confidence: entry.confidence,
//       source: entry.source || 'manual'
//     };

//   } catch (err) {
//     console.error('learnedMap error:', err.message);
//     return { query, corrected: false };
//   }
// }

// // ─── PENALISE CORRECTION (Layer 2) ────────────────────────

// function penaliseCorrection(originalQuery) {
//   try {
//     const key = normalise(originalQuery);
//     if (!learnedMap[key]) return;

//     const entry = learnedMap[key];

//     // increment failures
//     entry.failures = (entry.failures || 0) + 1;

//     // reduce confidence
//     entry.confidence = parseFloat(
//       Math.max(0, entry.confidence - 0.1).toFixed(3)
//     );

//     console.log(`[Penalise] "${key}" → failures: ${entry.failures}, confidence: ${entry.confidence}`);

//     // auto-delete if confidence too low
//     if (entry.confidence < 0.5) {
//       console.log(`[Remove] "${key}" deleted — confidence too low after ${entry.failures} failures`);
//       delete learnedMap[key];

//       // remove from reverse index too
//       removeFromReverseIndex(key);
//     }

//     // save updated map
//     saveMapToDisk();

//   } catch (err) {
//     console.error('penaliseCorrection error:', err.message);
//   }
// }

// // ─── REMOVE FROM REVERSE INDEX ────────────────────────────

// function removeFromReverseIndex(wrongWord) {
//   try {
//     for (const [correctWord, data] of Object.entries(reverseIndex)) {
//       const idx = data.variants.indexOf(wrongWord);
//       if (idx !== -1) {
//         data.variants.splice(idx, 1);
//         data.totalVariants = Math.max(0, data.totalVariants - 1);

//         // remove correct word entirely if no variants left
//         if (data.variants.length === 0) {
//           delete reverseIndex[correctWord];
//         }

//         saveReverseIndex();
//         break;
//       }
//     }
//   } catch (err) {
//     console.error('removeFromReverseIndex error:', err.message);
//   }
// }

// // ─── SAVE MAP TO DISK ─────────────────────────────────────

// function saveMapToDisk() {
//   if (isWriting) return;
//   isWriting = true;

//   fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });

//   fs.writeFile(
//     MAP_FILE,
//     JSON.stringify(learnedMap, null, 2),
//     err => {
//       isWriting = false;
//       if (err) console.error('Failed to save learned map:', err.message);
//     }
//   );
// }

// // ─── UPDATE REVERSE INDEX ─────────────────────────────────

// function updateReverseIndex(wrongWord, correctWord, count, confidence, source) {
//   try {
//     const key = normalise(correctWord);
//     if (!key) return;

//     if (!reverseIndex[key]) {
//       reverseIndex[key] = {
//         variants: [],
//         totalVariants: 0,
//         totalCount: 0,
//         confidence: 0,
//         _weightedConfidenceSum: 0,
//         sources: []
//       };
//     }

//     const entry = reverseIndex[key];

//     if (!entry.variants.includes(wrongWord)) {
//       entry.variants.push(wrongWord);
//       entry.totalVariants++;
//     }

//     entry.totalCount += count;
//     entry._weightedConfidenceSum += confidence * count;
//     entry.confidence = parseFloat(
//       (entry._weightedConfidenceSum / entry.totalCount).toFixed(3)
//     );

//     if (source && !entry.sources.includes(source)) {
//       entry.sources.push(source);
//     }

//     entry.variants = entry.variants
//       .sort((a, b) => {
//         const countA = learnedMap[a]?.count || 0;
//         const countB = learnedMap[b]?.count || 0;
//         return countB - countA;
//       })
//       .slice(0, MAX_VARIANTS);

//     saveReverseIndex();

//   } catch (err) {
//     console.error('updateReverseIndex error:', err.message);
//   }
// }

// // ─── SAVE REVERSE INDEX ───────────────────────────────────

// function saveReverseIndex() {
//   if (isWritingIndex) return;
//   isWritingIndex = true;

//   fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });

//   const toSave = {};
//   for (const [k, v] of Object.entries(reverseIndex)) {
//     const { _weightedConfidenceSum, ...rest } = v;
//     toSave[k] = rest;
//   }

//   fs.writeFile(
//     INDEX_FILE,
//     JSON.stringify(toSave, null, 2),
//     err => {
//       isWritingIndex = false;
//       if (err) console.error('Failed to save reverse index:', err.message);
//     }
//   );
// }

// // ─── SAVE CORRECTION ──────────────────────────────────────

// function saveCorrection(originalQuery, correctedQuery, source = 'auto', resultsCount = 0) {
//   try {
//     if (resultsCount === 0) {
//       console.warn(`saveCorrection skipped — no results for "${correctedQuery}"`);
//       return;
//     }

//     const key = normalise(originalQuery);
//     const corrected = normalise(correctedQuery);
//     if (!key || !corrected) return;

//     if (learnedMap[key]) {
//       const entry = learnedMap[key];
//       entry.count += 1;
//       entry.confidence = Math.min(
//         0.95,
//         entry.confidence + (1 / entry.count)
//       );
//       // reset failures on success
//       entry.failures = 0;
//     } else {
//       learnedMap[key] = {
//         correction: corrected,
//         confidence: 0.75,
//         count: 1,
//         failures: 0,
//         source
//       };
//     }

//     updateReverseIndex(
//       key,
//       corrected,
//       learnedMap[key].count,
//       learnedMap[key].confidence,
//       source
//     );

//     saveMapToDisk();

//   } catch (err) {
//     console.error('saveCorrection error:', err.message);
//   }
// }

// // ─── STATS ────────────────────────────────────────────────

// function getStats() {
//   const entries = Object.values(learnedMap);
//   return {
//     totalEntries: Object.keys(learnedMap).length,
//     manualEntries: entries.filter(e => e.source === 'manual').length,
//     autoEntries: entries.filter(e => e.source === 'auto').length,
//     ollamaEntries: entries.filter(e => e.source === 'ollama').length,
//     blockedEntries: entries.filter(e => e.confidence < 0.8).length,
//     failedEntries: entries.filter(e => (e.failures || 0) > 0).length,
//     reverseIndexSize: Object.keys(reverseIndex).length
//   };
// }

// module.exports = {
//   loadMap,
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection,
//   getStats
// };


























// const fs = require('fs');
// const path = require('path');
// const { normalise } = require('../query/normalise');

// const MAP_FILE = path.join(__dirname, '../../learned/learnedMap.json');
// const INDEX_FILE = path.join(__dirname, '../../learned/reverseIndex.json');
// const MAX_VARIANTS = 20;

// // ─── WRITE LOCK ───────────────────────────────────────────
// let isWriting = false;
// let isWritingIndex = false;

// // ─── IN MEMORY ────────────────────────────────────────────
// let learnedMap = {};
// let reverseIndex = {};

// // ─── LOAD MAP ─────────────────────────────────────────────

// function loadMap() {
//   try {
//     // load learned map
//     if (fs.existsSync(MAP_FILE)) {
//       const raw = fs.readFileSync(MAP_FILE, 'utf8');
//       learnedMap = JSON.parse(raw);
//       console.log(`Learned map loaded: ${Object.keys(learnedMap).length} entries`);
//     } else {
//       console.warn('learnedMap.json not found — starting empty');
//     }

//     // load reverse index
//     if (fs.existsSync(INDEX_FILE)) {
//       const raw = fs.readFileSync(INDEX_FILE, 'utf8');
//       reverseIndex = JSON.parse(raw);
//       console.log(`Reverse index loaded: ${Object.keys(reverseIndex).length} correct words`);
//     } else {
//       console.warn('reverseIndex.json not found — starting empty');
//     }

//   } catch (err) {
//     console.error('Failed to load learned map:', err.message);
//     learnedMap = {};
//     reverseIndex = {};
//   }
// }

// // ─── APPLY CORRECTION ─────────────────────────────────────

// function applyCorrection(query, currentResults = null) {
//   try {
//     const key = normalise(query);
//     const entry = learnedMap[key];

//     if (!entry) return { query, corrected: false };
//     if (entry.confidence < 0.8) return { query, corrected: false };
//     if (entry.onlyIfNoResults === true && currentResults > 0) {
//       return { query, corrected: false };
//     }

//     return {
//       query: normalise(entry.correction),
//       corrected: true,
//       original: query,
//       confidence: entry.confidence,
//       source: entry.source || 'manual'
//     };

//   } catch (err) {
//     console.error('learnedMap error:', err.message);
//     return { query, corrected: false };
//   }
// }

// // ─── UPDATE REVERSE INDEX ─────────────────────────────────

// function updateReverseIndex(wrongWord, correctWord, count, confidence, source) {
//   try {
//     const key = normalise(correctWord);
//     if (!key) return;

//     if (!reverseIndex[key]) {
//       reverseIndex[key] = {
//         variants: [],
//         totalVariants: 0,
//         totalCount: 0,
//         confidence: 0,
//         _weightedConfidenceSum: 0,
//         sources: []
//       };
//     }

//     const entry = reverseIndex[key];

//     // add variant if not already there
//     if (!entry.variants.includes(wrongWord)) {
//       entry.variants.push(wrongWord);
//       entry.totalVariants++;
//     }

//     // update counts and confidence
//     entry.totalCount += count;
//     entry._weightedConfidenceSum += confidence * count;
//     entry.confidence = parseFloat(
//       (entry._weightedConfidenceSum / entry.totalCount).toFixed(3)
//     );

//     // add source if not already there
//     if (source && !entry.sources.includes(source)) {
//       entry.sources.push(source);
//     }

//     // sort variants by count descending
//     entry.variants = entry.variants
//       .sort((a, b) => {
//         const countA = learnedMap[a]?.count || 0;
//         const countB = learnedMap[b]?.count || 0;
//         return countB - countA;
//       })
//       .slice(0, MAX_VARIANTS);

//     // save reverse index
//     saveReverseIndex();

//   } catch (err) {
//     console.error('updateReverseIndex error:', err.message);
//   }
// }

// // ─── SAVE REVERSE INDEX ───────────────────────────────────

// function saveReverseIndex() {
//   if (isWritingIndex) return;
//   isWritingIndex = true;

//   fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });

//   // remove internal field before saving
//   const toSave = {};
//   for (const [k, v] of Object.entries(reverseIndex)) {
//     const { _weightedConfidenceSum, ...rest } = v;
//     toSave[k] = rest;
//   }

//   fs.writeFile(
//     INDEX_FILE,
//     JSON.stringify(toSave, null, 2),
//     err => {
//       isWritingIndex = false;
//       if (err) console.error('Failed to save reverse index:', err.message);
//     }
//   );
// }

// // ─── SAVE CORRECTION ──────────────────────────────────────

// function saveCorrection(originalQuery, correctedQuery, source = 'auto', resultsCount = 0) {
//   try {
//     // validate — only save if correction produced results
//     if (resultsCount === 0) {
//       console.warn(`saveCorrection skipped — no results for "${correctedQuery}"`);
//       return;
//     }

//     const key = normalise(originalQuery);
//     const corrected = normalise(correctedQuery);
//     if (!key || !corrected) return;

//     if (learnedMap[key]) {
//       // update existing
//       const entry = learnedMap[key];
//       entry.count += 1;
//       entry.confidence = Math.min(
//         0.95,
//         entry.confidence + (1 / entry.count)
//       );
//     } else {
//       // add new entry
//       learnedMap[key] = {
//         correction: corrected,
//         confidence: 0.75,
//         count: 1,
//         source
//       };
//     }

//     // update reverse index
//     updateReverseIndex(
//       key,
//       corrected,
//       learnedMap[key].count,
//       learnedMap[key].confidence,
//       source
//     );

//     // save learned map with write lock
//     if (isWriting) return;
//     isWriting = true;

//     fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });

//     fs.writeFile(
//       MAP_FILE,
//       JSON.stringify(learnedMap, null, 2),
//       err => {
//         isWriting = false;
//         if (err) console.error('Failed to save learned map:', err.message);
//       }
//     );

//   } catch (err) {
//     console.error('saveCorrection error:', err.message);
//   }
// }

// // ─── STATS ────────────────────────────────────────────────

// function getStats() {
//   return {
//     totalEntries: Object.keys(learnedMap).length,
//     manualEntries: Object.values(learnedMap)
//       .filter(e => e.source === 'manual').length,
//     autoEntries: Object.values(learnedMap)
//       .filter(e => e.source === 'auto').length,
//     ollamaEntries: Object.values(learnedMap)
//       .filter(e => e.source === 'ollama').length,
//     reverseIndexSize: Object.keys(reverseIndex).length
//   };
// }

// module.exports = {
//   loadMap,
//   applyCorrection,
//   saveCorrection,
//   getStats
// };