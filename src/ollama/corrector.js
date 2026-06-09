const { callOllama } = require('./client');
const { normalise } = require('../query/normalise');

// ─── CONFIG ───────────────────────────────────────────────
const MIN_CORRECTION_LENGTH = 2;
const MAX_CORRECTION_LENGTH = 50;
const MAX_WORD_EXPANSION_RATIO = 2.5; // output words / input words

// ─── HALLUCINATION PATTERNS ───────────────────────────────
// Ollama sometimes returns these instead of a correction
// all must be rejected immediately

const HALLUCINATION_PATTERNS = [
  'input unchanged',
  'no correction',
  'no change',
  'unchanged',
  'same as input',
  'already correct',
  'cannot correct',
  'i cannot',
  'sorry',
  'n/a',
  'none',
  'null',
  'undefined'
];

// ─── CORRECT QUERY ────────────────────────────────────────

async function correctQuery(query) {
  try {
    const normalised = normalise(query);
    if (!normalised) return null;

    // reject gibberish input — repeated single character
    // "zzzzz" → "zz" after normalise → Ollama guesses "zip" ❌
    // "aaaaa" → "aa" → meaningless input
    if (/^(.)\1+$/.test(normalised)) {
      console.log(`[Corrector] Gibberish input — skipped: "${normalised}"`);
      return null;
    }

    // call Ollama
    const raw = await callOllama(normalised);
    if (!raw) return null;

    // clean response
    const correction = normalise(raw.trim().toLowerCase());
    if (!correction) return null;

    // must be different from original
    if (correction === normalised) {
      console.log(`[Corrector] Same as original — skipped: "${correction}"`);
      return null;
    }

    // length checks
    if (correction.length < MIN_CORRECTION_LENGTH) {
      console.log(`[Corrector] Too short — skipped: "${correction}"`);
      return null;
    }

    if (correction.length > MAX_CORRECTION_LENGTH) {
      console.log(`[Corrector] Too long — skipped: "${correction}"`);
      return null;
    }

    // reject numbers only
    if (/^\d+$/.test(correction)) {
      console.log(`[Corrector] Numbers only — skipped: "${correction}"`);
      return null;
    }

    // reject hallucinated output
    // only allow clean search terms: letters, numbers, spaces, hyphens
    if (!/^[a-z0-9\s\-]+$/.test(correction)) {
      console.log(`[Corrector] Invalid characters — skipped: "${correction}"`);
      return null;
    }

    // reject known hallucination phrases
    for (const pattern of HALLUCINATION_PATTERNS) {
      if (correction.includes(pattern)) {
        console.log(`[Corrector] Hallucination detected — skipped: "${correction}"`);
        return null;
      }
    }

    // ── word checks ───────────────────────────────────────

    const inputWords = normalised.split(/\s+/).filter(Boolean);
    const outputWords = correction.split(/\s+/).filter(Boolean);

    // single word input: correction must be similar length
    // prevents "penceel" → "pen", "corriamdder" → "commander"
    if (inputWords.length === 1 && outputWords.length === 1) {
      const ratio = correction.length / normalised.length;
      if (ratio < 0.6) {
        console.log(`[Corrector] Too short ratio (${ratio.toFixed(2)}) — skipped: "${normalised}" → "${correction}"`);
        return null;
      }
    }

    // multi-word: correction must not drop too many words
    // prevents "mik bowl" → "microwave"
    if (inputWords.length > 1 && outputWords.length < inputWords.length - 1) {
      console.log(`[Corrector] Word count dropped (${inputWords.length} → ${outputWords.length}) — skipped: "${normalised}" → "${correction}"`);
      return null;
    }

    // word expansion check
    // prevents "s23" → "samsung galaxy s23 ultra smartphone"
    const expansionRatio = outputWords.length / inputWords.length;
    if (expansionRatio > MAX_WORD_EXPANSION_RATIO) {
      console.log(`[Corrector] Too much expansion (${expansionRatio.toFixed(1)}x) — skipped: "${normalised}" → "${correction}"`);
      return null;
    }

    // short input expansion check
    // prevents "zz" → "zip", "zzz" → "zip"
    if (normalised.length < 4 && correction.length > normalised.length * 2) {
      console.log(`[Corrector] Short input expansion — skipped: "${normalised}" → "${correction}"`);
      return null;
    }

    console.log(`[Corrector] "${query}" → "${correction}"`);
    return correction;

  } catch (err) {
    console.error('correctQuery error:', err.message);
    return null;
  }
}

module.exports = { correctQuery };





































