const fetch = require('node-fetch');
const {
  canRequest,
  acquire,
  release,
  recordSkip,
  recordTimeout,
  TIMEOUT_MS
} = require('./budgetManager');
const cache = require('./cache');
const { normalise } = require('../query/normalise');

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'llama3:latest';

// Object.create(null) — no prototype pollution
const pending = Object.create(null);

// ─── HALLUCINATION PATTERNS ───────────────────────────────
// catch bad Ollama output before caching

const HALLUCINATION_PATTERNS = [
  'input unchanged',
  'no correction',
  'no change',
  'unchanged',
  'already correct',
  'cannot correct',
  'i cannot',
  'sorry',
  'n/a',
  'none',
  'null',
  'undefined',
  'fix typos'    // model echoing the prompt
];

// ─── VALIDATE CORRECTION ─────────────────────────────────

function isValidCorrection(input, output) {
  if (!output) return false;
  if (output.length < 2) return false;
  if (output.length > 100) return false;
  if (output.includes('\n')) return false;
  if (output === input) return false;
  if (/^\d+$/.test(output)) return false;

  // reject hallucination phrases
  for (const pattern of HALLUCINATION_PATTERNS) {
    if (output.includes(pattern)) {
      console.log(`[Ollama] Hallucination filtered: "${output}"`);
      return false;
    }
  }

  // reject if output contains the prompt text
  if (output.includes('fix typos:') || output.includes('spell check')) {
    console.log(`[Ollama] Prompt echo filtered: "${output}"`);
    return false;
  }

  return true;
}

// ─── CALL WITH TIMEOUT ────────────────────────────────────

