// offlineLearner/learnedMapWriter.js
// saves validated corrections to learnedMap ✅
// saves as candidate status ✅
// validation evidence attached ✅
// lastUsed: null until actually used ✅
// atomic write: tmp → rename ✅
// fresh reload before save prevents lost writes ✅

const fs   = require('fs');
const path = require('path');
const { normalise } = require('../src/query/normalise');
const { PATHS, THRESHOLDS, STATUS, GROQ } = require('./config');

// ─── LOAD MAP ─────────────────────────────────────────────

function loadMap() {
  try {
    if (!fs.existsSync(PATHS.learnedMap)) return {};
    return JSON.parse(fs.readFileSync(PATHS.learnedMap, 'utf8'));
  } catch {
    return {};
  }
}

// ─── LOAD INDEX ───────────────────────────────────────────

function loadIndex() {
  try {
    if (!fs.existsSync(PATHS.reverseIndex)) return {};
    return JSON.parse(fs.readFileSync(PATHS.reverseIndex, 'utf8'));
  } catch {
    return {};
  }
}

// ─── SAVE MAP ─────────────────────────────────────────────
// atomic write: tmp → rename ✅
// prevents corrupt reads if server reads mid-write ✅

function saveMap(map) {
  const tmp = PATHS.learnedMap + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, PATHS.learnedMap);
}

// ─── SAVE INDEX ───────────────────────────────────────────
// atomic write: tmp → rename ✅

function saveIndex(index) {
  const tmp = PATHS.reverseIndex + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, PATHS.reverseIndex);
}

// ─── UPDATE REVERSE INDEX ────────────────────────────────

function updateReverseIndex(wrongWord, correctWord, index) {
  const key = normalise(correctWord);
  if (!key) return;

  if (!index[key]) {
    index[key] = {
      variants:      [],
      totalVariants: 0,
      totalCount:    0,
      confidence:    0,
      sources:       []
    };
  }

  const entry = index[key];

  if (!entry.variants.includes(wrongWord)) {
    entry.variants.push(wrongWord);
    entry.totalVariants++;
  }

  entry.totalCount++;

  if (!entry.sources.includes('groq')) {
    entry.sources.push('groq');
  }
}

// ─── WRITE CORRECTION ────────────────────────────────────

function writeCorrection(validated) {
  // initial load to check duplicates + chains ✅
  const map   = loadMap();
  const index = loadIndex();
  const now   = new Date().toISOString();

  const saved   = [];
  const skipped = [];

  for (const item of validated) {
    const key        = normalise(item.query);
    const correction = normalise(item.correction);

    if (!key || !correction) {
      skipped.push({ query: item.query, reason: 'normalise_failed' });
      continue;
    }

    // skip if already exists ✅
    // log conflict if Groq suggests different correction ✅
    if (map[key]) {
      const existing = map[key].correction;
      if (existing !== correction) {
        console.warn(`[Writer] ⚠️  Conflict: "${key}" existing="${existing}" candidate="${correction}" source=groq`);
        skipped.push({
          query:     key,
          reason:    'conflict',
          existing,
          candidate: correction
        });
      } else {
        console.log(`[Writer] Already exists — skipped: "${key}"`);
        skipped.push({ query: key, reason: 'already_exists' });
      }
      continue;
    }

    // chain detection ✅
    // correction must not itself be a known typo ✅
    if (map[correction]) {
      const chain = map[correction];
      if (chain.correction && chain.correction !== correction) {
        console.log(`[Writer] Chain detected — skipped: "${key}" → "${correction}" → "${chain.correction}"`);
        skipped.push({ query: key, reason: 'chain_detected' });
        continue;
      }
    }

    // save as candidate ✅
    // lastUsed: null = never used yet ✅
    // promoted to trusted after hitCount >= 5 ✅
    map[key] = {
      correction,
      confidence:  THRESHOLDS.groqConfidence,
      hitCount:    0,
      failures:    0,
      source:      'groq',
      model:       GROQ.model,        // which model suggested ✅
      learnedBy:   'offlineLearner',  // audit trail ✅
      status:      STATUS.CANDIDATE,  // candidate until users validate ✅
      scope:       item.scope,        // electronics/fashion/grocery/global ✅
      learnedFrom: item.clients?.[0] || null,
      firstSeen:   now,
      lastUsed:    null,              // null = never applied yet ✅
      lastUpdated: now,
      // validation evidence stays attached ✅
      // "why did we trust this?" ✅
      validation: {
        clientCount: item.clientCount || 0,
        bestHits:    item.bestHits    || 0,
        scope:       item.scope       || null
      }
    };

    updateReverseIndex(key, correction, index);

    console.log(`[Writer] ✅ Saved: "${key}" → "${correction}" (${item.scope}, candidate)`);
    saved.push({
      query:      key,
      correction,
      scope:      item.scope,
      confidence: THRESHOLDS.groqConfidence,
      status:     STATUS.CANDIDATE,
      model:      GROQ.model
    });
  }

  // ── persist to disk ───────────────────────────────────
  if (saved.length > 0) {
    // reload fresh before saving ✅
    // prevents overwriting corrections made by
    // live server during our processing run ✅
    const freshMap   = loadMap();
    const freshIndex = loadIndex();

    // merge only our new entries into fresh state ✅
    // existing entries from live server preserved ✅
    for (const item of saved) {
      if (!freshMap[item.query]) {
        freshMap[item.query] = map[item.query];
      }
    }
    for (const item of saved) {
      updateReverseIndex(item.query, item.correction, freshIndex);
    }

    saveMap(freshMap);
    saveIndex(freshIndex);
    console.log(`\n[Writer] Saved ${saved.length} corrections to learnedMap ✅`);
  } else {
    console.log(`\n[Writer] Nothing new to save`);
  }

  return { saved, skipped };
}

module.exports = { writeCorrection };