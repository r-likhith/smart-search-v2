// src/spellcheck/phonetic.js
// Phonetic correction layer using Double Metaphone
// Layer 3 in correction pipeline:
// learnedMap → symspell → phonetic → Meilisearch fuzzy
//
// Architecture: propose → rank → validate → winner ✅
// Same pattern as learnedMap, Groq, SymSpell ✅
//
// Stage 1: getCandidates() — phonetic code lookup ✅
// Stage 2: rankCandidates() — edit + prefix + suffix + freq ✅
// Stage 3: validation in tryPhoneticCorrection() ✅
//
// Catches sound-alike typos:
// "nikee"   → "nike"    ✅ (edit dist 1 beats nokia dist 3)
// "nokea"   → "nokia"   ✅
// "adidass" → "adidas"  ✅
// "kurtaa"  → "kurta"   ✅
// "speker"  → "speaker" ✅ (suffix similarity helps)
// "bluetoth"→ "bluetooth" ✅

const fs              = require('fs');
const path            = require('path');
const doubleMetaphone = require('double-metaphone');

// ─── CONFIG ───────────────────────────────────────────────
const MIN_WORD_LENGTH      = 4;
const MIN_CODE_LENGTH      = 2;
const MIN_FREQ             = 100;
const PRODUCT_BOOST        = 999999;
const MAX_LEN_DIFF         = 3;
const MAX_CANDIDATES       = 5;
const MIN_CONFIDENCE       = 0.50;  // skip low confidence corrections ✅

// ─── RANKING WEIGHTS ──────────────────────────────────────
// all signals normalized 0→1 ✅
// must sum to 1.0 ✅
const W_EDIT_DIST = 0.40;
const W_FREQ      = 0.25;
const W_PREFIX    = 0.15;
const W_SUFFIX    = 0.10;
const W_LENGTH    = 0.10;

// ─── STATE ────────────────────────────────────────────────
let phoneticIndex = {};
let wordSet       = new Set();
let isReady       = false;
let totalIndexed  = 0;

// ─── EDIT DISTANCE (Levenshtein) ──────────────────────────

function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i || j)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ─── SHARED PREFIX LENGTH ─────────────────────────────────

function sharedPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ─── SHARED SUFFIX LENGTH ─────────────────────────────────
// catches "speker" → "speaker" ✅
// catches "bluetoth" → "bluetooth" ✅

function sharedSuffixLength(a, b) {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) i++;
  return i;
}

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

  // Source 1: main dictionary ✅
  const dictFile = path.join(__dirname, '../../data/dictionary.txt');
  if (fs.existsSync(dictFile)) {
    const lines = fs.readFileSync(dictFile, 'utf8')
      .split('\n').filter(l => l.trim());
    for (const line of lines) {
      const parts = line.trim().split(' ');
      const word  = parts[0]?.toLowerCase();
      const freq  = parseInt(parts[1]) || 0;
      if (word && freq >= MIN_FREQ) indexWord(word, freq);
    }
  }

  // Source 2: product dictionary — boosted ✅
  const prodFile = path.join(__dirname, '../../data/productDict.txt');
  if (fs.existsSync(prodFile)) {
    const lines = fs.readFileSync(prodFile, 'utf8')
      .split('\n').filter(l => l.trim());
    for (const line of lines) {
      const word = line.trim().split(' ')[0]?.toLowerCase();
      if (word) indexWord(word, PRODUCT_BOOST);
    }
  }

  // Source 3: learnedMap correction targets — highest priority ✅
  const mapFile = path.join(__dirname, '../../learned/learnedMap.json');
  if (fs.existsSync(mapFile)) {
    try {
      const map     = JSON.parse(fs.readFileSync(mapFile));
      const targets = new Set(
        Object.values(map).map(e => e.correction).filter(Boolean)
      );
      for (const target of targets) {
        if (!target.includes(' ')) indexWord(target, PRODUCT_BOOST);
      }
    } catch(e) {}
  }

  isReady = true;
  console.log(`Phonetic index ready ✅ — ${totalIndexed} words indexed`);
}

// ─── STAGE 1: GET CANDIDATES ──────────────────────────────
// returns all phonetically similar words ✅
// no ranking yet — just candidates ✅

function getCandidates(word) {
  if (!isReady || !word) return [];

  const w = word.toLowerCase().trim();
  if (w.length < MIN_WORD_LENGTH) return [];
  if (!/^[a-z]+$/.test(w)) return [];

  // word already correct → no candidates ✅
  if (wordSet.has(w)) return [];

  try {
    const codes      = doubleMetaphone(w);
    const seen       = new Set();
    const candidates = [];

    for (const code of codes) {
      if (!code || code.length < MIN_CODE_LENGTH) continue;
      const entries = phoneticIndex[code] || [];

      for (const entry of entries) {
        // exact match in index → word is already correct ✅
        if (entry.word === w) return [];
        if (seen.has(entry.word)) continue;

        const lenDiff = Math.abs(entry.word.length - w.length);
        if (lenDiff > MAX_LEN_DIFF) continue;

        seen.add(entry.word);
        candidates.push({ word: entry.word, freq: entry.freq });
      }
    }

    return candidates;

  } catch(e) {
    return [];
  }
}