async function callWithTimeout(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        system: `You are a spell checker for an Indian ecommerce search engine.
The store sells: clothing, footwear, electronics, mobiles, laptops, appliances,
furniture, home decor, kitchen, groceries, beauty, health, sports, toys, books,
stationery, accessories, bags and jewellery.

Rules:
1. Output ONLY the corrected search term — nothing else
2. Lowercase only, no punctuation, no explanations
3. Fix spelling typos only — do not change the meaning
4. Corrected word must be similar in length to the original
5. Do not shorten words drastically (pencil not pen)
6. If the input has multiple words, keep a similar word count
7. If you cannot correct it, output nothing at all`,
        prompt: `Fix typos: ${query}`,
        stream: false
      }),
      signal: controller.signal
    });

    const data = await response.json();
    return data.response ? data.response.trim().toLowerCase() : null;

  } catch (err) {
    if (err.name === 'AbortError') {
      recordTimeout();
      console.log(`[Ollama] Timeout after ${TIMEOUT_MS}ms for: "${query}"`);
    } else {
      console.error(`[Ollama] Error: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── MAIN CALL ────────────────────────────────────────────

async function callOllama(query) {
  const normalisedQuery = normalise(query);

  // check cache first
  const cached = cache.get(normalisedQuery);
  if (cached) return cached;

  // pending dedup — same query already in flight → wait
  if (pending[normalisedQuery]) {
    console.log(`[Ollama] Deduped: "${query}" — waiting on pending`);
    return await pending[normalisedQuery];
  }

  // check budget
  if (!canRequest()) {
    recordSkip();
    console.log(`[Ollama] Skipped — budget exhausted`);
    return null;
  }

  acquire();
  console.log(`[Ollama] Calling for: "${query}"`);

  pending[normalisedQuery] = callWithTimeout(normalisedQuery)
    .then(result => {
      const cleaned = result ? normalise(result.trim().toLowerCase()) : null;

      if (isValidCorrection(normalisedQuery, cleaned)) {
        cache.set(normalisedQuery, cleaned);
        return cleaned;
      }

      return null;
    })
    .finally(() => {
      delete pending[normalisedQuery];
      release();
    });

  return await pending[normalisedQuery];
}

module.exports = { callOllama };























// const fetch = require('node-fetch');
// const {
//   canRequest,
//   acquire,
//   release,
//   recordSkip,
//   recordTimeout,
//   TIMEOUT_MS
// } = require('./budgetManager');
// const cache = require('./cache');
// const { normalise } = require('../query/normalise');

// const OLLAMA_URL = 'http://localhost:11434/api/generate';
// const OLLAMA_MODEL = 'llama3:latest';

// // Object.create(null) — no prototype pollution
// // user queries become keys — must be safe
// const pending = Object.create(null);

// // ─── VALIDATE CORRECTION ─────────────────────────────────
// // validates Ollama output before caching or sharing
// // prevents null/garbage being shared to deduped callers

// function isValidCorrection(input, output) {
//   if (!output) return false;
//   if (output.length < 2) return false;
//   if (output.length > 100) return false;
//   if (output.includes('\n')) return false;
//   if (output === input) return false;
//   if (/^\d+$/.test(output)) return false;
//   return true;
// }

// // ─── CALL WITH TIMEOUT ────────────────────────────────────

// async function callWithTimeout(query) {
//   const controller = new AbortController();
//   const timer = setTimeout(() => {
//     controller.abort();
//   }, TIMEOUT_MS);

//   try {
//     const response = await fetch(OLLAMA_URL, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({
//         model: OLLAMA_MODEL,
//         system: 'You are a spell checker for an Indian ecommerce search engine selling clothing, footwear, electronics, mobiles, laptops, appliances, furniture, home decor, kitchen, groceries, beauty, health, sports, toys, books, stationery, accessories, bags and jewellery. Fix ONLY spelling typos. Rules: (1) output ONLY the corrected search term (2) no explanations, no punctuation, lowercase only (3) keep the same number of words as input (4) corrected word must be similar length to original word - do not shorten drastically (5) fix spelling only - do not change meaning or substitute different words (6) if unsure output the input unchanged.',
//         prompt: `Fix typos: ${query}`,
//         stream: false
//       }),
//       signal: controller.signal
//     });

//     const data = await response.json();
//     return data.response ? data.response.trim().toLowerCase() : null;

//   } catch (err) {
//     if (err.name === 'AbortError') {
//       recordTimeout();
//       console.log(`[Ollama] Timeout after ${TIMEOUT_MS}ms for: "${query}"`);
//     } else {
//       console.error(`[Ollama] Error: ${err.message}`);
//     }
//     return null;
//   } finally {
//     clearTimeout(timer);
//   }
// }

// // ─── MAIN CALL ────────────────────────────────────────────

// async function callOllama(query) {
//   // normalise key for consistent lookup
//   const normalisedQuery = normalise(query);

//   // check cache first
//   const cached = cache.get(normalisedQuery);
//   if (cached) return cached;

//   // pending promise dedup
//   // if same query already in flight → wait for it
//   if (pending[normalisedQuery]) {
//     console.log(`[Ollama] Deduped: "${query}" — waiting on pending request`);
//     return await pending[normalisedQuery];
//   }

//   // check budget
//   if (!canRequest()) {
//     recordSkip();
//     console.log(`[Ollama] Skipped — budget exhausted`);
//     return null;
//   }

//   acquire();
//   console.log(`[Ollama] Calling for: "${query}"`);

//   // register pending promise
//   // other requests for same query wait on this
//   pending[normalisedQuery] = callWithTimeout(normalisedQuery)
//     .then(result => {
//       // normalise AI output — handles "Kurta " or "kurta." cases
//       const cleaned = result ? normalise(result.trim().toLowerCase()) : null;

//       // validate before caching or sharing to deduped callers
//       if (isValidCorrection(normalisedQuery, cleaned)) {
//         cache.set(normalisedQuery, cleaned);
//         return cleaned;
//       }

//       return null;
//     })
//     .finally(() => {
//       // always cleanup pending + release slot
//       delete pending[normalisedQuery];
//       release();
//     });

//   return await pending[normalisedQuery];
// }

// module.exports = { callOllama };