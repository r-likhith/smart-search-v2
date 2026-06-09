const SymSpell = require('node-symspell');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────
const DICTIONARY_FILE    = path.join(__dirname, '../../data/dictionary.txt');
const PHRASES_FILE       = path.join(__dirname, '../../data/dictionary_phrases.txt');
const PRODUCT_DICT_FILE  = path.join(__dirname, '../../data/productDict.txt');
const MAX_EDIT_DISTANCE = 2;
const PREFIX_LENGTH = 7;

// safety thresholds
const MAX_DISTANCE_RATIO = 0.4;      // prevents "cap" → "car"
const MIN_FREQ_FOR_DIST2 = 50;       // dist=2 only if word common enough
const MIN_WORD_LENGTH = 5;           // skip words shorter than this
const MAX_CORRECTIONS_PER_QUERY = 2; // reject heavily mangled queries

let symspell = null;
let isReady = false;

// ─── INIT ─────────────────────────────────────────────────

async function initSymSpell() {
  try {
    symspell = new SymSpell(MAX_EDIT_DISTANCE, PREFIX_LENGTH);

    // ── load main dictionary ───────────────────────────
    const dictContent = fs.readFileSync(DICTIONARY_FILE, 'utf8');
    const lines = dictContent.split('\n').filter(l => l.trim());

    let loaded = 0;
    for (const line of lines) {
      const parts = line.trim().split(' ');
      if (parts.length >= 2) {
        const word = parts[0].toLowerCase();
        const freq = parseInt(parts[1]) || 1;
        symspell.createDictionaryEntry(word, freq);
        loaded++;
      }
    }
    console.log(`SymSpell ready ✅ — ${loaded} words loaded`);

    // ── load phrase dictionary ─────────────────────────
    // 120k Indian product phrases ✅
    if (fs.existsSync(PHRASES_FILE)) {
      const phrases = fs.readFileSync(PHRASES_FILE, 'utf8');
      const phraseLines = phrases.split('\n').filter(l => l.trim());
      let phraseCount = 0;
      for (const line of phraseLines) {
        const phrase = line.trim().toLowerCase();
        if (phrase && phrase.length >= 3) {
          symspell.createDictionaryEntry(phrase, 10000);
          phraseCount++;
        }
      }
      console.log(`SymSpell phrases loaded ✅ — ${phraseCount} phrases`);
    } else {
      console.log('ℹ️  No phrases file found');
    }

    // ── load product dictionary ────────────────────────
    // brand names, product terms, domain vocab ✅
    // built by scripts/buildProductDict.js ✅
    if (fs.existsSync(PRODUCT_DICT_FILE)) {
      const prodDict = fs.readFileSync(PRODUCT_DICT_FILE, 'utf8');
      const prodLines = prodDict.split('\n').filter(l => l.trim());
      let prodCount = 0;
      for (const line of prodLines) {
        const parts = line.trim().split(' ');
        const word = parts[0].toLowerCase();
        const freq = parseInt(parts[1]) || 5000;
        if (word && word.length >= 3) {
          symspell.createDictionaryEntry(word, freq);
          prodCount++;
        }
      }
      console.log(`SymSpell product dict loaded ✅ — ${prodCount} entries`);
    } else {
      console.log('ℹ️  No product dict yet — run scripts/buildProductDict.js');
    }

    isReady = true;
    return true;

  } catch (err) {
    console.error('SymSpell init failed:', err.message);
    isReady = false;
    return false;
  }
}

// ─── SHOULD SKIP WORD ─────────────────────────────────────

function shouldSkip(word) {
  // skip short words — too risky to auto-correct
  // "cap", "bag", "pan" are valid products
  // one edit changes meaning completely
  // learnedMap + Meilisearch fuzzy handles these
  if (word.length < MIN_WORD_LENGTH) return true;

  // skip pure numbers
  if (/^\d+$/.test(word)) return true;

  // skip model numbers e.g. s23ultra, realme9pro
  if (/^[a-z]+\d+[a-z\d]*$/i.test(word)) return true;
  if (/^\d+[a-z]+[a-z\d]*$/i.test(word)) return true;

  // skip SKU-like words e.g. abc123
  if (/^[a-z]{1,3}\d{2,}$/i.test(word)) return true;

  return false;
}