// const { callOllama } = require('./client');
// const { normalise } = require('../query/normalise');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_CORRECTION_LENGTH = 2;
// const MAX_CORRECTION_LENGTH = 50;
// const MAX_WORD_EXPANSION_RATIO = 2.5; // output words / input words

// // ─── HALLUCINATION PATTERNS ───────────────────────────────
// // Ollama sometimes returns these instead of a correction
// // all must be rejected immediately

// const HALLUCINATION_PATTERNS = [
//   'input unchanged',
//   'no correction',
//   'no change',
//   'unchanged',
//   'same as input',
//   'already correct',
//   'cannot correct',
//   'i cannot',
//   'sorry',
//   'n/a',
//   'none',
//   'null',
//   'undefined'
// ];

// // ─── CORRECT QUERY ────────────────────────────────────────

// async function correctQuery(query) {
//   try {
//     const normalised = normalise(query);
//     if (!normalised) return null;

//     // call Ollama
//     const raw = await callOllama(normalised);
//     if (!raw) return null;

//     // clean response
//     const correction = normalise(raw.trim().toLowerCase());
//     if (!correction) return null;

//     // must be different from original
//     if (correction === normalised) {
//       console.log(`[Corrector] Same as original — skipped: "${correction}"`);
//       return null;
//     }

//     // length checks
//     if (correction.length < MIN_CORRECTION_LENGTH) {
//       console.log(`[Corrector] Too short — skipped: "${correction}"`);
//       return null;
//     }

//     if (correction.length > MAX_CORRECTION_LENGTH) {
//       console.log(`[Corrector] Too long — skipped: "${correction}"`);
//       return null;
//     }

//     // reject numbers only
//     if (/^\d+$/.test(correction)) {
//       console.log(`[Corrector] Numbers only — skipped: "${correction}"`);
//       return null;
//     }

//     // reject hallucinated output
//     // only allow clean search terms: letters, numbers, spaces, hyphens
//     if (!/^[a-z0-9\s\-]+$/.test(correction)) {
//       console.log(`[Corrector] Invalid characters — skipped: "${correction}"`);
//       return null;
//     }

//     // reject known hallucination phrases
//     // "input unchanged", "no correction needed" etc
//     for (const pattern of HALLUCINATION_PATTERNS) {
//       if (correction.includes(pattern)) {
//         console.log(`[Corrector] Hallucination detected — skipped: "${correction}"`);
//         return null;
//       }
//     }

//     // ── word checks ───────────────────────────────────────

//     const inputWords = normalised.split(/\s+/).filter(Boolean);
//     const outputWords = correction.split(/\s+/).filter(Boolean);

//     // single word input: correction must be similar length
//     // prevents "penceel" → "pen", "corriamdder" → "commander"
//     if (inputWords.length === 1 && outputWords.length === 1) {
//       const ratio = correction.length / normalised.length;
//       if (ratio < 0.6) {
//         console.log(`[Corrector] Too short ratio (${ratio.toFixed(2)}) — skipped: "${normalised}" → "${correction}"`);
//         return null;
//       }
//     }

//     // multi-word: correction must not drop too many words
//     // prevents "mik bowl" → "microwave"
//     if (inputWords.length > 1 && outputWords.length < inputWords.length - 1) {
//       console.log(`[Corrector] Word count dropped (${inputWords.length} → ${outputWords.length}) — skipped: "${normalised}" → "${correction}"`);
//       return null;
//     }

//     // word expansion check
//     // prevents "s23" → "samsung galaxy s23 ultra smartphone"
//     // allows "blutoothspekr" → "bluetooth speaker" (1→2 words)
//     const expansionRatio = outputWords.length / inputWords.length;
//     if (expansionRatio > MAX_WORD_EXPANSION_RATIO) {
//       console.log(`[Corrector] Too much expansion (${expansionRatio.toFixed(1)}x) — skipped: "${normalised}" → "${correction}"`);
//       return null;
//     }

//     // single word input producing very different length output
//     // prevents "zz" → "zip" type hallucinations
//     // if input < 4 chars and output > input × 2 → reject
//     if (normalised.length < 4 && correction.length > normalised.length * 2) {
//       console.log(`[Corrector] Short input expansion — skipped: "${normalised}" → "${correction}"`);
//       return null;
//     }

//     console.log(`[Corrector] "${query}" → "${correction}"`);
//     return correction;

//   } catch (err) {
//     console.error('correctQuery error:', err.message);
//     return null;
//   }
// }

// module.exports = { correctQuery };
























