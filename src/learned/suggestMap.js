// src/learned/suggestMap.js
// prefix completions only ✅
// separate from learnedMap (typo corrections) ✅
// simple prefix → completion with metadata ✅
// no confidence, no lifecycle, no pruning ✅

const fs   = require('fs');
const path = require('path');
const { normalise } = require('../query/normalise');

const SUGGEST_MAP_FILE = path.join(__dirname, '../../learned/suggestMap.json');

// ─── IN MEMORY ────────────────────────────────────────────
let suggestMap  = {};
let isWriting   = false;
let pendingSave = false;

// ─── LOAD ─────────────────────────────────────────────────

function loadMap() {
  try {
    if (fs.existsSync(SUGGEST_MAP_FILE)) {
      const raw  = fs.readFileSync(SUGGEST_MAP_FILE, 'utf8');
      suggestMap = JSON.parse(raw);
      console.log(`SuggestMap loaded: ${Object.keys(suggestMap).length} completions`);
    } else {
      // create file immediately on fresh install ✅
      // less operational confusion ✅
      console.warn('suggestMap.json not found — creating empty');
      suggestMap = {};
      saveToDisk();
    }
  } catch (err) {
    console.error('Failed to load suggestMap:', err.message);
    suggestMap = {};
  }
}

// ─── GET COMPLETION ───────────────────────────────────────
// returns completion string or null ✅
// used by runSuggest in queryRunner ✅

function getCompletion(prefix) {
  try {
    const key   = normalise(prefix);
    const entry = suggestMap[key];
    if (!entry) return null;
    return entry.completion || null;
  } catch {
    return null;
  }
}

// ─── ADD COMPLETION ───────────────────────────────────────
// used by enrichLearnedMap.js ✅
// normalise both key and value before storing ✅

function addCompletion(prefix, completion, source = 'csv') {
  try {
    const key   = normalise(prefix);
    const value = normalise(completion);

    // reject if either is empty after normalise ✅
    if (!key || !value) return false;

    suggestMap[key] = {
      completion: value,
      source,
      addedAt: new Date().toISOString()
    };

    saveToDisk();
    return true;
  } catch (err) {
    console.error('addCompletion error:', err.message);
    return false;
  }
}

// ─── SAVE TO DISK ─────────────────────────────────────────
// atomic write: tmp → rename ✅
// pendingSave ensures no update is silently dropped ✅

function saveToDisk() {
  // if write in progress → schedule another save ✅
  // guarantees every update eventually reaches disk ✅
  if (isWriting) {
    pendingSave = true;
    return;
  }

  isWriting = true;
  fs.mkdirSync(path.dirname(SUGGEST_MAP_FILE), { recursive: true });

  const tmpFile = SUGGEST_MAP_FILE + '.tmp';

  fs.writeFile(tmpFile, JSON.stringify(suggestMap, null, 2), err => {
    if (err) {
      isWriting = false;
      console.error('Failed to write suggestMap tmp:', err.message);
      return;
    }
    fs.rename(tmpFile, SUGGEST_MAP_FILE, err => {
      isWriting = false;
      if (err) {
        console.error('Failed to rename suggestMap:', err.message);
        return;
      }
      // flush any pending save ✅
      if (pendingSave) {
        pendingSave = false;
        saveToDisk();
      }
    });
  });
}

// ─── STATS ────────────────────────────────────────────────

function getStats() {
  const entries = Object.values(suggestMap);
  const sources = {};

  let oldestEntry = null;
  let newestEntry = null;

  for (const e of entries) {
    // source breakdown ✅
    sources[e.source] = (sources[e.source] || 0) + 1;

    // oldest + newest ✅
    if (e.addedAt) {
      if (!oldestEntry || e.addedAt < oldestEntry) oldestEntry = e.addedAt;
      if (!newestEntry || e.addedAt > newestEntry) newestEntry = e.addedAt;
    }
  }

  return {
    totalCompletions: Object.keys(suggestMap).length,
    sources,
    oldestEntry,    // when was suggestMap first seeded ✅
    newestEntry     // when was suggestMap last refreshed ✅
  };
}

module.exports = {
  loadMap,
  getCompletion,
  addCompletion,
  getStats
};