// ─── STAGE 2: RANK CANDIDATES ─────────────────────────────
// multi-signal ranking ✅
// edit distance: primary signal (40%) ✅
// frequency:     brand/product boost (25%) ✅
// prefix match:  strong positional signal (15%) ✅
// suffix match:  catches ending typos (10%) ✅
// length:        tiebreaker (10%) ✅
// all signals normalized 0→1 ✅

function rankCandidates(query, candidates) {
  if (!candidates.length) return [];

  const maxFreq = Math.max(...candidates.map(c => c.freq), 1);
  const maxLen  = query.length;

  const scored = candidates.map(c => {
    const dist    = editDistance(query, c.word);
    const prefix  = sharedPrefixLength(query, c.word);
    const suffix  = sharedSuffixLength(query, c.word);
    const lenDiff = Math.abs(c.word.length - query.length);

    // normalize each signal 0→1 ✅
    const editScore   = Math.max(0, 1 - dist / (query.length + 1));
    const freqScore   = c.freq / maxFreq;
    const prefixScore = maxLen > 0 ? prefix / maxLen : 0;
    const suffixScore = maxLen > 0 ? suffix / maxLen : 0;
    const lenScore    = Math.max(0, 1 - lenDiff / (MAX_LEN_DIFF + 1));

    const total =
      editScore   * W_EDIT_DIST +
      freqScore   * W_FREQ      +
      prefixScore * W_PREFIX    +
      suffixScore * W_SUFFIX    +
      lenScore    * W_LENGTH;

    return {
      word:        c.word,
      score:       parseFloat(total.toFixed(4)),
      editDist:    dist,
      prefixLen:   prefix,
      suffixLen:   suffix,
      freq:        c.freq
    };
  });

  // sort by score descending ✅
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

// ─── CORRECT SINGLE WORD ──────────────────────────────────
// stage 1 + 2 combined ✅
// returns best candidate word or null ✅

function correctWord(word) {
  const candidates = getCandidates(word);
  if (!candidates.length) return null;

  const ranked = rankCandidates(word, candidates);
  if (!ranked.length) return null;

  // respect confidence threshold ✅
  // low confidence = phonetics too uncertain → skip ✅
  if (ranked[0].score < MIN_CONFIDENCE) return null;

  return ranked[0].word;
}

// ─── GET TOP CANDIDATES FOR WORD ──────────────────────────
// exposed for tryPhoneticCorrection in queryRunner ✅
// returns ranked list so caller can validate each against Meili ✅

function getTopCandidates(word, topN = 3) {
  const candidates = getCandidates(word);
  if (!candidates.length) return [];
  return rankCandidates(word, candidates).slice(0, topN);
}

// ─── CORRECT QUERY ────────────────────────────────────────
// corrects words symspell couldn't fix ✅
// uses best candidate per word ✅
// exposes confidence + candidates for caller ✅

function correctQuery(query, { symspellResult = null } = {}) {
  if (!isReady || !query) return null;

  const words          = query.toLowerCase().trim().split(/\s+/);
  const correctedWords = [];
  const changes        = [];
  let   minConfidence  = 1.0;

  // skip words symspell already fixed ✅
  const symCorrectedWords = new Set();
  if (symspellResult?.changedWords) {
    for (const c of symspellResult.changedWords) {
      symCorrectedWords.add(c.original.toLowerCase());
    }
  }

  for (const word of words) {
    if (symCorrectedWords.has(word)) {
      correctedWords.push(word);
      continue;
    }

    const candidates = getCandidates(word);
    if (!candidates.length) {
      correctedWords.push(word);
      continue;
    }

    const ranked = rankCandidates(word, candidates);
    if (!ranked.length || ranked[0].score < MIN_CONFIDENCE) {
      correctedWords.push(word);
      continue;
    }

    const best = ranked[0];
    correctedWords.push(best.word);
    changes.push({
      original:   word,
      correction: best.word,
      confidence: best.score
    });
    minConfidence = Math.min(minConfidence, best.score);
    console.log(`[Phonetic] "${word}" → "${best.word}" (score: ${best.score})`);
  }

  if (changes.length === 0) return null;

  return {
    original:           query,
    corrected:          correctedWords.join(' '),
    changes,
    correctionsApplied: changes.length,
    confidence:         parseFloat(minConfidence.toFixed(4)), // ← new ✅
    candidates:         changes.map(c => c.correction)        // ← new ✅
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

module.exports = {
  buildIndex,
  correctWord,
  correctQuery,
  getTopCandidates,
  getStatus
};