// const { callOllama } = require('./client');
// const { normalise } = require('../query/normalise');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_CORRECTION_LENGTH = 2;
// const MAX_CORRECTION_LENGTH = 50;

// // ─── CORRECT QUERY ────────────────────────────────────────

// async function correctQuery(query) {
//   try {
//     const normalised = normalise(query);
//     if (!normalised) return null;

//     // call Ollama
//     const raw = await callOllama(normalised);
//     if (!raw) return null;

//     // clean response
//     const correction = normalise(raw.trim().toLowerCase());
//     if (!correction) return null;

//     // must be different from original
//     if (correction === normalised) {
//       console.log(`[Corrector] Same as original — skipped: "${correction}"`);
//       return null;
//     }

//     // length checks
//     if (correction.length < MIN_CORRECTION_LENGTH) {
//       console.log(`[Corrector] Too short — skipped: "${correction}"`);
//       return null;
//     }

//     if (correction.length > MAX_CORRECTION_LENGTH) {
//       console.log(`[Corrector] Too long — skipped: "${correction}"`);
//       return null;
//     }

//     // reject numbers only
//     if (/^\d+$/.test(correction)) {
//       console.log(`[Corrector] Numbers only — skipped: "${correction}"`);
//       return null;
//     }

//     // reject hallucinated output
//     // only allow clean search terms: letters, numbers, spaces, hyphens
//     if (!/^[a-z0-9\s\-]+$/.test(correction)) {
//       console.log(`[Corrector] Invalid characters — skipped: "${correction}"`);
//       return null;
//     }

//     // ── word similarity checks ────────────────────────────

//     const inputWords = normalised.split(' ');
//     const outputWords = correction.split(' ');

//     // single word: correction must be similar length to input
//     // prevents "penceel" → "pen", "corriamdder" → "commander"
//     if (inputWords.length === 1 && outputWords.length === 1) {
//       const ratio = correction.length / normalised.length;
//       if (ratio < 0.6) {
//         console.log(`[Corrector] Too short ratio (${ratio.toFixed(2)}) — skipped: "${normalised}" → "${correction}"`);
//         return null;
//       }
//     }

//     // multi-word: correction must not drop too many words
//     // prevents "mik bowl" → "microwave" (2 words → 1 word)
//     if (inputWords.length > 1 && outputWords.length < inputWords.length - 1) {
//       console.log(`[Corrector] Word count dropped (${inputWords.length} → ${outputWords.length}) — skipped: "${normalised}" → "${correction}"`);
//       return null;
//     }

//     console.log(`[Corrector] "${query}" → "${correction}"`);
//     return correction;

//   } catch (err) {
//     console.error('correctQuery error:', err.message);
//     return null;
//   }
// }

// module.exports = { correctQuery };



















// const { callOllama } = require('./client');
// const { normalise } = require('../query/normalise');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_CORRECTION_LENGTH = 2;
// const MAX_CORRECTION_LENGTH = 50;

// // ─── CORRECT QUERY ────────────────────────────────────────

// async function correctQuery(query) {
//   try {
//     const normalised = normalise(query);
//     if (!normalised) return null;

//     // call Ollama
//     const raw = await callOllama(normalised);
//     if (!raw) return null;

//     // clean response
//     const correction = normalise(raw.trim().toLowerCase());
//     if (!correction) return null;

//     // must be different from original
//     if (correction === normalised) {
//       console.log(`[Corrector] Same as original — skipped: "${correction}"`);
//       return null;
//     }

//     // length checks
//     if (correction.length < MIN_CORRECTION_LENGTH) {
//       console.log(`[Corrector] Too short — skipped: "${correction}"`);
//       return null;
//     }

//     if (correction.length > MAX_CORRECTION_LENGTH) {
//       console.log(`[Corrector] Too long — skipped: "${correction}"`);
//       return null;
//     }

//     // reject numbers only
//     if (/^\d+$/.test(correction)) {
//       console.log(`[Corrector] Numbers only — skipped: "${correction}"`);
//       return null;
//     }

//     // reject hallucinated output
//     // only allow clean search terms: letters, numbers, spaces, hyphens
//     if (!/^[a-z0-9\s\-]+$/.test(correction)) {
//       console.log(`[Corrector] Invalid characters — skipped: "${correction}"`);
//       return null;
//     }

//     console.log(`[Corrector] "${query}" → "${correction}"`);
//     return correction;

//   } catch (err) {
//     console.error('correctQuery error:', err.message);
//     return null;
//   }
// }

// module.exports = { correctQuery };