// ─── CORRECT SINGLE WORD ──────────────────────────────────

function correctWord(word) {
  if (!isReady || !symspell) return null;
  if (!word) return null;
  if (shouldSkip(word)) return null;

  const lower = word.toLowerCase();

  // fast path — word already in dictionary
  // no correction needed → skip lookup entirely
  // avoids unnecessary lookup + accidental corrections
  if (symspell.words.has(lower)) return null;

  try {
    const suggestions = symspell.lookup(
      lower,
      0,                   // Verbosity.TOP = 0 → best match only
      MAX_EDIT_DISTANCE
    );

    if (!suggestions || suggestions.length === 0) return null;

    const best = suggestions[0];

    // same word → no correction needed
    if (best.term === lower) return null;

    // edit distance 0 → already correct
    if (best.distance === 0) return null;

    // distance ratio safety
    // prevents semantic drift on borderline words
    const ratio = best.distance / lower.length;
    if (ratio > MAX_DISTANCE_RATIO) {
      console.log(`[SymSpell] Ratio too high (${ratio.toFixed(2)}) — skipped: "${word}" → "${best.term}"`);
      return null;
    }

    // confidence threshold
    // distance 2 only if word is common enough
    if (best.distance === 2 && best.count < MIN_FREQ_FOR_DIST2) {
      console.log(`[SymSpell] Low confidence (dist:2, freq:${best.count}) — skipped: "${word}" → "${best.term}"`);
      return null;
    }

    return {
      original: word,
      correction: best.term,
      distance: best.distance,
      frequency: best.count,
      ratio
    };

  } catch (err) {
    return null;
  }
}

// ─── CORRECT QUERY ────────────────────────────────────────

function correctQuery(query) {
  if (!isReady || !symspell) return null;
  if (!query) return null;

  try {
    const words = query.toLowerCase().trim().split(/\s+/);
    const correctedWords = [];
    const changedWords = [];
    let correctionsApplied = 0;

    for (const word of words) {
      if (shouldSkip(word)) {
        correctedWords.push(word);
        continue;
      }

      const result = correctWord(word);

      if (result) {
        correctedWords.push(result.correction);
        changedWords.push({
          original: result.original,
          correction: result.correction,
          distance: result.distance,
          frequency: result.frequency
        });
        correctionsApplied++;
        console.log(`[SymSpell] "${word}" → "${result.correction}" (dist:${result.distance}, freq:${result.frequency.toLocaleString()})`);
      } else {
        correctedWords.push(word);
      }
    }

    // no corrections made → return null
    if (correctionsApplied === 0) return null;

    // reject heavily mangled queries
    // too many corrections = semantic drift risk
    // "completely mangled query" → 4 corrections → dangerous
    if (correctionsApplied > MAX_CORRECTIONS_PER_QUERY) {
      console.log(`[SymSpell] Too many corrections (${correctionsApplied}) — rejected query: "${query}"`);
      return null;
    }

    return {
      original: query,
      corrected: correctedWords.join(' '),
      changedWords,
      correctionsApplied
    };

  } catch (err) {
    console.error('SymSpell correctQuery error:', err.message);
    return null;
  }
}

// ─── STATUS ───────────────────────────────────────────────

function getStatus() {
  return {
    ready: isReady,
    maxEditDistance: MAX_EDIT_DISTANCE,
    prefixLength: PREFIX_LENGTH,
    maxDistanceRatio: MAX_DISTANCE_RATIO,
    minFreqForDist2: MIN_FREQ_FOR_DIST2,
    minWordLength: MIN_WORD_LENGTH,
    maxCorrectionsPerQuery: MAX_CORRECTIONS_PER_QUERY
  };
}

module.exports = { initSymSpell, correctWord, correctQuery, getStatus, shouldSkip };