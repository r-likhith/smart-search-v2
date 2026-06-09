// src/spellcheck/phonetic.js
// Phonetic correction layer using Double Metaphone
// Layer 3 in correction pipeline:
// learnedMap → symspell → phonetic → Meilisearch fuzzy
//
// ONLY fires when symspell failed ✅
// Frequency-aware ranking ✅
// Catches sound-alike typos:
// "ifone" → "iphone" ✅
// "nokea" → "nokia" ✅
// "adidass" → "adidas" ✅
// "kurtaa" → "kurta" ✅
//
// Sources indexed:
// → dictionary.txt (25k words, freq-filtered)
// → productDict.txt (181 brand/product terms, boosted)
// → learnedMap correction targets (boosted)

const fs              = require('fs');
const path            = require('path');
const doubleMetaphone = require('double-metaphone');

// ─── CONFIG ───────────────────────────────────────────────
const MIN_WORD_LENGTH  = 4;      // skip short words
const MIN_CODE_LENGTH  = 2;      // skip very short phonetic codes
const MIN_FREQ         = 100;    // minimum frequency to index from dict
const PRODUCT_BOOST    = 999999; // product/learned words always win ✅
const MAX_LEN_DIFF     = 3;      // max length difference allowed

// ─── STATE ────────────────────────────────────────────────
let phoneticIndex = {};   // code → [{ word, freq }]
let wordSet       = new Set(); // fast lookup: is word correct?
let isReady       = false;
let totalIndexed  = 0;

// ─── INDEX WORD ───────────────────────────────────────────

function indexWord(word, freq) {
  try {
    const w = word.toLowerCase().trim();
    if (!w || w.length < MIN_WORD_LENGTH) return;
    if (!/^[a-z]+$/.test(w)) return;

    const codes = doubleMetaphone(w);
    for (const code of codes) {
      if (!code || code.length < MIN_CODE_LENGTH) continue;
      if (!phoneticIndex[code]) phoneticIndex[code] = [];

      const existing = phoneticIndex[code].find(e => e.word === w);
      if (existing) {
        // update freq if higher ✅
        if (freq > existing.freq) existing.freq = freq;
      } else {
        phoneticIndex[code].push({ word: w, freq });
        wordSet.add(w);
        totalIndexed++;
      }
    }
  } catch(e) {}
}

// ─── BUILD INDEX ──────────────────────────────────────────

function buildIndex() {
  phoneticIndex = {};
  wordSet       = new Set();
  isReady       = false;
  totalIndexed  = 0;

  // ── Source 1: main dictionary ──────────────────────────
  // use actual frequency for ranking ✅
  const dictFile = path.join(__dirname, '../../data/dictionary.txt');
  if (fs.existsSync(dictFile)) {
    const lines = fs.readFileSync(dictFile, 'utf8')
      .split('\n').filter(l => l.trim());
    for (const line of lines) {
      const parts = line.trim().split(' ');
      const word  = parts[0]?.toLowerCase();
      const freq  = parseInt(parts[1]) || 0;
      if (word && freq >= MIN_FREQ) {
        indexWord(word, freq);
      }
    }
  }

  // ── Source 2: product dictionary ──────────────────────
  // boosted to always beat common English words ✅
  // "nokia" (PRODUCT_BOOST) beats "neck" (50k) ✅
  const prodFile = path.join(__dirname, '../../data/productDict.txt');
  if (fs.existsSync(prodFile)) {
    const lines = fs.readFileSync(prodFile, 'utf8')
      .split('\n').filter(l => l.trim());
    for (const line of lines) {
      const word = line.trim().split(' ')[0]?.toLowerCase();
      if (word) indexWord(word, PRODUCT_BOOST);
    }
  }

  // ── Source 3: learnedMap correction targets ────────────
  // words we KNOW are correct → highest priority ✅
  const mapFile = path.join(__dirname, '../../learned/learnedMap.json');
  if (fs.existsSync(mapFile)) {
    try {
      const map     = JSON.parse(fs.readFileSync(mapFile));
      const targets = new Set(
        Object.values(map)
          .map(e => e.correction)
          .filter(Boolean)
      );
      for (const target of targets) {
        if (!target.includes(' ')) {
          indexWord(target, PRODUCT_BOOST);
        }
      }
    } catch(e) {}
  }

  isReady = true;
  console.log(`Phonetic index ready ✅ — ${totalIndexed} words indexed`);
}

// ─── CORRECT SINGLE WORD ──────────────────────────────────

function correctWord(word) {
  if (!isReady || !word) return null;

  const w = word.toLowerCase().trim();
  if (w.length < MIN_WORD_LENGTH) return null;
  if (!/^[a-z]+$/.test(w)) return null;

  // word already known correct → skip ✅
  if (wordSet.has(w)) return null;

  try {
    const codes = doubleMetaphone(w);
    let bestMatch = null;
    let bestScore = 0;

    for (const code of codes) {
      if (!code || code.length < MIN_CODE_LENGTH) continue;
      const candidates = phoneticIndex[code] || [];

      for (const candidate of candidates) {
        if (candidate.word === w) return null;

        // length sanity check ✅
        const lenDiff = Math.abs(candidate.word.length - w.length);
        if (lenDiff > MAX_LEN_DIFF) continue;

        // frequency is PRIMARY ranking ✅
        // length similarity is TIEBREAKER only ✅
        const lenBonus = (MAX_LEN_DIFF - lenDiff) * 10;
        const score    = candidate.freq + lenBonus;

        if (score > bestScore) {
          bestScore = score;
          bestMatch = candidate.word;
        }
      }
    }

    return bestMatch || null;

  } catch(e) {
    return null;
  }
}

// ─── CORRECT QUERY ────────────────────────────────────────
// only corrects words that symspell couldn't fix ✅

function correctQuery(query, { symspellResult = null } = {}) {
  if (!isReady || !query) return null;

  const words          = query.toLowerCase().trim().split(/\s+/);
  const correctedWords = [];
  const changes        = [];

  // get words symspell already fixed ✅
  // don't re-correct what symspell handled
  const symCorrectedWords = new Set();
  if (symspellResult?.changedWords) {
    for (const c of symspellResult.changedWords) {
      symCorrectedWords.add(c.original.toLowerCase());
    }
  }

  for (const word of words) {
    // skip if symspell already corrected this word ✅
    if (symCorrectedWords.has(word)) {
      correctedWords.push(word);
      continue;
    }

    const correction = correctWord(word);
    if (correction && correction !== word) {
      correctedWords.push(correction);
      changes.push({ original: word, correction });
      console.log(`[Phonetic] "${word}" → "${correction}"`);
    } else {
      correctedWords.push(word);
    }
  }

  if (changes.length === 0) return null;

  return {
    original:            query,
    corrected:           correctedWords.join(' '),
    changes,
    correctionsApplied:  changes.length
  };
}

// ─── STATUS ───────────────────────────────────────────────

function getStatus() {
  return {
    ready:     isReady,
    indexed:   totalIndexed,
    indexSize: Object.keys(phoneticIndex).length
  };
}

module.exports = { buildIndex, correctWord, correctQuery, getStatus };